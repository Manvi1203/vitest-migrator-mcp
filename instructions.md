# Migration Instructions & Architectural Invariants (`mcp-vitest-migrator`)

These instructions define the mandatory rules and migration lifecycle for all AI agents and engineers migrating packages from **Karma** to **Vitest** in the Firebase JS SDK.

---

## 1. Full Karma Replacement Policy (CRITICAL)
- **Replace Karma with Vitest completely**:
  - Delete `karma.conf.js`, `karma.conf.browser.js`, and any legacy Karma configuration files.
  - Delete obsolete `nyc` configuration blocks from `package.json`.
  - Create `vitest.config.mjs` exporting the shared multi-project workspace configuration:
    ```javascript
    import createBaseConfig from '../../config/vitest.base.mjs';
    export default createBaseConfig(import.meta.url);
    ```
  - Standardize `package.json` test scripts:
    - `"test"`: `"run-p --npm-path npm lint [type-check ]test:all"` *(Preserve `type-check` if originally present)*
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

---

## 2. API Extractor Safety — Never Put Test Typings in `src/` (CRITICAL)
- **Never place `vitest-globals.d.ts` or test types inside `src/`**:
  - `api-extractor` runs during `yarn build` and analyzes all files in `src/`.
  - Adding test-runner type augmentations to `src/` pollutes the TypeScript AST, causing API Extractor to alter public API declarations (e.g. renaming `assert` to `assert_2` in `common/api-review/*.api.md`).
  - **Solution**: Keep all ambient test typings strictly in `test/types/` (or rely on `globals: true` in `config/vitest.base.mjs`).

---

## 3. Const Enums & Downstream ESM Compatibility
- **`preserveConstEnums` for exported enums**:
  - If a package exports a `const enum` (such as `ComponentType` in `@firebase/component`), TypeScript strips it by default during compilation, emitting no runtime object in `dist/esm/index.esm.js`.
  - Downstream packages importing the enum in native ESM (Vitest) will evaluate it to `undefined` at runtime.
  - **Solution**: Add `compilerOptions: { preserveConstEnums: true }` to `rollup.config.js` in `typescriptPlugin` for any package exporting `const enum`s.

---

## 4. Test Invariants & Modern Best Practices
1. **Direct Hook Migration (No Global Shims in `setup.ts`)**:
   - Never add artificial global shims (e.g. `(globalThis as any).before = beforeAll`) to `test/setup.ts`.
   - Always convert legacy Mocha hooks (`before` -> `beforeAll`, `after` -> `afterAll`, `context` -> `describe`) directly in test files.
2. **Cross-Platform Global Access (`globalThis`)**:
   - Browser environments under Playwright Chromium do not define Node's `global`. Always use `globalThis` instead of `global`.
   - Never shadow Node's global object (`import * as global from '../src/global'`). Use named imports (`import { getGlobal } from '../src/global'`).
3. **State Leakage Prevention (`try...finally`)**:
   - Always wrap temporary mutations of `globalThis` (e.g. `globalThis.__FIREBASE_DEFAULTS__`) in `try...finally` blocks so cleanup runs even if assertions fail.
4. **Dedicated Sinon Sandboxes in `beforeAll`**:
   - Calling `sinon.stub()` directly in a `beforeAll` hook is fragile because a global `afterEach` calling `sinon.restore()` will un-stub it after the first test.
   - Use a dedicated sandbox (`const sandbox = createSandbox();`) restored in `afterAll(() => sandbox.restore());`.
5. **Conditional Tests (`it.skipIf`)**:
   - Instead of wrapping test bodies in `if (isFeatureAvailable())` (which produces silent passes with 0 assertions), use `it.skipIf(!isFeatureAvailable())` so the runner explicitly tracks skipped tests.
6. **Never Stub `process.env` to `undefined` in Node**:
   - Node runtime internals and Vitest reporters require `process.env`. To test missing keys, `delete process.env[KEY]`. Native browser tests naturally run where `typeof process === 'undefined'`.
7. **Migrate Legacy Sinon-Chai Mock Assertions to Native Vitest Matchers**:
   - Never leave legacy Sinon-Chai assertions (`expect(x).to.have.been.calledOnce`, `expect(x).to.have.been.calledWith(...)`, `expect(x).has.been.calledWith(...)`, `expect(x).to.have.been.called`, `expect(x).to.not.have.been.called`) in migrated test suites.
   - Always convert them to native Vitest matchers: `toHaveBeenCalledTimes(1)`, `toHaveBeenCalledWith(...)`, `toHaveBeenCalled()`, and `not.toHaveBeenCalled()`.
8. **Migrate Legacy Chai Assertions to Native Vitest Matchers**:
   - Never leave legacy Chai assertions in migrated test files (`.to.equal` -> `.toBe`, `.to.deep.equal` / `.to.eql` -> `.toEqual`, `.to.throw` -> `.toThrow`, `.to.be.undefined` -> `.toBeUndefined`, `.to.be.null` -> `.toBeNull`, `.to.exist` -> `.toBeDefined`).
   - Vitest runs best with native matchers, avoiding runtime shim overhead and reviewer/bot comments.
9. **Zero Redundant Inline Comments — Document Changes in PR Description Only**:
   - Never add inline comments in test files or source code citing error messages (e.g. `// Guard process access to avoid Vitest browser error: "ReferenceError: process is not defined"`).
   - Keep test files clean, minimal, and idiomatic. Document all error fixes and architectural rationale exclusively in the **PR Description**.
10. **Concise Spy Layer Comments for `vi.hoisted`**:
    - When wrapping ESM module exports with `vi.hoisted` + `vi.mock`, add a single-line explanation:
      `// This inserts <mockName> as a spy layer on methods coming from ./<module>`
11. **Assert Error Messages Directly (Do Not Mutate `error.name`)**:
    - Use standard `new Error('msg')` and assert `expect((e as Error).message).toBe('msg')` or `expect(promise).rejects.toThrow('msg')`. Do not set `customErr.name = 'foo'`.
12. **No Node 20 Compatibility Shims**:
    - Do not add Node 20 fallbacks (e.g. `if (typeof WebSocket === 'undefined')`) in test files. CI and target environments run Node >= 22.
13. **Match Test Titles to Matchers**:
    - When asserting error messages/reasons with `toThrow(...)`, remove references to specific error types like `DOMException` from test titles unless explicitly asserting the error class.
14. **Mandatory Changeset for Any `src/` Edits**:
    - If a migration PR touches ANY file in `src/` (including type re-exports `export type { ... }`), always generate a patch changeset in `.changeset/<package>-vitest-migration.md`.

---

## 5. End-to-End Migration Workflow (The 6-Step Loop)

1. **Classify**: Call `vitest_classify_package({ packagePath })` to determine package tier and dependencies.
2. **Scaffold**: Call `vitest_scaffold_config({ packagePath, tier })` to:
   - Generate unified `vitest.config.mjs` & `test/setup.ts`
   - Generate `test/types/vitest-globals.d.ts` (strictly inside `test/`)
   - Remove legacy `karma.conf.js` files
   - Update `package.json` test scripts and remove obsolete `nyc` block
3. **AST Codemods**: Call `vitest_apply_ast_codemods({ packagePath })` to automatically migrate Mocha hooks, `this.test.fullTitle`, and `require()`.
4. **Verify Tests**: Call `vitest_run_verification({ packagePath, target: 'vitest-all' })` to run both Node and Browser tests.
5. **Verify Build & API Reports**: Run `yarn build` in the package to confirm TypeScript compilation, Rollup bundles, and `api-extractor` report parity.
6. **Learn**: If an unindexed error was resolved, call `vitest_record_learning(...)` to save it to the shared Knowledge Bank.
