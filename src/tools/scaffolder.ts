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
    : `import '../../scripts/ensure_playwright.js';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getConcurrency() {
  if (process.env.VITEST_MAX_FORKS) {
    return parseInt(process.env.VITEST_MAX_FORKS, 10);
  }
  const totalMemGB = os.totalmem() / (1024 * 1024 * 1024);
  const memoryCap = Math.floor(totalMemGB / 1.5);
  const cpuCap = process.env.CI ? 2 : Math.max(2, Math.floor(os.cpus().length / 2));
  return Math.max(1, Math.min(12, Math.min(cpuCap, memoryCap)));
}

const maxForks = getConcurrency();

export default defineConfig({
  optimizeDeps: {
    include: ['chai', 'chai-as-promised', 'sinon', 'sinon-chai']
  },
  test: {
    globals: true,
    reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions'] : ['default'],
    projects: [
      {
        test: {
          name: 'node',
          globals: true,
          environment: 'node',
          pool: 'forks',
          forks: { maxForks },
          isolate: true,
          passWithNoTests: false,
          include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
          exclude: ['**/browser/**', '**/*.browser.test.ts'],
          setupFiles: [
            path.resolve(__dirname, 'test/setup.ts')
          ]
        }
      },
      {
        test: {
          name: 'browser',
          globals: true,
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [
              { browser: 'chromium' }
            ],
            headless: true
          },
          isolate: true,
          passWithNoTests: false,
          include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
          exclude: ['**/node/**', '**/*.node.test.ts'],
          setupFiles: [
            path.resolve(__dirname, 'test/setup.ts')
          ]
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

  // 2. Write test/setup.ts for tests
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
import { beforeAll, afterAll, describe } from 'vitest';

use(chaiAsPromised);

// Mocha compatibility aliases (before/after/context)
(globalThis as any).before = beforeAll;
(globalThis as any).after = afterAll;
(globalThis as any).context = describe;
`;

  if (!fs.existsSync(setupPath)) {
    fs.writeFileSync(setupPath, setupContent, 'utf8');
    result.setupCreated = true;
    result.files.push(setupPath);
  }

  // 3. Write src/types/vitest-globals.d.ts for global ambient typing
  const typesDir = path.join(packagePath, 'src/types');
  if (!fs.existsSync(typesDir)) {
    fs.mkdirSync(typesDir, { recursive: true });
  }
  const vitestGlobalsPath = path.join(typesDir, 'vitest-globals.d.ts');
  const templateVitestGlobalsPath = path.resolve(__dirname, '../templates/vitest-globals.d.ts.tpl');
  const vitestGlobalsContent = fs.existsSync(templateVitestGlobalsPath)
    ? fs.readFileSync(templateVitestGlobalsPath, 'utf8')
    : `import 'vitest/globals';\n`;

  if (!fs.existsSync(vitestGlobalsPath)) {
    fs.writeFileSync(vitestGlobalsPath, vitestGlobalsContent, 'utf8');
    result.vitestGlobalsCreated = true;
    result.files.push(vitestGlobalsPath);
  }

  // 4. Update package.json scripts with clean, standardized vitest commands
  const pkgJsonPath = path.join(packagePath, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    pkgJson.scripts = pkgJson.scripts || {};

    const hasSetup = pkgJson.scripts['testsetup'] ? 'yarn testsetup && ' : '';

    // Add unified and project Vitest scripts
    pkgJson.scripts['test'] = 'run-p --npm-path npm lint test:all';
    pkgJson.scripts['test:all'] = `${hasSetup}vitest run`;
    pkgJson.scripts['test:browser'] = `${hasSetup}vitest run --project=browser`;
    pkgJson.scripts['test:browser:debug'] = `${hasSetup}vitest --project=browser --browser.headless=false`;
    pkgJson.scripts['test:node'] = 'vitest run --project=node';
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
