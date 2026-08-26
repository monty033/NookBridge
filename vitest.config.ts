import { defineConfig } from "vitest/config";

/**
 * Vitest baseline for NookBridge Stage 0.
 *
 * Notes:
 *  - pool = forks so each test file gets a clean process and a fresh
 *    `better-sqlite3-multiple-ciphers` handle (the native module is not
 *    safe to load twice in the same process).
 *  - The non-network Notesnook core init test (`tests/notesnook-core-init.test.ts`)
 *    is NOT importing @notesnook/core at Stage 0 — Stage 0 only verifies
 *    that we can build, format, lint, and run native SQLite extension
 *    smoke tests. Stage 1 will add the pinned @notesnook/core import
 *    path and the corresponding test.
 *  - Vitest's globals are disabled; tests import `describe`, `it`, `expect`
 *    explicitly so the project remains plain Node + TypeScript.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
    },
    testTimeout: 30_000,
  },
});
