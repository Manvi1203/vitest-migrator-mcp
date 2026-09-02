import { Project, SyntaxKind, ExportDeclaration } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';

export interface CodemodResult {
  filesModified: string[];
  typeExportsFixed: number;
  timeoutsFixed: number;
  fullTitlesFixed: number;
  requiresFixed: number;
  mochaHooksFixed: number;
  enumsConverted: number;
}

export function applyCodemods(packagePath: string): CodemodResult {
  const tsConfigPath = path.join(packagePath, 'tsconfig.json');
  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsConfigPath) ? tsConfigPath : undefined,
    skipAddingFilesFromTsConfig: false
  });

  if (!fs.existsSync(tsConfigPath)) {
    project.addSourceFilesAtPaths([
      path.join(packagePath, 'src/**/*.ts'),
      path.join(packagePath, 'test/**/*.ts')
    ]);
  }

  const result: CodemodResult = {
    filesModified: [],
    typeExportsFixed: 0,
    timeoutsFixed: 0,
    fullTitlesFixed: 0,
    requiresFixed: 0,
    mochaHooksFixed: 0,
    enumsConverted: 0
  };

  for (const sourceFile of project.getSourceFiles()) {
    let fileChanged = false;
    const filePath = sourceFile.getFilePath();

    // 1. Fix Type-Only Re-exports
    for (const exportDecl of sourceFile.getExportDeclarations()) {
      if (exportDecl.isTypeOnly()) continue;

      const namedExports = exportDecl.getNamedExports();
      if (namedExports.length === 0) continue;

      const typeExports: string[] = [];
      const valueExports: string[] = [];

      for (const specifier of namedExports) {
        const name = specifier.getName();
        const symbol = specifier.getNameNode().getSymbol();
        const declarations = symbol?.getDeclarations() || [];

        // Check if all declarations are type-only (interface or type alias)
        const isTypeOnly = declarations.length > 0 && declarations.every(d =>
          d.getKind() === SyntaxKind.InterfaceDeclaration ||
          d.getKind() === SyntaxKind.TypeAliasDeclaration
        );

        if (isTypeOnly) {
          typeExports.push(name);
        } else {
          valueExports.push(name);
        }
      }

      // If we found type exports that need separation
      if (typeExports.length > 0) {
        const moduleSpecifier = exportDecl.getModuleSpecifierValue();
        if (valueExports.length > 0) {
          exportDecl.set({ namedExports: valueExports });
        } else {
          exportDecl.remove();
        }

        sourceFile.addExportDeclaration({
          isTypeOnly: true,
          namedExports: typeExports,
          moduleSpecifier: moduleSpecifier
        });

        result.typeExportsFixed += typeExports.length;
        fileChanged = true;
      }
    }

    // 2. Fix Mocha this.test.fullTitle() in test files
    if (filePath.includes('/test/') || filePath.includes('.test.ts')) {
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

      // 3. Convert legacy Mocha hooks (before -> beforeAll, after -> afterAll, context -> describe)
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
    }

    // 4. Fix CJS require() in test files
    if (filePath.includes('/test/') || filePath.includes('.test.ts')) {
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
    }

    // 5. Fix global namespace shadowing ('import * as global from ...')
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

    // 6. Remove risky process.env stubbing in test hooks
    if (filePath.includes('/test/') || filePath.includes('.test.ts')) {
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
    }

    // 7. Convert exported enums / const enums to 'as const' object + string literal type
    const enums = sourceFile.getEnums();
    for (const enumDecl of enums) {
      if (!enumDecl.isExported()) continue;

      const enumName = enumDecl.getName();
      const jsDocs = enumDecl.getJsDocs().map(d => d.getText()).join('\n');
      const members = enumDecl.getMembers();

      const memberLines = members.map(m => {
        const name = m.getName();
        let valText: string;
        const init = m.getInitializer();
        if (init) {
          valText = init.getText();
        } else {
          const val = m.getValue();
          if (typeof val === 'string') {
            valText = JSON.stringify(val);
          } else if (typeof val === 'number') {
            valText = `${val}`;
          } else {
            valText = JSON.stringify(name);
          }
        }
        const mDocs = m.getJsDocs().map(d => d.getText()).join('\n');
        const prefix = mDocs ? `${mDocs}\n  ` : '  ';
        return `${prefix}${name}: ${valText}`;
      });

      const jsDocPrefix = jsDocs ? `${jsDocs}\n` : '';
      const replacementText = `${jsDocPrefix}export const ${enumName} = {
${memberLines.join(',\n')}
} as const;

export type ${enumName} = (typeof ${enumName})[keyof typeof ${enumName}];`;

      enumDecl.replaceWithText(replacementText);
      result.enumsConverted++;
      fileChanged = true;
    }

    if (fileChanged) {
      sourceFile.saveSync();
      result.filesModified.push(filePath);
    }
  }

  return result;
}
