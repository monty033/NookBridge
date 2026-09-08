/** Stage 10 Task 2 — pure, segment-aware settings glob matcher. */

import { describe, expect, it } from "vitest";

import { compileGlob, globMatch } from "../src/settings/settings-glob.js";

describe("settings glob matcher", () => {
  it("matches exact patterns case-insensitively", () => {
    expect(globMatch("Outdoors", "outdoors")).toBe(true);
    expect(globMatch("outdoors", "OUTDOORS")).toBe(true);
    expect(globMatch("Outdoors", "outdoor")).toBe(false);
  });

  it("allows star to match empty and one-or-more characters within a segment", () => {
    expect(globMatch("a*b", "ab")).toBe(true);
    expect(globMatch("a*b", "axxxb")).toBe(true);
  });

  it("does not allow star to cross a segment separator", () => {
    expect(globMatch("a*b", "a/x/b")).toBe(false);
    expect(globMatch("a/*/b", "a/x/b")).toBe(true);
  });

  it("matches question mark as exactly one non-separator character", () => {
    expect(globMatch("a?b", "axb")).toBe(true);
    expect(globMatch("a?b", "ab")).toBe(false);
    expect(globMatch("a?b", "a/b")).toBe(false);
  });

  it("matches mixed literal and glob syntax", () => {
    expect(globMatch("Notes/*.md", "notes/README.MD")).toBe(true);
    expect(globMatch("Notes/*.md", "notes/README.TXT")).toBe(false);
  });

  it("rejects an empty pattern at compile time", () => {
    expect(() => compileGlob("")).toThrow(new TypeError("glob pattern must not be empty"));
  });

  it("rejects patterns containing empty segments", () => {
    expect(() => compileGlob("a//b")).toThrow(
      new TypeError("glob pattern must not contain empty segments"),
    );
  });

  it("rejects non-ASCII control characters", () => {
    expect(() => compileGlob("a\u0000b")).toThrow(
      new TypeError("glob pattern contains invalid characters"),
    );
    expect(() => compileGlob("café")).toThrow(
      new TypeError("glob pattern contains invalid characters"),
    );
  });

  it("returns a memoized, frozen matcher with a null prototype", () => {
    const first = compileGlob("a/*");
    const second = compileGlob("a/*");
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.getPrototypeOf(first)).toBeNull();
    expect(first("a/b")).toBe(true);
  });
});
