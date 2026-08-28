import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ScaffoldResult {
  vitestConfigCreated: boolean;
  setupCreated: boolean;
  setupNodeCreated: boolean;
  setupMochaCreated: boolean;
  vitestGlobalsCreated: boolean;
  packageJsonUpdated: boolean;
  files: string[];
}

export function scaffoldConfig(packagePath: string, tier: string = 'tier1'): ScaffoldResult {
  const result: ScaffoldResult = {
    vitestConfigCreated: false,
    setupCreated: false,
    setupNodeCreated: false,
    setupMochaCreated: false,
    vitestGlobalsCreated: false,
    packageJsonUpdated: false,
    files: []
  };

  // 1. Write unified vitest.config.mjs (Multi-Project Workspace)
  const configPath = path.join(packagePath, 'vitest.config.mjs');
  const templateConfigPath = path.resolve(__dirname, '../templates/vitest.config.mjs.tpl');
  const configContent = fs.existsSync(templateConfigPath)
    ? fs.readFileSync(templateConfigPath, 'utf8')
    : `import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: 'browser',
          globals: true,
          browser: {
            enabled: true,
            provider: playwright({
              launchOptions: {
                channel: 'chrome',
                args: ['--no-sandbox', '--disable-setuid-sandbox']
              }
            }),
            headless: true,
            instances: [{ browser: 'chromium' }]
          },
          setupFiles: ['./test/setup.ts'],
          include: ['test/unit/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['test/node/**', '**/*.node.test.ts']
        }
      },
      {
        test: {
          name: 'node',
          globals: true,
          environment: 'node',
          setupFiles: ['./test/setup.node.ts'],
          include: ['test/**/*.test.ts'],
          exclude: ['test/browser/**', '**/*.browser.test.ts']
        }
      }
    ]
  }
});
`;

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, configContent, 'utf8');
    result.vitestConfigCreated = true;
    result.files.push(configPath);
  }

  // 2. Write test/setup.ts for browser tests
  const testDir = path.join(packagePath, 'test');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  const setupPath = path.join(testDir, 'setup.ts');
  const templateSetupPath = path.resolve(__dirname, '../templates/setup.ts.tpl');
  const setupContent = fs.existsSync(templateSetupPath)
    ? fs.readFileSync(templateSetupPath, 'utf8')
    : `import { use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
use(chaiAsPromised);
`;

  if (!fs.existsSync(setupPath)) {
    fs.writeFileSync(setupPath, setupContent, 'utf8');
    result.setupCreated = true;
    result.files.push(setupPath);
  }

  // 3. Write test/setup.node.ts for Vitest Node tests
  const setupNodePath = path.join(testDir, 'setup.node.ts');
  const templateSetupNodePath = path.resolve(__dirname, '../templates/setup.node.ts.tpl');
  if (fs.existsSync(templateSetupNodePath) && !fs.existsSync(setupNodePath)) {
    fs.writeFileSync(setupNodePath, fs.readFileSync(templateSetupNodePath, 'utf8'), 'utf8');
    result.setupNodeCreated = true;
    result.files.push(setupNodePath);
  }

  // 4. Write test/setup.mocha.ts for Node Mocha CommonJS test compatibility
  const setupMochaPath = path.join(testDir, 'setup.mocha.ts');
  const templateSetupMochaPath = path.resolve(__dirname, '../templates/setup.mocha.ts.tpl');
  if (fs.existsSync(templateSetupMochaPath) && !fs.existsSync(setupMochaPath)) {
    fs.writeFileSync(setupMochaPath, fs.readFileSync(templateSetupMochaPath, 'utf8'), 'utf8');
    result.setupMochaCreated = true;
    result.files.push(setupMochaPath);
  }

  // 5. Write src/types/vitest-globals.d.ts for global ambient typing
  const typesDir = path.join(packagePath, 'src/types');
  if (!fs.existsSync(typesDir)) {
    fs.mkdirSync(typesDir, { recursive: true });
  }
  const vitestGlobalsPath = path.join(typesDir, 'vitest-globals.d.ts');
  const templateVitestGlobalsPath = path.resolve(__dirname, '../templates/vitest-globals.d.ts.tpl');
  if (fs.existsSync(templateVitestGlobalsPath) && !fs.existsSync(vitestGlobalsPath)) {
    fs.writeFileSync(vitestGlobalsPath, fs.readFileSync(templateVitestGlobalsPath, 'utf8'), 'utf8');
    result.vitestGlobalsCreated = true;
    result.files.push(vitestGlobalsPath);
  }

  // 6. Update package.json scripts while preserving Karma and Mocha Node tests
  const pkgJsonPath = path.join(packagePath, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    pkgJson.scripts = pkgJson.scripts || {};

    const hasSetup = pkgJson.scripts['testsetup'] ? 'yarn testsetup && ' : '';
    const playwrightGuard = 'node ../../scripts/ensure_playwright.js && ';

    // Add unified and project Vitest scripts
    pkgJson.scripts['test'] = 'yarn test:all';
    pkgJson.scripts['test:all'] = `${hasSetup}${playwrightGuard}vitest run`;
    pkgJson.scripts['test:browser'] = `${hasSetup}${playwrightGuard}vitest run --project=browser`;
    pkgJson.scripts['test:browser:watch'] = 'vitest --project=browser';
    pkgJson.scripts['test:node'] = 'vitest run --project=node';
    pkgJson.scripts['test:node:watch'] = 'vitest --project=node';
    pkgJson.scripts['test:ci'] = 'node ../../scripts/run_tests_in_ci.js -s test:all';

    // Add Vitest devDependencies
    pkgJson.devDependencies = pkgJson.devDependencies || {};
    if (!pkgJson.devDependencies['vitest']) {
      pkgJson.devDependencies['vitest'] = '4.1.10';
    }
    if (!pkgJson.devDependencies['@vitest/browser-playwright']) {
      pkgJson.devDependencies['@vitest/browser-playwright'] = '4.1.10';
    }

    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf8');
    result.packageJsonUpdated = true;
    result.files.push(pkgJsonPath);
  }

  return result;
}
