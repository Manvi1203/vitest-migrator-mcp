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
}

export function applyCodemods(packagePath: string): CodemodResult {
  const tsConfigPath = path.join(packagePath, 'tsconfig.json');
  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsConfigPath) ? tsConfigPath : undefined,
    skipAddingFilesFromTsConfig: false
  });

  if (!fs.existsSync(tsConfigPath)) {
    project.addSourceFilesAtPaths([
      path.join(packagePath, 'test/**/*.ts')
    ]);
  }

  const result: CodemodResult = {
    filesModified: [],
    timeoutsFixed: 0,
    fullTitlesFixed: 0,
    requiresFixed: 0,
    mochaHooksFixed: 0,
    globalsNormalized: 0,
    runnerSkipsFixed: 0
  };

  for (const sourceFile of project.getSourceFiles()) {
    let fileChanged = false;
    const filePath = sourceFile.getFilePath();
    if (filePath.includes('/dist/') || filePath.includes('/node_modules/') || filePath.endsWith('.d.ts')) {
      continue;
    }

    // STRICT TEST-ONLY SCOPE:
    // Codemods must strictly operate on test files only (test/**/*.ts, *.test.ts, *.spec.ts).
    // Under NO circumstances should production source code (src/), entry points (index.ts),
    // or production type definitions be modified by migration codemods.
    const isTestFile = filePath.includes('/test/') || filePath.endsWith('.test.ts') || filePath.endsWith('.spec.ts');
    if (!isTestFile) {
      continue;
    }

    // 1. Fix Mocha this.test.fullTitle() in test files
    const fullTitleCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
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
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of callExpressions) {
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
            if (args.length > 0 && args[0].getKind() === SyntaxKind.StringLiteral) {
              const importPath = args[0].asKind(SyntaxKind.StringLiteral)!.getLiteralValue();
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

        const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
        for (const call of calls) {
          if (call.getExpression().getText() === 'global.getGlobal') {
            call.getExpression().replaceWithText('getGlobal');
          }
        }
        fileChanged = true;
      }
    }

    // 5. Remove risky process.env stubbing in test hooks
    const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
      const text = call.getText();
      if (text.includes("stub(process, 'env').value(undefined)") ||
          text.includes('stub(process, "env").value(undefined)')) {
        const parentStmt = call.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
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
    const describeCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(call => {
        const exprText = call.getExpression().getText();
        return exprText === 'describe' || exprText === 'describe.only';
      });

    for (const describeCall of describeCalls) {
      const args = describeCall.getArguments();
      if (args.length < 2) continue;
      const callback = args[1];
      const body = callback.asKind(SyntaxKind.ArrowFunction)?.getBody() ||
        callback.asKind(SyntaxKind.FunctionExpression)?.getBody();
      if (body && body.getKind() === SyntaxKind.Block) {
        const block = body.asKind(SyntaxKind.Block)!;
        const firstStmt = block.getStatements()[0];
        if (firstStmt && firstStmt.getKind() === SyntaxKind.IfStatement) {
          const ifStmt = firstStmt.asKind(SyntaxKind.IfStatement)!;
          const thenStmt = ifStmt.getThenStatement();
          const isReturn = thenStmt.getKind() === SyntaxKind.ReturnStatement ||
            (thenStmt.getKind() === SyntaxKind.Block &&
              thenStmt.asKind(SyntaxKind.Block)!.getStatements().some(s => s.getKind() === SyntaxKind.ReturnStatement));
          if (isReturn) {
            const condText = ifStmt.getExpression().getText();
            ifStmt.remove();
            describeCall.getExpression().replaceWithText(`// eslint-disable-next-line no-restricted-properties\n(${condText} ? describe.skip : describe)`);
            result.runnerSkipsFixed++;
            fileChanged = true;
          }
        }
      }
    }

    const itCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(call => {
        const exprText = call.getExpression().getText();
        return exprText === 'it' || exprText === 'it.only';
      });

    for (const itCall of itCalls) {
      const args = itCall.getArguments();
      if (args.length < 2) continue;
      const callback = args[1];
      const body = callback.asKind(SyntaxKind.FunctionExpression)?.getBody() ||
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
              const positiveCond = condText.slice(1).trim().replace(/^\((.*)\)$/, '$1');
              runnerExpr = `(${positiveCond} ? it : it.skip)`;
            } else {
              runnerExpr = `(${condText} ? it.skip : it)`;
            }
            ifStmt.remove();
            itCall.getExpression().replaceWithText(`// eslint-disable-next-line no-restricted-properties\n${runnerExpr}`);
            result.runnerSkipsFixed++;
            fileChanged = true;
          }
        }
      }
    }

    if (fileChanged) {
      sourceFile.saveSync();
      result.filesModified.push(filePath);
    }
  }

  return result;
}
