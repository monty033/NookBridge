import { describe, expect, it } from "vitest";
import {
  baseline,
  NOOKBRIDGE_STAGE,
  PINNED_NOTESNOOK_CORE_VERSION,
  PINNED_NOTESNOOK_MONOREPO_SHA,
  PINNED_NIXPKGS_REV,
  STAGE_0_VERSION,
} from "../src/index.js";

describe("NookBridge Stage 0 baseline", () => {
  it("exports the Stage 0 stage identifier", () => {
    expect(NOOKBRIDGE_STAGE).toBe("stage-0-baseline");
  });

  it("pins the documented Stage 0 version", () => {
    expect(STAGE_0_VERSION).toBe("0.0.0-stage.0");
  });

  it("pins the Notesnook monorepo SHA the Stage -1 spike validated against", () => {
    // 40-char hex SHA1; this is the value recorded in docs/pins.md and
    // docs/upstream-contract.md. If you change it, change it everywhere.
    expect(PINNED_NOTESNOOK_MONOREPO_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(PINNED_NOTESNOOK_MONOREPO_SHA).toBe("c9c4936d9e8222b86204781cd1c93cdf2a1738d3");
  });

  it("pins the @notesnook/core version that the baseline targets", () => {
    expect(PINNED_NOTESNOOK_CORE_VERSION).toBe("8.1.3");
  });

  it("pins the Nixpkgs revision that flake.lock resolves", () => {
    expect(PINNED_NIXPKGS_REV).toMatch(/^[0-9a-f]{40}$/);
    expect(PINNED_NIXPKGS_REV).toBe("5880666fd9eb563038431edb35c2d0aa595884e6");
  });

  it("exposes a frozen baseline object that aggregates the pins", () => {
    expect(Object.isFrozen(baseline)).toBe(true);
    expect(baseline.stage).toBe(NOOKBRIDGE_STAGE);
    expect(baseline.version).toBe(STAGE_0_VERSION);
    expect(baseline.notesnookMonorepoSha).toBe(PINNED_NOTESNOOK_MONOREPO_SHA);
    expect(baseline.notesnookCoreVersion).toBe(PINNED_NOTESNOOK_CORE_VERSION);
    expect(baseline.nixpkgsRev).toBe(PINNED_NIXPKGS_REV);
  });
});
