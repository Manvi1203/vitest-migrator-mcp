# Migration Instructions & Architectural Invariants (`mcp-vitest-migrator`)

These instructions define the mandatory rules and migration lifecycle for all AI agents and engineers migrating packages from **Karma** to **Vitest**.

---

## 1. Karma Preservation Policy (CRITICAL)
- **Do not delete, replace, or deprecate Karma**:
  - Keep `karma.conf.js`, `karma.conf.browser.js`, and all Karma npm scripts (`test:browser`, `test:browser:unit`, `test:browser:integration`, `test:browser:debug`) completely intact.
  - Vitest is introduced strictly as **additive** side-by-side runners:
    - `"test:vitest:browser"`: `vitest run --config vitest.config.browser.mjs`
    - `"test:vitest:browser:watch"`: `vitest --config vitest.config.browser.mjs`
    - `"test:vitest:node"`: `vitest run --config vitest.config.node.mjs`
    - `"test:vitest:node:watch"`: `vitest --config vitest.config.node.mjs`

---

## 2. Dual-Runner `yarn test:node` Compatibility Guarantee (CRITICAL)
The package's existing Node tests (`yarn test:node` running Mocha + `ts-node` under CommonJS) **must pass with zero regressions**.

### Mandatory Invariants for Test Files:
1. **Never write `import { vi } from 'vitest'` in test files**:
   - In CommonJS (`ts-node`), `import { vi } from 'vitest'` compiles to `require("vitest")`, which throws:
     `Error: Vitest cannot be imported in a CommonJS module using require()`.
   - **Solution**: Use ambient typing via `src/types/vitest-globals.d.ts` and `globals: true` in Vitest configs. Provide `test/setup.mocha.ts` shim for Mocha.
2. **Never chain `.timeout()` on `it()`**:
   - In Vitest, `it()` returns `void` (not Mocha's `Test` object). Calling `it('...', fn).timeout(ms)` throws:
     `TypeError: Cannot read properties of undefined (reading 'timeout')`.
   - **Solution**: Pass timeout as the 3rd argument `it('name', fn, ms)` or guard `this.timeout`:
     ```typescript
     if (this && typeof this.timeout === 'function') {
       this.timeout(20000);
     }
     ```
3. **Guard Mocha-specific context (`this.test.fullTitle()`)**:
   - Replace `this.test.fullTitle()` with `this?.test?.fullTitle() ?? '<fallback>'` to avoid `TypeError: Cannot read properties of undefined (reading 'fullTitle')`.

---

## 3. Module Mocking in Native ESM vs. CommonJS
- In **Native ESM (Vitest Browser)**, imported module namespaces (`import * as mod from './mod'`) are sealed and immutable (`Object.isFrozen(mod) === true`). `sinon.stub(mod, 'export')` fails with `TypeError: Cannot redefine property`.
- **Best Practice**:
  - Prefer **Instance-Level or Dependency Injection** (e.g. `sinon.stub(service.client, 'method')` or `service._setFetchImpl(...)`). Object instances are always mutable across both ESM and CJS.
  - For top-level module mocks, use ambient `vi.mock()` with `vi.hoisted()`.

---

## 4. Clean Code Policy (PR Descriptions Over Code Comments)
- **Zero Injected Comments**: Do NOT put explanatory comments, error messages, or debugging notes into test or source files. Keep all test and source files completely clean and idiomatic.
- **Document in PR Descriptions**: Cite all technical context, error messages (such as `ReferenceError: process is not defined` or `TypeError: ES Modules cannot be stubbed`), and architectural rationale in the PR description instead.

---

## 5. Review Hygiene & Architectural Pitfalls
1. **Never Shadow Node.js `global`**:
   - Avoid `import * as global from '../src/global'`. This shadows Node's global object and creates subtle bugs.
   - Always use named imports: `import { getGlobal } from '../src/global'`.
2. **Never Stub `process.env` to `undefined` in Node**:
   - In Node.js, `process.env` is required by runtime internals, Vitest reporters, and async hooks. Stubbing it to `undefined` throws `TypeError: Cannot read properties of undefined`.
   - Browser environments under Playwright Chromium already naturally execute where `typeof process === 'undefined'`, providing full test coverage without synthetic stubs in Node.
   - If testing unset variables in Node, delete the specific key (e.g. `delete process.env.__FIREBASE_DEFAULTS__`).

---

## 5. End-to-End Migration Workflow (The 6-Step Loop)

1. **Classify**: Call `vitest_classify_package({ packagePath })` to determine package tier and dependencies.
2. **Scaffold**: Call `vitest_scaffold_config({ packagePath, tier })` to generate:
   - `vitest.config.browser.mjs` & `test/setup.ts`
   - `vitest.config.node.mjs` & `test/setup.node.ts`
   - `test/setup.mocha.ts` & `src/types/vitest-globals.d.ts`
   - Update `package.json` with `test:vitest:browser` and `test:vitest:node`.
3. **AST Codemods**: Call `vitest_apply_ast_codemods({ packagePath })` to automatically fix `export type`, `.timeout()`, and `require()`.
4. **Verify Vitest Browser**: Call `vitest_run_verification({ packagePath, target: 'vitest-browser' })`.
   - If errors occur: Query `vitest_lookup_knowledge_bank({ errorMessage })`, apply fix with exact error comment, and re-verify.
5. **Verify Vitest Node**: Call `vitest_run_verification({ packagePath, target: 'vitest-node' })`.
6. **Verify Legacy Mocha Node (`test:node`)**: Call `vitest_run_verification({ packagePath, target: 'mocha-node' })` to guarantee **zero regressions**.
7. **Learn**: If an unindexed error was resolved, call `vitest_record_learning(...)` to save it for future migrations.
