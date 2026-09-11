import { Node, Project, PropertyAccessExpression, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';

export interface CodemodResult {
  filesModified: string[];
  timeoutsFixed: number;
  fullTitlesFixed: number;
  requiresFixed: number;
  mochaHooksFixed: number;
  globalsNormalized: number;
  runnerSkipsFixed: number;
  sinonMigrated: number;
  chaiMigrated: number;
  guardrailViolations: string[];
}

export function isAllowedTestPath(filePath: string): boolean {
  const isTest =
    filePath.includes('/test/') ||
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.spec.ts');
  const isTestConfig =
    filePath.endsWith('setup.ts') ||
    filePath.includes('/testing/') ||
    filePath.endsWith('vitest.config.mjs');
  return isTest || isTestConfig;
}

export interface ExpectChainResult {
  expectCall: Node;
  target: string;
  chain: string[];
  isNegated: boolean;
  isDeep: boolean;
  isEventually: boolean;
  lastWord: string;
}

export function unwrapExpectChain(node: Node): ExpectChainResult | null {
  let curr: Node | undefined = node;
  const chain: string[] = [];

  while (curr && curr.getKind() === SyntaxKind.PropertyAccessExpression) {
    const pa: PropertyAccessExpression = curr.asKind(SyntaxKind.PropertyAccessExpression)!;
    chain.unshift(pa.getName());
    curr = pa.getExpression();
  }

  if (curr && curr.getKind() === SyntaxKind.CallExpression) {
    const call = curr.asKind(SyntaxKind.CallExpression)!;
    const expr = call.getExpression();
    if (expr.getText() === 'expect') {
      const target = call.getArguments().map(a => a.getText()).join(', ');
      const isNegated = chain.includes('not');
      const isDeep = chain.includes('deep');
      const isEventually = chain.includes('eventually');
      const lastWord = chain[chain.length - 1];
      return {
        expectCall: call,
        target,
        chain,
        isNegated,
        isDeep,
        isEventually,
        lastWord
      };
    }
  }

  return null;
}

export function parseExpectChaiChain(
  chainText: string
): { target: string; isNegated: boolean } | null {
  const match = chainText.match(
    /^expect\(([\s\S]+)\)\s*\.\s*([a-zA-Z\.\s]+)$/
  );
  if (!match) return null;
  const target = match[1].trim();
  const words = match[2]
    .split(/\s*\.\s*/)
    .map(w => w.trim())
    .filter(Boolean);
  const allowedWords = new Set([
    'to',
    'has',
    'have',
    'is',
    'be',
    'been',
    'not',
    'deep',
    'eventually'
  ]);
  if (!words.every(w => allowedWords.has(w))) return null;
  const isNegated = words.includes('not');
  return { target, isNegated };
}

export function applyCodemods(packagePath: string): CodemodResult {
  const tsConfigPath = path.join(packagePath, 'tsconfig.json');
  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsConfigPath) ? tsConfigPath : undefined,
    skipAddingFilesFromTsConfig: false
  });

  project.addSourceFilesAtPaths([
    path.join(packagePath, 'test/**/*.ts'),
    path.join(packagePath, 'src/**/*.test.ts')
  ]);

  const result: CodemodResult = {
    filesModified: [],
    timeoutsFixed: 0,
    fullTitlesFixed: 0,
    requiresFixed: 0,
    mochaHooksFixed: 0,
    globalsNormalized: 0,
    runnerSkipsFixed: 0,
    sinonMigrated: 0,
    chaiMigrated: 0,
    guardrailViolations: []
  };

  for (const sourceFile of project.getSourceFiles()) {
    let fileChanged = false;
    const filePath = sourceFile.getFilePath();
    if (
      filePath.includes('/dist/') ||
      filePath.includes('/node_modules/') ||
      filePath.endsWith('.d.ts')
    ) {
      continue;
    }

    // GUARDRAIL 1: Strict Test-Only Scope
    // Reject any file not explicitly a test or test-support file.
    if (!isAllowedTestPath(filePath)) {
      continue;
    }

    // GUARDRAIL 2: Assertion Equivalence Pre-Check
    // Snapshot the count of expect assertions prior to transformations
    const expectCallsBefore = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(call => {
        const text = call.getExpression().getText();
        return text === 'expect' || text.startsWith('expect(');
      }).length;

    // 1. Fix Mocha this.test.fullTitle() in test files
    const fullTitleCalls = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(call => {
        const text = call.getExpression().getText();
        return text === 'this.test.fullTitle';
      });

    for (const call of fullTitleCalls) {
      call.replaceWithText(`(this?.test?.fullTitle() ?? 'test-transaction')`);
      result.fullTitlesFixed++;
      fileChanged = true;
    }

    // 2. Convert legacy Mocha hooks (before -> beforeAll, after -> afterAll, context -> describe)
    const hookCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of hookCalls) {
      const expr = call.getExpression();
      const exprName = expr.getText();
      if (exprName === 'before') {
        expr.replaceWithText('beforeAll');
        result.mochaHooksFixed++;
        fileChanged = true;
      } else if (exprName === 'after') {
        expr.replaceWithText('afterAll');
        result.mochaHooksFixed++;
        fileChanged = true;
      } else if (exprName === 'context') {
        expr.replaceWithText('describe');
        result.mochaHooksFixed++;
        fileChanged = true;
      }
    }

    // 3. Fix CJS require() in test files
    const varStatements = sourceFile.getVariableStatements();
    for (const stmt of varStatements) {
      const decls = stmt.getDeclarations();
      for (const decl of decls) {
        const init = decl.getInitializer();
        if (init && init.getKind() === SyntaxKind.CallExpression) {
          const call = init.asKind(SyntaxKind.CallExpression)!;
          if (call.getExpression().getText() === 'require') {
            const args = call.getArguments();
            if (
              args.length > 0 &&
              args[0].getKind() === SyntaxKind.StringLiteral
            ) {
              const importPath = args[0]
                .asKind(SyntaxKind.StringLiteral)!
                .getLiteralValue();
              const varName = decl.getName();

              stmt.remove();
              sourceFile.addImportDeclaration({
                defaultImport: varName,
                moduleSpecifier: importPath
              });

              result.requiresFixed++;
              fileChanged = true;
              break;
            }
          }
        }
      }
    }

    // 4. Fix global namespace shadowing ('import * as global from ...')
    const importDecls = sourceFile.getImportDeclarations();
    for (const importDecl of importDecls) {
      const namespaceImport = importDecl.getNamespaceImport();
      if (namespaceImport && namespaceImport.getText() === 'global') {
        const moduleSpecifier = importDecl.getModuleSpecifierValue();
        importDecl.remove();
        sourceFile.addImportDeclaration({
          namedImports: ['getGlobal'],
          moduleSpecifier
        });

        const calls = sourceFile.getDescendantsOfKind(
          SyntaxKind.CallExpression
        );
        for (const call of calls) {
          if (call.getExpression().getText() === 'global.getGlobal') {
            call.getExpression().replaceWithText('getGlobal');
          }
        }
        fileChanged = true;
      }
    }

    // 5. Remove risky process.env stubbing in test hooks
    const envCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of envCalls) {
      const text = call.getText();
      if (
        text.includes("stub(process, 'env').value(undefined)") ||
        text.includes('stub(process, "env").value(undefined)')
      ) {
        const parentStmt = call.getFirstAncestorByKind(
          SyntaxKind.ExpressionStatement
        );
        if (parentStmt) {
          parentStmt.remove();
          fileChanged = true;
        }
      }
    }

    // 6. Replace Node-specific 'global' with standard 'globalThis' in test files
    const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
    for (const id of identifiers) {
      if (id.getText() !== 'global') continue;
      const parent = id.getParent();
      if (!parent) continue;

      if (parent.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = parent.asKind(SyntaxKind.PropertyAccessExpression)!;
        if (propAccess.getNameNode() === id) {
          continue;
        }
      }
      if (parent.getKind() === SyntaxKind.PropertyAssignment) {
        const propAssign = parent.asKind(SyntaxKind.PropertyAssignment)!;
        if (propAssign.getNameNode() === id) {
          continue;
        }
      }
      if (
        parent.getKind() === SyntaxKind.ModuleDeclaration ||
        parent.getKind() === SyntaxKind.VariableDeclaration ||
        parent.getKind() === SyntaxKind.Parameter ||
        parent.getKind() === SyntaxKind.BindingElement ||
        parent.getKind() === SyntaxKind.ImportSpecifier ||
        parent.getKind() === SyntaxKind.ExportSpecifier ||
        parent.getKind() === SyntaxKind.TypeReference
      ) {
        continue;
      }

      id.replaceWithText('globalThis');
      result.globalsNormalized++;
      fileChanged = true;
    }

    // 7. Rewrite legacy Mocha environment skips to Vitest conditional runners
    const describeCalls = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(call => {
        const exprText = call.getExpression().getText();
        return exprText === 'describe' || exprText === 'describe.only';
      });

    for (const describeCall of describeCalls) {
      const args = describeCall.getArguments();
      if (args.length < 2) continue;
      const callback = args[1];
      const body =
        callback.asKind(SyntaxKind.ArrowFunction)?.getBody() ||
        callback.asKind(SyntaxKind.FunctionExpression)?.getBody();
      if (body && body.getKind() === SyntaxKind.Block) {
        const block = body.asKind(SyntaxKind.Block)!;
        const firstStmt = block.getStatements()[0];
        if (firstStmt && firstStmt.getKind() === SyntaxKind.IfStatement) {
          const ifStmt = firstStmt.asKind(SyntaxKind.IfStatement)!;
          const thenStmt = ifStmt.getThenStatement();
          const isReturn =
            thenStmt.getKind() === SyntaxKind.ReturnStatement ||
            (thenStmt.getKind() === SyntaxKind.Block &&
              thenStmt
                .asKind(SyntaxKind.Block)!
                .getStatements()
                .some(s => s.getKind() === SyntaxKind.ReturnStatement));
          if (isReturn) {
            const condText = ifStmt.getExpression().getText();
            ifStmt.remove();
            describeCall
              .getExpression()
              .replaceWithText(
                `// eslint-disable-next-line no-restricted-properties\n(${condText} ? describe.skip : describe)`
              );
            result.runnerSkipsFixed++;
            fileChanged = true;
          }
        }
      }
    }

    const itCalls = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(call => {
        const exprText = call.getExpression().getText();
        return exprText === 'it' || exprText === 'it.only';
      });

    for (const itCall of itCalls) {
      const args = itCall.getArguments();
      if (args.length < 2) continue;
      const callback = args[1];
      const body =
        callback.asKind(SyntaxKind.FunctionExpression)?.getBody() ||
        callback.asKind(SyntaxKind.ArrowFunction)?.getBody();
      if (body && body.getKind() === SyntaxKind.Block) {
        const block = body.asKind(SyntaxKind.Block)!;
        const firstStmt = block.getStatements()[0];
        if (firstStmt && firstStmt.getKind() === SyntaxKind.IfStatement) {
          const ifStmt = firstStmt.asKind(SyntaxKind.IfStatement)!;
          const hasThisSkip = ifStmt.getText().includes('this.skip()');
          if (hasThisSkip) {
            const condText = ifStmt.getExpression().getText();
            let runnerExpr = '';
            if (condText.startsWith('!')) {
              const positiveCond = condText
                .slice(1)
                .trim()
                .replace(/^\((.*)\)$/, '$1');
              runnerExpr = `(${positiveCond} ? it : it.skip)`;
            } else {
              runnerExpr = `(${condText} ? it.skip : it)`;
            }
            ifStmt.remove();
            itCall
              .getExpression()
              .replaceWithText(
                `// eslint-disable-next-line no-restricted-properties\n${runnerExpr}`
              );
            result.runnerSkipsFixed++;
            fileChanged = true;
          }
        }
      }
    }

    // 8. Sinon -> Vitest Transformations
    let needsViImport = false;
    let needsMockInstanceImport = false;

    // 8a. Remove sinon & sinon-chai imports
    const sinonImports = sourceFile.getImportDeclarations().filter(decl => {
      const mod = decl.getModuleSpecifierValue();
      return mod === 'sinon' || mod === 'sinon-chai';
    });

    for (const decl of sinonImports) {
      if (decl.wasForgotten()) continue;
      const mod = decl.getModuleSpecifierValue();
      if (mod === 'sinon-chai') {
        decl.remove();
        fileChanged = true;
        result.sinonMigrated++;
      } else if (mod === 'sinon') {
        const named = decl.getNamedImports().map(ni => ni.getName());
        if (named.some(n => n === 'SinonSpy' || n === 'SinonStub')) {
          needsMockInstanceImport = true;
        }
        decl.remove();
        needsViImport = true;
        fileChanged = true;
        result.sinonMigrated++;
      }
    }

    // 8b. Remove chai.use(sinonChai) or use(sinonChai)
    const chaiCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of chaiCalls) {
      const text = call.getText();
      if (text === 'use(sinonChai)' || text === 'chai.use(sinonChai)') {
        const stmt = call.getFirstAncestorByKind(
          SyntaxKind.ExpressionStatement
        );
        if (stmt) {
          stmt.remove();
          fileChanged = true;
          result.sinonMigrated++;
        }
      }
    }

    // 8c.1 Remove .callThrough() chaining (vi.spyOn already calls through by default)
    const callThroughCalls = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(call => {
        const expr = call.getExpression();
        return (
          expr.getKind() === SyntaxKind.PropertyAccessExpression &&
          expr.asKind(SyntaxKind.PropertyAccessExpression)!.getName() === 'callThrough'
        );
      });
    for (const call of callThroughCalls) {
      if (call.wasForgotten()) continue;
      const propAccess = call.getExpression().asKind(SyntaxKind.PropertyAccessExpression)!;
      const innerExpr = propAccess.getExpression().getText();
      call.replaceWithText(innerExpr);
      fileChanged = true;
      result.sinonMigrated++;
    }

    // 8c.2 Convert restore() and sinon.restore() to vi.restoreAllMocks()
    const restoreCalls = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(call => {
        const text = call.getExpression().getText();
        return text === 'restore' || text === 'sinon.restore';
      });

    for (const call of restoreCalls) {
      if (call.wasForgotten()) continue;
      call.replaceWithText('vi.restoreAllMocks()');
      needsViImport = true;
      fileChanged = true;
      result.sinonMigrated++;
    }

    // 8d. Convert spy(...) / Spy(...) / sinon.spy(...) / stub(...) / sinon.stub(...) / fake(...) / sinon.fake(...)
    const spyStubCalls = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(call => {
        const text = call.getExpression().getText();
        return (
          text === 'spy' ||
          text === 'Spy' ||
          text === 'sinon.spy' ||
          text === 'stub' ||
          text === 'sinon.stub' ||
          text === 'fake' ||
          text === 'sinon.fake'
        );
      });

    for (const call of spyStubCalls) {
      if (call.wasForgotten()) continue;
      const args = call.getArguments();
      if (args.length >= 2) {
        call.getExpression().replaceWithText('vi.spyOn');
        needsViImport = true;
        fileChanged = true;
        result.sinonMigrated++;
      } else {
        call.getExpression().replaceWithText('vi.fn');
        needsViImport = true;
        fileChanged = true;
        result.sinonMigrated++;
      }
    }

    // 8d.1 Convert match.any -> expect.anything()
    const matchAnyProps = sourceFile
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .filter(prop => {
        const text = prop.getText();
        return text === 'match.any' || text === 'sinon.match.any';
      });
    for (const prop of matchAnyProps) {
      if (prop.wasForgotten()) continue;
      prop.replaceWithText('expect.anything()');
      fileChanged = true;
      result.sinonMigrated++;
    }

    // 8e. Convert spy instance methods: .resetHistory() -> .mockClear(), .restore() -> .mockRestore()
    const methodCalls = sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression
    );
    for (const call of methodCalls) {
      if (call.wasForgotten()) continue;
      const expr = call.getExpression();
      if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expr.asKind(SyntaxKind.PropertyAccessExpression)!;
        if (propAccess.wasForgotten()) continue;
        const methodName = propAccess.getName();
        const objText = propAccess.getExpression().getText();
        if (methodName === 'resetHistory') {
          propAccess.getNameNode().replaceWithText('mockClear');
          fileChanged = true;
          result.sinonMigrated++;
        } else if (
          methodName === 'restore' &&
          objText !== 'sinon' &&
          objText !== 'clock'
        ) {
          propAccess.getNameNode().replaceWithText('mockRestore');
          fileChanged = true;
          result.sinonMigrated++;
        } else if (methodName === 'resolves' && !objText.startsWith('expect(')) {
          propAccess.getNameNode().replaceWithText('mockResolvedValue');
          fileChanged = true;
          result.sinonMigrated++;
        } else if (methodName === 'rejects' && !objText.startsWith('expect(')) {
          propAccess.getNameNode().replaceWithText('mockRejectedValue');
          fileChanged = true;
          result.sinonMigrated++;
        } else if (methodName === 'returns') {
          propAccess.getNameNode().replaceWithText('mockReturnValue');
          fileChanged = true;
          result.sinonMigrated++;
        } else if (methodName === 'callsFake') {
          propAccess.getNameNode().replaceWithText('mockImplementation');
          fileChanged = true;
          result.sinonMigrated++;
        } else if (methodName === 'reset' || methodName === 'resetBehavior') {
          propAccess.getNameNode().replaceWithText('mockReset');
          fileChanged = true;
          result.sinonMigrated++;
        }
      }
    }

    // 8f. Convert type references: SinonSpy / SinonStub -> MockInstance
    const typeRefs = sourceFile.getDescendantsOfKind(
      SyntaxKind.TypeReference
    );
    for (const typeRef of typeRefs) {
      if (typeRef.wasForgotten()) continue;
      const typeName = typeRef.getTypeName().getText();
      if (
        typeName === 'SinonSpy' ||
        typeName === 'SinonStub' ||
        typeName === 'sinon.SinonSpy' ||
        typeName === 'sinon.SinonStub'
      ) {
        typeRef.replaceWithText('MockInstance');
        needsMockInstanceImport = true;
        fileChanged = true;
        result.sinonMigrated++;
      }
    }

    // 8f.2 Convert Sinon spy call inspect properties:
    // firstCall.args -> mock.calls[0], secondCall.args -> mock.calls[1], etc.
    const argsProps = sourceFile.getDescendantsOfKind(
      SyntaxKind.PropertyAccessExpression
    );
    for (const prop of argsProps) {
      if (prop.wasForgotten()) continue;
      if (prop.getName() === 'args') {
        const expr = prop.getExpression();
        if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
          const pa: PropertyAccessExpression = expr.asKind(SyntaxKind.PropertyAccessExpression)!;
          const callName = pa.getName();
          const target = pa.getExpression().getText();
          if (callName === 'firstCall') {
            prop.replaceWithText(`${target}.mock.calls[0]`);
            fileChanged = true;
            result.sinonMigrated++;
          } else if (callName === 'secondCall') {
            prop.replaceWithText(`${target}.mock.calls[1]`);
            fileChanged = true;
            result.sinonMigrated++;
          } else if (callName === 'thirdCall') {
            prop.replaceWithText(`${target}.mock.calls[2]`);
            fileChanged = true;
            result.sinonMigrated++;
          } else if (callName === 'lastCall') {
            prop.replaceWithText(`${target}.mock.calls[${target}.mock.calls.length - 1]`);
            fileChanged = true;
            result.sinonMigrated++;
          }
        }
      }
    }

    // 8f.3 Convert expect(stub.callCount).toBe(N) or expect(stub.callCount).toEqual(N)
    const callCountAssertions = sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression
    );
    for (const call of callCountAssertions) {
      if (call.wasForgotten()) continue;
      const exprText = call.getExpression().getText();
      if (exprText.endsWith('.toBe') || exprText.endsWith('.toEqual')) {
        const parentExpect = call
          .getExpression()
          .asKind(SyntaxKind.PropertyAccessExpression)
          ?.getExpression();
        if (parentExpect && parentExpect.getKind() === SyntaxKind.CallExpression) {
          const expectCall = parentExpect.asKind(SyntaxKind.CallExpression)!;
          const arg = expectCall.getArguments()[0];
          if (arg && arg.getKind() === SyntaxKind.PropertyAccessExpression) {
            const pa: PropertyAccessExpression = arg.asKind(SyntaxKind.PropertyAccessExpression)!;
            const propName = pa.getName();
            const target = pa.getExpression().getText();
            if (propName === 'callCount') {
              const countArg = call.getArguments().map(a => a.getText()).join(', ');
              call.replaceWithText(`expect(${target}).toHaveBeenCalledTimes(${countArg})`);
              fileChanged = true;
              result.sinonMigrated++;
            } else if (propName === 'calledOnce') {
              call.replaceWithText(`expect(${target}).toHaveBeenCalledTimes(1)`);
              fileChanged = true;
              result.sinonMigrated++;
            } else if (propName === 'calledTwice') {
              call.replaceWithText(`expect(${target}).toHaveBeenCalledTimes(2)`);
              fileChanged = true;
              result.sinonMigrated++;
            } else if (propName === 'calledThrice') {
              call.replaceWithText(`expect(${target}).toHaveBeenCalledTimes(3)`);
              fileChanged = true;
              result.sinonMigrated++;
            } else if (propName === 'called') {
              const val = call.getArguments()[0]?.getText();
              if (val === 'false') {
                call.replaceWithText(`expect(${target}).not.toHaveBeenCalled()`);
              } else {
                call.replaceWithText(`expect(${target}).toHaveBeenCalled()`);
              }
              fileChanged = true;
              result.sinonMigrated++;
            } else if (propName === 'notCalled') {
              call.replaceWithText(`expect(${target}).not.toHaveBeenCalled()`);
              fileChanged = true;
              result.sinonMigrated++;
            }
          }
        }
      }
    }

    // 8f.4 Convert vi.spyOn(obj, prop).value(val) getter mocking
    const spyOnValueCalls = sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression
    );
    for (const call of spyOnValueCalls) {
      if (call.wasForgotten()) continue;
      const expr = call.getExpression();
      if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
        const pa: PropertyAccessExpression = expr.asKind(SyntaxKind.PropertyAccessExpression)!;
        if (pa.getName() === 'value') {
          const innerCall = pa.getExpression();
          if (innerCall.getKind() === SyntaxKind.CallExpression) {
            const ic = innerCall.asKind(SyntaxKind.CallExpression)!;
            if (ic.getExpression().getText() === 'vi.spyOn') {
              const args = ic.getArguments().map(a => a.getText());
              const valArg = call.getArguments().map(a => a.getText()).join(', ');
              call.replaceWithText(`vi.spyOn(${args[0]}, ${args[1]}, 'get').mockReturnValue(${valArg})`);
              fileChanged = true;
              result.sinonMigrated++;
            }
          }
        }
      }
    }

    // 8f.5 Convert remaining stub.callCount to stub.mock.calls.length
    const callCountProps = sourceFile.getDescendantsOfKind(
      SyntaxKind.PropertyAccessExpression
    );
    for (const prop of callCountProps) {
      if (prop.wasForgotten()) continue;
      if (prop.getName() === 'callCount') {
        const target = prop.getExpression().getText();
        prop.replaceWithText(`(${target}.mock.calls.length)`);
        fileChanged = true;
        result.sinonMigrated++;
      }
    }

    // 8f.6 Convert Chai assert.* calls to native expect matchers
    const assertCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of assertCalls) {
      if (call.wasForgotten()) continue;
      const expr = call.getExpression();
      if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
        const pa = expr.asKind(SyntaxKind.PropertyAccessExpression)!;
        if (pa.getExpression().getText() === 'assert') {
          const methodName = pa.getName();
          const args = call.getArguments();
          if (args.length >= 1) {
            const actual = args[0].getText();
            const expected = args.length >= 2 ? args[1].getText() : '';
            if (methodName === 'equal' || methodName === 'strictEqual') {
              call.replaceWithText(`expect(${actual}).toBe(${expected})`);
              fileChanged = true;
              result.chaiMigrated++;
            } else if (methodName === 'notEqual' || methodName === 'notStrictEqual') {
              call.replaceWithText(`expect(${actual}).not.toBe(${expected})`);
              fileChanged = true;
              result.chaiMigrated++;
            } else if (methodName === 'deepEqual') {
              call.replaceWithText(`expect(${actual}).toEqual(${expected})`);
              fileChanged = true;
              result.chaiMigrated++;
            } else if (methodName === 'notDeepEqual') {
              call.replaceWithText(`expect(${actual}).not.toEqual(${expected})`);
              fileChanged = true;
              result.chaiMigrated++;
            } else if (methodName === 'isTrue') {
              call.replaceWithText(`expect(${actual}).toBe(true)`);
              fileChanged = true;
              result.chaiMigrated++;
            } else if (methodName === 'isFalse') {
              call.replaceWithText(`expect(${actual}).toBe(false)`);
              fileChanged = true;
              result.chaiMigrated++;
            } else if (methodName === 'isNull') {
              call.replaceWithText(`expect(${actual}).toBeNull()`);
              fileChanged = true;
              result.chaiMigrated++;
            } else if (methodName === 'isNotNull') {
              call.replaceWithText(`expect(${actual}).not.toBeNull()`);
              fileChanged = true;
              result.chaiMigrated++;
            } else if (methodName === 'isUndefined') {
              call.replaceWithText(`expect(${actual}).toBeUndefined()`);
              fileChanged = true;
              result.chaiMigrated++;
            } else if (methodName === 'isDefined' || methodName === 'exists') {
              call.replaceWithText(`expect(${actual}).toBeDefined()`);
              fileChanged = true;
              result.chaiMigrated++;
            } else if (methodName === 'throws') {
              call.replaceWithText(`expect(${actual}).toThrow(${expected})`);
              fileChanged = true;
              result.chaiMigrated++;
            }
          }
        }
      }
    }

    // 8f.1 Convert Chai and Sinon-Chai mock assertions on expect(...) to native Vitest matchers
    // 1. Method calls
    const expectCallExprs = sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression
    );
    for (const call of expectCallExprs) {
      if (call.wasForgotten()) continue;
      const res = unwrapExpectChain(call.getExpression());
      if (!res) continue;
      const { target, isNegated, isDeep, isEventually, lastWord } = res;
      const argsText = call
        .getArguments()
        .map(a => a.getText())
        .join(', ');

      const prefix = isEventually
        ? `expect(${target}).resolves.${isNegated ? 'not.' : ''}`
        : `expect(${target}).${isNegated ? 'not.' : ''}`;

      let replacement: string | null = null;
      if (['equal', 'equals', 'eq'].includes(lastWord)) {
        replacement = isDeep ? `${prefix}toEqual(${argsText})` : `${prefix}toBe(${argsText})`;
      } else if (['eql', 'eqls'].includes(lastWord)) {
        replacement = `${prefix}toEqual(${argsText})`;
      } else if (['throw', 'throws'].includes(lastWord)) {
        replacement = `${prefix}toThrow(${argsText})`;
      } else if (['rejectedWith', 'rejected'].includes(lastWord)) {
        replacement = `expect(${target}).rejects.${isNegated ? 'not.' : ''}toThrow(${argsText})`;
      } else if (['instanceof', 'instanceOf'].includes(lastWord)) {
        replacement = `${prefix}toBeInstanceOf(${argsText})`;
      } else if (['include', 'includes', 'contain', 'contains'].includes(lastWord)) {
        replacement = `${prefix}toContain(${argsText})`;
      } else if (['length', 'lengthOf'].includes(lastWord)) {
        replacement = `${prefix}toHaveLength(${argsText})`;
      } else if (['above', 'greaterThan'].includes(lastWord)) {
        replacement = `${prefix}toBeGreaterThan(${argsText})`;
      } else if (['below', 'lessThan'].includes(lastWord)) {
        replacement = `${prefix}toBeLessThan(${argsText})`;
      } else if (['least', 'greaterThanOrEqual'].includes(lastWord)) {
        replacement = `${prefix}toBeGreaterThanOrEqual(${argsText})`;
      } else if (['most', 'lessThanOrEqual'].includes(lastWord)) {
        replacement = `${prefix}toBeLessThanOrEqual(${argsText})`;
      } else if (['closeTo'].includes(lastWord)) {
        replacement = `${prefix}toBeCloseTo(${argsText})`;
      } else if (['match', 'matches'].includes(lastWord)) {
        replacement = `${prefix}toMatch(${argsText})`;
      } else if (['property', 'haveOwnProperty'].includes(lastWord)) {
        replacement = `${prefix}toHaveProperty(${argsText})`;
      } else if (lastWord === 'calledWith') {
        replacement = `${prefix}toHaveBeenCalledWith(${argsText})`;
      } else if (lastWord === 'calledOnceWith') {
        replacement = `${prefix}toHaveBeenCalledExactlyOnceWith(${argsText})`;
      } else if (lastWord === 'lastCalledWith') {
        replacement = `${prefix}toHaveBeenLastCalledWith(${argsText})`;
      } else if (lastWord === 'nthCalledWith') {
        replacement = `${prefix}toHaveBeenNthCalledWith(${argsText})`;
      }

      if (replacement) {
        call.replaceWithText(replacement);
        fileChanged = true;
        result.chaiMigrated++;
        if (lastWord.startsWith('called')) {
          result.sinonMigrated++;
        }
      }
    }

    // 2. Property access assertions: .undefined, .null, .true, .false, .exist, .empty, .calledOnce, etc.
    const expectPropAccesses = sourceFile.getDescendantsOfKind(
      SyntaxKind.PropertyAccessExpression
    );
    for (const prop of expectPropAccesses) {
      if (prop.wasForgotten()) continue;
      const parentKind = prop.getParent()?.getKind();
      if (
        parentKind === SyntaxKind.PropertyAccessExpression ||
        parentKind === SyntaxKind.CallExpression
      ) {
        continue;
      }
      const res = unwrapExpectChain(prop);
      if (!res) continue;
      const { target, isNegated, lastWord } = res;
      const prefix = isNegated ? `expect(${target}).not.` : `expect(${target}).`;

      let replacement: string | null = null;
      if (lastWord === 'undefined') {
        replacement = isNegated ? `expect(${target}).toBeDefined()` : `expect(${target}).toBeUndefined()`;
      } else if (lastWord === 'null') {
        replacement = `${prefix}toBeNull()`;
      } else if (lastWord === 'true') {
        replacement = `${prefix}toBe(true)`;
      } else if (lastWord === 'false') {
        replacement = `${prefix}toBe(false)`;
      } else if (lastWord === 'exist' || lastWord === 'exists') {
        replacement = isNegated ? `expect(${target}).toBeFalsy()` : `expect(${target}).toBeDefined()`;
      } else if (lastWord === 'empty') {
        replacement = `${prefix}toHaveLength(0)`;
      } else if (lastWord === 'NaN') {
        replacement = `${prefix}toBeNaN()`;
      } else if (lastWord === 'ok') {
        replacement = isNegated ? `expect(${target}).toBeFalsy()` : `expect(${target}).toBeTruthy()`;
      } else if (lastWord === 'calledOnce') {
        replacement = `${prefix}toHaveBeenCalledTimes(1)`;
      } else if (lastWord === 'calledTwice') {
        replacement = `${prefix}toHaveBeenCalledTimes(2)`;
      } else if (lastWord === 'calledThrice') {
        replacement = `${prefix}toHaveBeenCalledTimes(3)`;
      } else if (lastWord === 'called') {
        replacement = `${prefix}toHaveBeenCalled()`;
      }

      if (replacement) {
        prop.replaceWithText(replacement);
        fileChanged = true;
        result.chaiMigrated++;
        if (lastWord.startsWith('called')) {
          result.sinonMigrated++;
        }
      }
    }

    // 8g. Convert .called property on spies: x.called -> (x.mock.calls.length > 0)
    // Avoid touching expect(x).to.have.been.called or expect(x).to.not.have.been.called assertions
    const propAccesses = sourceFile.getDescendantsOfKind(
      SyntaxKind.PropertyAccessExpression
    );
    for (const prop of propAccesses) {
      if (prop.wasForgotten()) continue;
      if (prop.getName() === 'called') {
        const target = prop.getExpression().getText();
        if (target.includes('expect(') || target.endsWith('.been')) {
          continue;
        }
        prop.replaceWithText(`(${target}.mock.calls.length > 0)`);
        fileChanged = true;
        result.sinonMigrated++;
      }
    }

    // 8h. Convert all Chai imports (expect, assert, chai, use) to Vitest imports and clean unused
    const chaiImports = sourceFile.getImportDeclarations().filter(d => {
      return d.getModuleSpecifierValue() === 'chai';
    });
    for (const chaiDecl of chaiImports) {
      if (chaiDecl.wasForgotten()) continue;
      const defaultImport = chaiDecl.getDefaultImport();
      const namedImports = chaiDecl.getNamedImports();

      const hasChaiUsage = sourceFile.getText().includes('chai.');
      const hasUseUsage = sourceFile
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .some(c => c.getExpression().getText() === 'use' || c.getExpression().getText() === 'chai.use');

      if (defaultImport && defaultImport.getText() === 'chai') {
        if (!hasChaiUsage) {
          chaiDecl.remove();
          fileChanged = true;
          continue;
        }
        chaiDecl.removeDefaultImport();
        chaiDecl.addNamedImport('chai');
        chaiDecl.setModuleSpecifier('vitest');
        fileChanged = true;
        const hasAssertUsage = sourceFile
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .some(id => id.getText() === 'assert' && id.getParent()?.getKind() === SyntaxKind.PropertyAccessExpression);
        const remainingNamed = namedImports.filter(ni => {
          const name = ni.getName();
          if (name === 'use' && !hasUseUsage) return false;
          if (name === 'chai' && !hasChaiUsage) return false;
          if (name === 'assert' && !hasAssertUsage) return false;
          if (name === 'expect') return false;
          return true;
        });

        if (remainingNamed.length === 0) {
          chaiDecl.remove();
          fileChanged = true;
        } else {
          chaiDecl.setModuleSpecifier('vitest');
          fileChanged = true;
        }
      }
    }

    // 8i. Clean unused assert / expect imports from 'vitest'
    const vitestImports = sourceFile.getImportDeclarations().filter(d => {
      return d.getModuleSpecifierValue() === 'vitest';
    });
    for (const vDecl of vitestImports) {
      if (vDecl.wasForgotten()) continue;
      const namedImports = vDecl.getNamedImports();
      for (const ni of namedImports) {
        const name = ni.getName();
        if (name === 'assert') {
          const hasAssert = sourceFile
            .getDescendantsOfKind(SyntaxKind.Identifier)
            .some(id => id.getText() === 'assert' && id.getParent()?.getKind() === SyntaxKind.PropertyAccessExpression);
          if (!hasAssert) {
            ni.remove();
            fileChanged = true;
          }
        } else if (name === 'expect') {
          ni.remove();
          fileChanged = true;
        }
      }
      if (vDecl.getNamedImports().length === 0 && !vDecl.getDefaultImport()) {
        vDecl.remove();
        fileChanged = true;
      }
    }

    // 8j. Inject required Vitest imports
    if (needsViImport || needsMockInstanceImport) {
      const existingVitestImport = sourceFile
        .getImportDeclarations()
        .find(d => d.getModuleSpecifierValue() === 'vitest');
      const importsToAdd: string[] = [];
      if (needsViImport) importsToAdd.push('vi');
      if (needsMockInstanceImport) importsToAdd.push('MockInstance');

      if (existingVitestImport) {
        for (const imp of importsToAdd) {
          if (
            !existingVitestImport
              .getNamedImports()
              .some(ni => ni.getName() === imp)
          ) {
            existingVitestImport.addNamedImport(imp);
            fileChanged = true;
          }
        }
      } else {
        sourceFile.addImportDeclaration({
          namedImports: importsToAdd,
          moduleSpecifier: 'vitest'
        });
        fileChanged = true;
      }
    }

    // 8k. Deduplicate and merge multiple Vitest import declarations
    const remainingVitestImports = sourceFile
      .getImportDeclarations()
      .filter(d => d.getModuleSpecifierValue() === 'vitest');
    if (remainingVitestImports.length > 1) {
      const primary = remainingVitestImports[0];
      for (let i = 1; i < remainingVitestImports.length; i++) {
        const dup = remainingVitestImports[i];
        for (const ni of dup.getNamedImports()) {
          const name = ni.getName();
          if (!primary.getNamedImports().some(p => p.getName() === name)) {
            primary.addNamedImport(name);
          }
        }
        dup.remove();
        fileChanged = true;
      }
    }

    // GUARDRAIL 2: Assertion Equivalence Post-Check
    const expectCallsAfter = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(call => {
        const text = call.getExpression().getText();
        return text === 'expect' || text.startsWith('expect(');
      }).length;

    if (expectCallsAfter < expectCallsBefore) {
      const violation = `[Guardrail Violation] Assertion count decreased in ${filePath}: was ${expectCallsBefore}, now ${expectCallsAfter}. Transformations must not drop or weaken test assertions.`;
      result.guardrailViolations.push(violation);
      throw new Error(violation);
    }

    if (fileChanged) {
      sourceFile.saveSync();
      result.filesModified.push(filePath);
    }
  }

  return result;
}
