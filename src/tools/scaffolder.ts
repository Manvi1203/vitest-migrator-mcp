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
  karmaRemoved: boolean;
  files: string[];
}

import { classifyPackage } from './classifier.js';

export function scaffoldConfig(packagePath: string, tier: string = 'tier1'): ScaffoldResult {
  const result: ScaffoldResult = {
    vitestConfigCreated: false,
    setupCreated: false,
    setupNodeCreated: false,
    setupMochaCreated: false,
    vitestGlobalsCreated: false,
    packageJsonUpdated: false,
    karmaRemoved: false,
    files: []
  };

  const classification = classifyPackage(packagePath);
  const isBrowserOnly = classification.isBrowserOnly;

  // 1. Write unified vitest.config.mjs
  const configPath = path.join(packagePath, 'vitest.config.mjs');
  const templateConfigPath = path.resolve(__dirname, '../templates/vitest.config.mjs.tpl');
  
  const standardConfigContent = fs.existsSync(templateConfigPath)
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

  const browserOnlyConfigContent = `/**
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

const config = createBaseConfig(import.meta.url);

// Browser-only SDK: filter test projects to browser runner
config.test.projects = config.test.projects.filter(
  project => project.test?.name === 'browser'
);

export default config;
`;

  const configContent = isBrowserOnly ? browserOnlyConfigContent : standardConfigContent;

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, configContent, 'utf8');
    result.vitestConfigCreated = true;
    result.files.push(configPath);
  }

  // 2. Write test/setup.ts only for emulator/integration (tier2/tier3) or packages needing it
  const testDir = path.join(packagePath, 'test');
  const setupPath = path.join(testDir, 'setup.ts');
  const templateSetupPath = path.resolve(__dirname, '../templates/setup.ts.tpl');
  const setupContent = fs.existsSync(templateSetupPath)
    ? fs.readFileSync(templateSetupPath, 'utf8')
    : `// Package-specific test setup for Vitest\n`;

  if (tier !== 'tier1') {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    if (!fs.existsSync(setupPath)) {
      fs.writeFileSync(setupPath, setupContent, 'utf8');
      result.setupCreated = true;
      result.files.push(setupPath);
    }
  }

  // 3. Write test/types/vitest-globals.d.ts for global ambient typing
  // IMPORTANT: Keep strictly in test/ directory so API Extractor does not analyze it during yarn build
  const typesDir = path.join(packagePath, 'test/types');
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

  // Clean up legacy/polluting src/types/vitest-globals.d.ts if present
  const obsoleteSrcVitestGlobals = path.join(packagePath, 'src/types/vitest-globals.d.ts');
  if (fs.existsSync(obsoleteSrcVitestGlobals)) {
    fs.unlinkSync(obsoleteSrcVitestGlobals);
    result.files.push(`removed:${obsoleteSrcVitestGlobals}`);
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
    if (isBrowserOnly) {
      delete pkgJson.scripts['test:node'];
    } else {
      pkgJson.scripts['test:node'] = 'vitest run --project=node';
    }
    pkgJson.scripts['test:ci'] = 'node ../../scripts/run_tests_in_ci.js -s test:all';
    delete pkgJson.scripts['test:debug'];

    // Delete obsolete nyc configuration block if present
    if (pkgJson.nyc) {
      delete pkgJson.nyc;
    }

    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf8');
    result.packageJsonUpdated = true;
    result.files.push(pkgJsonPath);
  }

  // 5. Remove legacy Karma configuration files
  const karmaFiles = [
    path.join(packagePath, 'karma.conf.js'),
    path.join(packagePath, 'karma.conf.browser.js'),
    path.join(packagePath, 'karma.conf.headless.js')
  ];
  for (const kf of karmaFiles) {
    if (fs.existsSync(kf)) {
      fs.unlinkSync(kf);
      result.karmaRemoved = true;
      result.files.push(`removed:${kf}`);
    }
  }

  return result;
}
