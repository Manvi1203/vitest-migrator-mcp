import { Project, SyntaxKind } from 'ts-morph';
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
    'not'
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
      const mod = decl.getModuleSpecifierValue();
      const leadingComments = decl.getLeadingCommentRanges();
      const commentText = leadingComments.map(c => c.getText()).join('\n');
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
      if (commentText && !sourceFile.getFullText().startsWith('/**')) {
        sourceFile.insertText(0, commentText + '\n\n');
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
        if (methodName === 'resetHistory') {
          propAccess.getNameNode().replaceWithText('mockClear');
          fileChanged = true;
          result.sinonMigrated++;
        } else if (
          methodName === 'restore' &&
          propAccess.getExpression().getText() !== 'sinon' &&
          propAccess.getExpression().getText() !== 'clock'
        ) {
          propAccess.getNameNode().replaceWithText('mockRestore');
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
      if (typeName === 'SinonSpy' || typeName === 'SinonStub') {
        typeRef.replaceWithText('MockInstance');
        needsMockInstanceImport = true;
        fileChanged = true;
        result.sinonMigrated++;
      }
    }

    // 8f.1 Convert legacy Sinon-Chai mock assertions on expect(...) to native Vitest matchers
    // 1. Method calls: .calledWith(...), .calledOnceWith(...), .lastCalledWith(...), .nthCalledWith(...)
    const chaiMockCallExprs = sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression
    );
    for (const call of chaiMockCallExprs) {
      if (call.wasForgotten()) continue;
      const expr = call.getExpression();
      if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expr.asKind(SyntaxKind.PropertyAccessExpression)!;
        const methodName = propAccess.getName();
        if (
          [
            'calledWith',
            'calledOnceWith',
            'lastCalledWith',
            'nthCalledWith'
          ].includes(methodName)
        ) {
          const callerChain = propAccess.getExpression().getText();
          const parsed = parseExpectChaiChain(callerChain);
          if (parsed) {
            const argsText = call
              .getArguments()
              .map(a => a.getText())
              .join(', ');
            let newMethod = 'toHaveBeenCalledWith';
            if (methodName === 'calledOnceWith')
              newMethod = 'toHaveBeenCalledExactlyOnceWith';
            if (methodName === 'lastCalledWith')
              newMethod = 'toHaveBeenLastCalledWith';
            if (methodName === 'nthCalledWith')
              newMethod = 'toHaveBeenNthCalledWith';
            const prefix = parsed.isNegated
              ? `expect(${parsed.target}).not.`
              : `expect(${parsed.target}).`;
            call.replaceWithText(`${prefix}${newMethod}(${argsText})`);
            fileChanged = true;
            result.sinonMigrated++;
          }
        }
      }
    }

    // 2. Property access assertions: .calledOnce, .calledTwice, .calledThrice, .called
    const chaiMockPropAccesses = sourceFile.getDescendantsOfKind(
      SyntaxKind.PropertyAccessExpression
    );
    for (const prop of chaiMockPropAccesses) {
      if (prop.wasForgotten()) continue;
      const propName = prop.getName();
      if (
        ['calledOnce', 'calledTwice', 'calledThrice', 'called'].includes(
          propName
        )
      ) {
        const callerChain = prop.getExpression().getText();
        const parsed = parseExpectChaiChain(callerChain);
        if (parsed) {
          const prefix = parsed.isNegated
            ? `expect(${parsed.target}).not.`
            : `expect(${parsed.target}).`;
          let replacement = '';
          if (propName === 'calledOnce') {
            replacement = `${prefix}toHaveBeenCalledTimes(1)`;
          } else if (propName === 'calledTwice') {
            replacement = `${prefix}toHaveBeenCalledTimes(2)`;
          } else if (propName === 'calledThrice') {
            replacement = `${prefix}toHaveBeenCalledTimes(3)`;
          } else if (propName === 'called') {
            replacement = `${prefix}toHaveBeenCalled()`;
          }
          prop.replaceWithText(replacement);
          fileChanged = true;
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

    // 8h. Convert all Chai imports (expect, assert, chai, use) to Vitest imports
    const chaiImports = sourceFile.getImportDeclarations().filter(d => {
      return d.getModuleSpecifierValue() === 'chai';
    });
    for (const chaiDecl of chaiImports) {
      if (chaiDecl.wasForgotten()) continue;
      const defaultImport = chaiDecl.getDefaultImport();
      const namedImports = chaiDecl.getNamedImports();

      if (defaultImport && defaultImport.getText() === 'chai') {
        chaiDecl.removeDefaultImport();
        chaiDecl.addNamedImport('chai');
        chaiDecl.setModuleSpecifier('vitest');
        fileChanged = true;
      } else if (namedImports.length > 0) {
        const useSpec = namedImports.find(ni => ni.getName() === 'use');
        if (useSpec) {
          useSpec.setName('chai');
          const useCalls = sourceFile
            .getDescendantsOfKind(SyntaxKind.CallExpression)
            .filter(c => c.getExpression().getText() === 'use');
          for (const uc of useCalls) {
            if (!uc.wasForgotten()) {
              uc.getExpression().replaceWithText('chai.use');
            }
          }
        }
        chaiDecl.setModuleSpecifier('vitest');
        fileChanged = true;
      }
    }

    // 8i. In test/setup.ts, register chaiAsPromised on Vitest chai if present
    if (filePath.endsWith('setup.ts')) {
      const content = sourceFile.getText();
      if (content.includes('chaiAsPromised') && !content.includes('chai.use(chaiAsPromised)')) {
        sourceFile.addStatements('chai.use(chaiAsPromised);');
        needsViImport = true;
        const vitestImport = sourceFile
          .getImportDeclarations()
          .find(d => d.getModuleSpecifierValue() === 'vitest');
        if (vitestImport) {
          if (!vitestImport.getNamedImports().some(ni => ni.getName() === 'chai')) {
            vitestImport.addNamedImport('chai');
          }
        } else {
          sourceFile.addImportDeclaration({
            namedImports: ['chai'],
            moduleSpecifier: 'vitest'
          });
        }
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
    const vitestImports = sourceFile
      .getImportDeclarations()
      .filter(d => d.getModuleSpecifierValue() === 'vitest');
    if (vitestImports.length > 1) {
      const primary = vitestImports[0];
      for (let i = 1; i < vitestImports.length; i++) {
        const dup = vitestImports[i];
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
