import { Project, SyntaxKind, ExportDeclaration } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';

export interface CodemodResult {
  filesModified: string[];
  typeExportsFixed: number;
  timeoutsFixed: number;
  fullTitlesFixed: number;
  requiresFixed: number;
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
    requiresFixed: 0
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

        const comment = `// In isolated ESM builds (Vitest/Vite), TypeScript types without 'export type'\n// cause runtime errors: SyntaxError: The requested module does not provide an export named '${typeExports[0]}'.`;
        sourceFile.addExportDeclaration({
          isTypeOnly: true,
          namedExports: typeExports,
          moduleSpecifier: moduleSpecifier,
          leadingTrivia: `\n${comment}\n`
        });

        result.typeExportsFixed += typeExports.length;
        fileChanged = true;
      }
    }

    // 2. Fix Mocha this.test.fullTitle() in test files
    if (filePath.includes('/test/')) {
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
    }

    // 3. Fix CJS require() in test files
    if (filePath.includes('/test/')) {
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
                  moduleSpecifier: importPath,
                  leadingTrivia: `// In Vitest ESM mode require() is undefined; using ESM import to avoid ReferenceError: require is not defined\n`
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

    if (fileChanged) {
      sourceFile.saveSync();
      result.filesModified.push(filePath);
    }
  }

  return result;
}
