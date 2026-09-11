import * as fs from 'fs';
import * as path from 'path';

export interface PackageClassification {
  name: string;
  packagePath: string;
  tier: 'tier1' | 'tier2' | 'tier3';
  hasKarma: boolean;
  hasEmulator: boolean;
  hasIntegrationTests: boolean;
  hasNodeTests: boolean;
  isBrowserOnly: boolean;
  testFiles: string[];
  recommendations: string[];
}

export function classifyPackage(packagePath: string): PackageClassification {
  const pkgJsonPath = path.join(packagePath, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`package.json not found at ${packagePath}`);
  }

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const pkgName = pkgJson.name || path.basename(packagePath);
  const karmaConfPath = path.join(packagePath, 'karma.conf.js');
  const hasKarma = fs.existsSync(karmaConfPath);

  const scripts = pkgJson.scripts || {};
  const scriptKeys = Object.keys(scripts);
  const scriptValues = Object.values(scripts) as string[];

  const hasEmulator = scriptKeys.some(k => k.includes('emulator')) ||
    JSON.stringify(scripts).includes('emulator');

  const hasIntegrationTests = scriptKeys.some(k => k.includes('integration') || k.includes('prod') || k.includes('nightly')) ||
    fs.existsSync(path.join(packagePath, 'test/integration'));

  const isComplexMultiTarget = pkgName.includes('firestore') ||
    pkgName.includes('auth') ||
    pkgName.includes('database') ||
    pkgJson.exports?.['./lite'] !== undefined;

  let tier: 'tier1' | 'tier2' | 'tier3' = 'tier1';
  const recommendations: string[] = [];

  if (isComplexMultiTarget) {
    tier = 'tier3';
    recommendations.push('Requires platform alias plugins (e.g. firestorePlatformPlugin or custom export conditions).');
    recommendations.push('Requires multi-client or IndexedDB persistence shims.');
  } else if (hasEmulator || hasIntegrationTests) {
    tier = 'tier2';
    recommendations.push('Contains emulator/integration tests; ensure emulator hooks and mock connection shims are loaded in setup.');
  } else {
    tier = 'tier1';
    recommendations.push('Standard unit test package; 100% automated migration candidate.');
  }

  // Scan test files
  const testFiles: string[] = [];
  function findTests(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
        findTests(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.js'))) {
        testFiles.push(path.relative(packagePath, fullPath));
      }
    }
  }
  findTests(path.join(packagePath, 'test'));
  findTests(path.join(packagePath, 'src'));

  const hasExplicitNodeScript =
    scriptKeys.some(k => k === 'test:node' || k === 'test:node:unit') ||
    scriptValues.some(v => typeof v === 'string' && (v.includes('mocha') || v.includes('ts-node ')));

  const hasExplicitKarmaScript =
    hasKarma ||
    scriptKeys.some(k => k.includes('karma')) ||
    scriptValues.some(v => typeof v === 'string' && v.includes('karma'));

  const vitestConfigPath = path.join(packagePath, 'vitest.config.mjs');
  const hasExistingVitestConfig = fs.existsSync(vitestConfigPath);
  const vitestConfigContent = hasExistingVitestConfig
    ? fs.readFileSync(vitestConfigPath, 'utf8')
    : '';
  const isVitestFilteredToBrowser = vitestConfigContent.includes("project.test?.name === 'browser'");

  const hasNodeSpecificTestFiles = testFiles.some(f => f.includes('.node.test.') || f.includes('/node/'));

  let hasNodeTests = hasExplicitNodeScript || hasNodeSpecificTestFiles;
  let isBrowserOnly = isVitestFilteredToBrowser || (hasExplicitKarmaScript && !hasExplicitNodeScript && !hasNodeSpecificTestFiles);

  if (isBrowserOnly) {
    hasNodeTests = false;
    recommendations.push('Browser-only test package; omit redundant test:node script and filter vitest config to browser project.');
  }

  return {
    name: pkgName,
    packagePath,
    tier,
    hasKarma,
    hasEmulator,
    hasIntegrationTests,
    hasNodeTests,
    isBrowserOnly,
    testFiles,
    recommendations
  };
}
