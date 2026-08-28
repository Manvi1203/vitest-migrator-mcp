# MCP Vitest Migrator (`vitest-migrator-mcp`)

A Model Context Protocol (MCP) Server for automated and AI-assisted migration of JavaScript / TypeScript test suites from **Karma + Mocha** to **Vitest** (with Playwright Chromium browser testing and multi-project workspaces).

---

## Migration Guidelines & Architectural Principles

### 1. Unified Multi-Project Workspaces
- Replaces legacy Karma and Mocha runners with a unified Vitest multi-project runner (`vitest.config.mjs`) supporting both Node and Browser (Playwright Chromium) test targets.
- Dynamic concurrency management based on CPU cores and system memory.

### 2. Clean Browser Global Environment
- **No artificial `process` injection**: Never inject synthetic `globalThis.process` or `process.env` shims into the browser runtime, ensuring `typeof process !== 'undefined'` environment checks remain pristine and accurate across SDK packages.

### 3. Playwright Binary Guard
- Integrates `scripts/ensure_playwright.js` auto-installer guard in npm test scripts to ensure Playwright browser binaries are present before running browser test suites.

### 4. Lockfile Pinning over Package.json Resolutions
- Resolves transitive dependency constraints (such as CommonJS `string-width` for CLI tools in Node 22) directly in `yarn.lock` rather than cluttering root `package.json`.

---

## Features

* **Deterministic AST Codemods**: Uses `ts-morph` to automatically convert TypeScript type-only re-exports (`export type { ... }`), fix chained Mocha `.timeout(ms)`, guard `this.test.fullTitle()`, and convert CommonJS `require()` to ESM `import`.
* **Config Scaffolding**: Injects standard `vitest.config.browser.mjs`, `test/setup.ts`, `test/setup.mocha.ts`, and `src/types/vitest-globals.d.ts` into target packages.
* **Persistent Knowledge Bank**: Pattern-matching engine with seeded error signatures and fix rules from real monorepo migrations.
* **Autonomous Verification Loop**: Runs Vitest browser and Node unit tests headlessly and returns structured diagnostics.

---

## Exposed MCP Tools

1. `vitest_classify_package`: Analyzes a package to determine its migration tier (`tier1`, `tier2`, `tier3`).
2. `vitest_scaffold_config`: Generates `vitest.config.browser.mjs`, `test/setup.ts`, `test/setup.mocha.ts`, and `src/types/vitest-globals.d.ts`.
3. `vitest_apply_ast_codemods`: Runs AST transformations to fix type exports, timeouts, and require imports.
4. `vitest_lookup_knowledge_bank`: Searches the Knowledge Bank for matching error signatures and returns diagnoses.
5. `vitest_run_verification`: Runs Vitest browser or Node tests and outputs structured pass/fail results.
6. `vitest_record_learning`: Dynamically stores newly resolved error patterns into the Knowledge Bank.
7. `vitest_list_knowledge_rules`: Lists all active rules stored in `data/knowledge-bank.json`.

---

## Registration in MCP Clients

### Jetski / Gemini Coder / Claude Desktop / Cursor
Add to your global `mcp_config.json`:

```json
{
  "mcpServers": {
    "vitest-migrator": {
      "command": "node",
      "args": ["/usr/local/google/home/guptamanvi/mcp-vitest-migrator/dist/index.js"]
    }
  }
}
```

---

## Build & Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Watch mode
npm run watch
```
