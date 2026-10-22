/**
 * Stage S7a-2 — dirty-set capability finding (outcome NO).
 *
 * If the drift guard fails, the pinned core changed: re-evaluate the S7a-2
 * finding for DR-S7a items 4 and 5 before touching this test.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DIRTY_SET_CAPABILITY } from "../src/core/notesnook-dirty-set.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;

const declaredVersion = (readJson("package.json")["dependencies"] as Record<string, string>)[
  "@notesnook/core"
];
const installedVersion = readJson("node_modules/@notesnook/core/package.json")["version"];

describe("S7a-2 dirty-set capability", () => {
  it("is frozen with exactly available, coreVersion and basis, matching the pinned core", () => {
    expect(Object.isFrozen(DIRTY_SET_CAPABILITY)).toBe(true);
    expect(Object.keys(DIRTY_SET_CAPABILITY).sort()).toEqual(["available", "basis", "coreVersion"]);
    expect(DIRTY_SET_CAPABILITY.coreVersion).toBe(declaredVersion);
    expect(DIRTY_SET_CAPABILITY.coreVersion).toBe(installedVersion);
  });

  it("drift guard: installed core still matches the evaluated version", () => {
    expect(
      installedVersion,
      "Installed @notesnook/core differs from the S7a-2 evaluated version: re-evaluate the S7a-2 finding for DR-S7a items 4 and 5",
    ).toBe(DIRTY_SET_CAPABILITY.coreVersion);
  });

  it("outcome NO: unavailable, and the module exports only the constant", async () => {
    expect(DIRTY_SET_CAPABILITY.available).toBe(false);
    const mod = await import("../src/core/notesnook-dirty-set.js");
    expect(Object.keys(mod)).toEqual(["DIRTY_SET_CAPABILITY"]);
  });

  it("outcome NO: the finding document records the conclusion", () => {
    const doc = readFileSync(join(root, "docs/engineering/stages/stage-s7a-dirty-set.md"), "utf8");
    for (const needle of [
      "8.1.3",
      "hasUnsyncedChanges",
      "no read-only dirty-set API",
      "DR-S7a item 5 applies",
    ]) {
      expect(doc, needle).toContain(needle);
    }
    expect(doc).toMatch(/index\.d\.ts:\d+/);
  });
});
