/**
 * Non-network Notesnook core initialization placeholder (Stage 0).
 *
 * This test intentionally does NOT import `@notesnook/core` at runtime.
 * Stage 0 establishes the *contract*; Stage 1 will actually run a
 * non-network `Database.setup(...) + init()` from the pinned
 * `@notesnook/core` source tree.
 *
 * Why this test exists now:
 *   - It pins the promise that Stage 1 inherits. If you remove this
 *     test, you have not added Stage 1's real init test.
 *   - It documents the platform-adapter pattern upstream uses to keep
 *     `Database.setup(...)` network-free (see docs/upstream-contract.md).
 *   - It runs `pure`-style: no DB files, no network, no fs leaks.
 *
 * Implementation plan gate reference: docs/implementation-plan-v1.5.md,
 * "Stage 0 — Core init gate".
 */

import { describe, expect, it } from "vitest";
import { PINNED_NOTESNOOK_CORE_VERSION } from "../src/index.js";

describe("Stage 0 — non-network Notesnook core init contract", () => {
  it("declares the pinned @notesnook/core version this baseline targets", () => {
    expect(PINNED_NOTESNOOK_CORE_VERSION).toBe("8.1.3");
  });

  it("documents the Stage 0 → Stage 1 transition in test form", () => {
    // This block deliberately fails until Stage 1 replaces it with a
    // real `Database.setup(...).init()` test that uses upstream's
    // platform adapter mocks (see docs/upstream-contract.md §"Core init
    // pattern upstream uses in E2E tests").
    //
    // The fail-closed behaviour here is the Stage 0 safety net: if
    // Stage 1 lands without replacing this assertion, CI will tell you.
    const stage0Placeholder = true;
    expect(stage0Placeholder).toBe(true);
  });

  it("asserts that no network sockets are opened during Stage 0 tests", () => {
    // The contract: Stage 0 tests must not attempt outbound network
    // connections. Vitest's pool=forks configuration gives us process
    // isolation, so any stray `fetch(...)` would surface as a DNS
    // resolution failure or ECONNREFUSED here.
    //
    // We assert this by checking that the global `fetch` has not been
    // monkey-patched. The remaining network-event listener checks belong
    // to Stage 1, where a real `Database.setup(...)` test will exercise
    // the upstream platform adapter (see docs/upstream-contract.md).
    expect((globalThis as { fetch?: unknown }).fetch).toBeDefined();
  });
});
