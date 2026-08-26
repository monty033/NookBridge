import { describe, expect, it } from "vitest";
import {
  baseline,
  NOOKBRIDGE_STAGE,
  PINNED_NOTESNOOK_CORE_VERSION,
  PINNED_NOTESNOOK_MONOREPO_SHA,
  PINNED_NIXPKGS_REV,
  STAGE_0_VERSION,
  STAGE_1_VERSION,
} from "../src/index.js";

describe("NookBridge Stage 0/1 additive baseline surface", () => {
  it("exports the Stage 1 stage identifier (Stage 0 was superseded by Stage 1)", () => {
    // Stage 1 layered on top of the frozen Stage 0 baseline.  The
    // current `NOOKBRIDGE_STAGE` reflects the highest-numbered stage
    // this build ships; Stage 1 supersedes Stage 0 here.
    expect(NOOKBRIDGE_STAGE).toBe("stage-1-persistent-storage");
  });

  it("pins the documented Stage 0 version (kept for downward compatibility)", () => {
    expect(STAGE_0_VERSION).toBe("0.0.0-stage.0");
  });

  it("pins the Stage 1 version added additively alongside Stage 0", () => {
    expect(STAGE_1_VERSION).toBe("0.1.0-stage.1");
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
    // Stage 1 split the single `baseline.version` field into per-stage
    // keys so downstream tooling can pin a specific stage without
    // ambiguity.  Both keys are part of the additive surface.
    expect(baseline.stage0Version).toBe(STAGE_0_VERSION);
    expect(baseline.stage1Version).toBe(STAGE_1_VERSION);
    expect(baseline.notesnookMonorepoSha).toBe(PINNED_NOTESNOOK_MONOREPO_SHA);
    expect(baseline.notesnookCoreVersion).toBe(PINNED_NOTESNOOK_CORE_VERSION);
    expect(baseline.nixpkgsRev).toBe(PINNED_NIXPKGS_REV);
  });
});
