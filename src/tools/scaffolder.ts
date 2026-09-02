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
    : `/**
 * @license
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import createBaseConfig from '../../config/vitest.base.mjs';

export default createBaseConfig(import.meta.url);
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

use(chaiAsPromised);
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
