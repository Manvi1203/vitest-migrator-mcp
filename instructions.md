# Migration Instructions & Architectural Invariants (`mcp-vitest-migrator`)

These instructions define the mandatory rules and migration lifecycle for all AI agents and engineers migrating packages from **Karma + Mocha** to **Vitest**.

---

## 1. Unified Multi-Project Architecture (CRITICAL)
- Replaces legacy Karma + Mocha + Webpack test runners with a single unified `vitest.config.mjs` defining two isolated projects:
  - **`node` project**: `environment: 'node'`, `pool: 'forks'`, `include: ['test/**/*.test.ts', 'src/**/*.test.ts']`, `exclude: ['**/browser/**', '**/*.browser.test.ts']`
  - **`browser` project**: `browser.enabled: true`, `provider: playwright()`, `instances: [{ browser: 'chromium' }]`, `headless: true`, `exclude: ['**/node/**', '**/*.node.test.ts']`
- **Automatic Playwright Provisioning**: `vitest.config.mjs` imports `../../scripts/ensure_playwright.js` at the top, automatically ensuring Chromium / headless-shell binaries exist without needing any npm script wrapper.
- **Clean Standardized `package.json` Scripts**:
  - Preserve `type-check` in `"test"`: `"run-p --npm-path npm lint [type-check ]test:all"`
  - `"test:all"`: `"vitest run"`
  - **For browser-only packages**:
    - `"test:browser"`: `"vitest run"` *(Omit redundant `--project=browser` since only one project exists)*
    - `"test:browser:debug"`: `"vitest --browser.headless=false"`
    - Omit `"test:node"`
  - **For multi-project packages (Node + Browser)**:
    - `"test:browser"`: `"vitest run --project=browser"`
    - `"test:browser:debug"`: `"vitest --project=browser --browser.headless=false"`
    - `"test:node"`: `"vitest run --project=node"`
  - `"test:ci"`: `"node ../../scripts/run_tests_in_ci.js -s test:all"`
- **Cleanup**: Delete deprecated legacy `karma.conf.js`.

---

## 2. Test Files Compatibility & Invariants
1. **Never write `import { vi } from 'vitest'` in test files**:
   - Use ambient typing via `src/types/vitest-globals.d.ts` and `globals: true` in `vitest.config.mjs`.
2. **Never chain `.timeout()` on `it()`**:
   - Pass timeout as the 3rd argument `it('name', fn, ms)` or guard `this.timeout`:
     ```typescript
     if (this && typeof this.timeout === 'function') {
       this.timeout(20000);
     }
     ```
3. **Guard Mocha-specific context (`this.test.fullTitle()`)**:
   - Replace `this.test.fullTitle()` with `this?.test?.fullTitle() ?? '<fallback>'`.
4. **Migrate Legacy Sinon-Chai Mock Assertions to Native Vitest Matchers**:
   - Never leave legacy Sinon-Chai assertions (`expect(x).to.have.been.calledOnce`, `expect(x).to.have.been.calledWith(...)`, `expect(x).has.been.calledWith(...)`, `expect(x).to.have.been.called`, `expect(x).to.not.have.been.called`) in migrated test suites.
   - Always convert them to native Vitest matchers: `toHaveBeenCalledTimes(1)`, `toHaveBeenCalledWith(...)`, `toHaveBeenCalled()`, and `not.toHaveBeenCalled()`.
5. **Migrate Legacy Chai Assertions to Native Vitest Matchers**:
   - Never leave legacy Chai assertions in migrated test files (`.to.equal` -> `.toBe`, `.to.deep.equal` / `.to.eql` -> `.toEqual`, `.to.throw` -> `.toThrow`, `.to.be.undefined` -> `.toBeUndefined`, `.to.be.null` -> `.toBeNull`, `.to.exist` -> `.toBeDefined`).
   - Vitest runs best with native matchers, avoiding runtime shim overhead and reviewer/bot comments.
6. **Stub Console, Logger, and Expensive Native Methods with `.mockImplementation()` or `.mockReturnValue()`**:
   - In Vitest, `vi.spyOn(obj, method)` calls through to the original implementation by default.
   - When spying on `console` (`log`, `info`, `warn`, `error`), logger methods, or native browser/Node methods where real execution is not desired (to eliminate test log noise or save unnecessary computation), ALWAYS chain `.mockImplementation(() => {})` or `.mockReturnValue(...)` to stub out the method.

---

## 3. Module Mocking in Native ESM vs. CommonJS (`vi.mock('...', { spy: true })`)
- In **Native ESM (Vitest Browser & Node ESM)**, imported module namespaces (`import * as mod from './mod'`) are sealed and non-configurable (`writable: false, configurable: false`). Calling `sinon.stub(mod, 'fn')` or `vi.spyOn(mod, 'fn')` on an unmocked module fails with `TypeError: Cannot redefine property` or `TypeError: Cannot spy on export`.
- **Mandatory Pattern — Use `vi.mock('./mod', { spy: true })` + `vi.spyOn(mod, 'fn')`**:
  - **NEVER** write verbose `vi.hoisted(...)` + `vi.mock('./mod', async importOriginal => { ... mockFn.getMockImplementation() ? mockFn(...args) : actual.fn(...args) })` delegate wrappers.
  - Instead, declare `vi.mock('./mod', { spy: true });` at the top level of the test file and use standard `vi.spyOn(mod, 'fn').mockResolvedValue(...)` / `.mockImplementation(...)` inside `beforeEach` or `it()` blocks.
  - `vi.mock('./mod', { spy: true })` wraps all exports in `AutospiedModule` mocks that preserve and execute the original implementation by default while allowing per-test overrides via `vi.spyOn`.
- **Mandatory `test/setup.ts` Teardown (`vi.resetAllMocks()` + `vi.restoreAllMocks()`)**:
  - Always include `vi.resetAllMocks()` alongside `vi.restoreAllMocks()` in `test/setup.ts`:
    ```typescript
    afterEach(() => {
      vi.useRealTimers();
      vi.resetAllMocks();
      vi.restoreAllMocks();
    });
    ```
  - Why: In `@vitest/spy` (`vitest 4.x`), calling `vi.spyOn(mod, 'fn')` on an `AutospiedModule` export returns the existing mock instance directly without registering a property descriptor override in `MOCK_RESTORE`. `vi.resetAllMocks()` resets `config.mockImplementation` back to `undefined` so every autospied export automatically reverts to `config.mockOriginal` (the real implementation) after each test.
  - Because `test/setup.ts` runs `vi.resetAllMocks()` and `vi.restoreAllMocks()` after every test, **never** leave redundant manual `spy.mockRestore()` calls at the end of `it()` blocks, and always move global state cleanup (e.g. `self.grecaptcha = undefined`, `self.FIREBASE_APPCHECK_DEBUG_TOKEN = undefined`) into `afterEach` hooks.

---

## 4. Zero Redundant Inline Comments & Standardized PR Description
- **Never insert inline code comments citing error messages or migration rationale into test files or production source code**:
  - Test files must remain clean, minimal, and idiomatic. Inline comments citing Vitest errors (e.g. `// Guard process access to avoid Vitest browser error: "ReferenceError: process is not defined"`) clutter code diffs and are flagged as redundant by reviewers and automated bots.
  - All migration rationale, resolved compiler/test errors, and architectural notes must be documented exclusively in the **PR Description**.
- **Standard PR Description Format (Reference: PR #10375, PR #10376 & PR #10394)**:
  - `### Summary`: One-sentence summary (`Migrates @firebase/<pkg> unit [and integration] tests from legacy Karma (Mocha / Chai / Sinon) to **Vitest** (Browser Chromium via Playwright).`).
  - `### 🧭 Reviewer's Guide` *(for multi-file PRs)*: Categorize changed files into **Bucket 1 (Runner Config, Setup & CI Workflows — Review Carefully)**, **Bucket 2 (Test Harness & Custom Helpers — Review Carefully)**, and **Bucket 3 (Mechanical `*.test.ts` Migrations — Safe to Skim)**, plus a **Quick Vitest Cheat Sheet** table mapping Mocha/Chai/Sinon idioms to Vitest so reviewers unfamiliar with Vitest can review quickly.
  - `### Description`:
    - **Runner & Config**: `vitest.config.mjs` extending `config/vitest.base.mjs`, defensive project filtering (`if (config.test?.projects)`), and `test/setup.ts` global `afterEach` teardown (`vi.useRealTimers()`, `vi.resetAllMocks()`, `vi.restoreAllMocks()`).
    - **Target Environment**: Why tests run in `browser` (`@vitest/browser-playwright`) and/or `node`, listing key browser/Node APIs exercised.
    - **Assertions & Lifecycle**: Chai to native Vitest matcher conversions (`.toBe()`, `.toEqual()`, `.toBeCloseTo()`, `.rejects.toThrow()`, `.toThrow()`), Mocha `done` callback to Promise conversion, and `afterEach` global state cleanup.
    - **Mocks, Spies & Timers**: Sinon to Vitest (`vi.fn()`, `vi.spyOn()`, `vi.useFakeTimers()`) and `vi.mock('...', { spy: true })` for spying/overriding ESM module exports while keeping original implementations active by default.
    - **Module Augmentation / Build Config** *(if applicable)*: Any `@firebase/component/dist/src/types` module augmentation or `rollup.config.js` updates.
    - **Package Scripts**: `package.json` script updates (`test`, `test:ci`, `test:browser`, `test:browser:debug`) and removal of legacy Karma scripts/configs.
  - `### Performance`: Comparison of **Baseline (Karma + Webpack)** vs **Vitest (Unit Tests)** (and **Integration Tests** if applicable) with file/test counts and execution time.
- **Additional Invariants**:
  - **Never Use `dangerouslyIgnoreUnhandledErrors: true` (Use Targeted `onUnhandledError` Instead)**:
    - Never set `dangerouslyIgnoreUnhandledErrors: true` in `vitest.config.mjs`, as it globally masks genuine unhandled rejections across all tests.
    - Always fix unawaited error promises directly in tests (`await expect(p).rejects.toThrow(...)` or `.catch(() => {})`). If a background rejection occurs inside SDK initialization before a `.catch` handler can be attached during a negative test (e.g., `BundleReaderImpl` constructor rejecting before `getSyncEngine()` finishes opening IndexedDB), configure `config.test.onUnhandledError` at the top level of `vitest.config.mjs` to return `false` **only** for that exact expected error message.
  - **Use `expect(actual).toBeCloseTo(expected, precisionDigits)` for Floating-Point Comparisons**:
    - Always convert Chai `.to.be.closeTo(expected, delta)` / `.to.be.approximately(expected, delta)` to native `expect(actual).toBeCloseTo(expected, precisionDigits)` rather than `expect(Math.abs(actual - expected)).toBeLessThanOrEqual(delta)`.
  - **Handle Vitest `.skip` Getter When Chaining Custom Modifiers**:
    - In Vitest, `it.skip` and `describe.skip` are property getters returning a fresh function instance on each access. If a package defines custom chainable modifiers (`it.skipEnterprise`, `it.skipEmulator`, etc.), wrap `.skip` accesses in a helper (`getSkip(base)`) that re-attaches the custom modifiers onto the returned function instance.
  - **Suite-Level Skipping (`describe.skip`) & Standalone Setup Files**:
    - Vitest fails if a `.test.ts` file registers zero active or skipped tests (`Error: No test suite found in file`). Apply `.skip` at the suite definition (`(enabled ? describe : describe.skip)('...', ...)`) rather than returning early inside `describe(...)`, and wrap standalone `beforeAll` setup files in a `describe` block containing a dummy `it(...)`.
  - **Assert Error Messages Directly (Do Not Mutate `error.name`)**: Use standard `new Error('msg')` and assert `expect((e as Error).message).toBe('msg')` or `expect(promise).rejects.toThrow('msg')`. Do not set `customErr.name = 'foo'`.
  - **No Node 20 Compatibility Shims**: Do not add Node 20 fallbacks (e.g. `if (typeof WebSocket === 'undefined')`) in test files. CI and target environments run Node >= 22.
  - **Match Test Titles to Matchers**: When asserting error messages/reasons with `toThrow(...)`, remove references to specific error types like `DOMException` from test titles unless explicitly asserting the error class.
  - **No Unnecessary Changesets**: Only generate a `.changeset/<package>-vitest-migration.md` if runtime/published behavior in `src/` changes. Pure test migrations or internal test-only type path adjustments do not require a changeset.

---

## 5. Standard 6-Step Migration Loop
1. **`vitest_classify_package`**: Classify target package.
2. **`vitest_lookup_knowledge_bank`**: Check known issues and solutions.
3. **`vitest_scaffold_config`**: Generate `vitest.config.mjs`, `test/setup.ts`, and update `package.json`.
4. **`vitest_apply_ast_codemods`**: Automatically fix BDD syntax, `it.timeout()`, and type annotations.
5. **`vitest_run_verification`**: Run all tests across Node and Chromium browser projects.
6. **`vitest_record_learning`**: If any novel issue is encountered, record the solution into the Knowledge Bank.

