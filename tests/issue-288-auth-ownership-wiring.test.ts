// Proves the auth runtime WIRES the caller-ownership guard, not just that the
// guard function is correct: with the state root reported as owned by another
// user, constructing the runtime must refuse before any key or state is made.

import { mkdtempSync, statSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const FOREIGN_UID = 4242;
let foreignPath: string | undefined;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    statSync: ((path: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
      const real = (actual.statSync as (...a: unknown[]) => ReturnType<typeof actual.statSync>)(
        path,
        ...rest,
      );
      if (foreignPath !== undefined && String(path) === foreignPath) {
        return { ...real, uid: FOREIGN_UID } as typeof real;
      }
      return real;
    }) as typeof actual.statSync,
  };
});

describe("issue #288 — the auth runtime refuses a foreign-owned state root", () => {
  it("refuses before building the runtime", async () => {
    const { createProductionLiveLoginRuntime } = await import("../src/auth/live-login-runtime.js");
    const stateDir = mkdtempSync(join(tmpdir(), "nb288-wire-"));
    foreignPath = stateDir;
    try {
      // Sanity: the mock is what makes this foreign, not the real filesystem.
      expect(statSync(stateDir).uid).toBe(FOREIGN_UID);
      await expect(createProductionLiveLoginRuntime({ stateDir })).rejects.toThrow(
        "state directory is owned by another user",
      );
    } finally {
      foreignPath = undefined;
    }
  });

  it("still allows a state root owned by the caller", async () => {
    const { assertCallerOwnsStateRoot } = await import("../src/auth/live-login-runtime.js");
    const stateDir = mkdtempSync(join(tmpdir(), "nb288-wire-ok-"));
    expect(() => assertCallerOwnsStateRoot(stateDir)).not.toThrow();
  });
});
