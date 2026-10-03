/**
 * Reserved `<root>` notebook context for settings overrides.
 *
 * `<root>` in an override's `notebooks` list means "a note that is
 * confirmed to be in no notebook" (evaluator context with an undefined
 * `notebookPath`). It must never match a real notebook path, even a
 * notebook whose title is literally `<root>`.
 */

import { describe, expect, it } from "vitest";

import { buildNotebookIndex } from "../src/settings/notebook-index.js";
import { createSettingsEvaluator } from "../src/settings/settings-evaluator.js";
import { SettingsLoadError, loadSettings } from "../src/settings/settings-loader.js";
import type { SettingsFile } from "../src/settings/settings-types.js";

type Override = {
  notebooks?: readonly string[];
  notes?: readonly string[];
  read?: boolean;
  edit?: boolean;
  create?: boolean;
  delete?: boolean;
};

const file = (
  overrides: readonly Override[],
  defaults = { read: false, edit: false, create: false, delete: false },
): SettingsFile => ({ version: 1, defaults, overrides });

const evaluator = (settings: SettingsFile) =>
  createSettingsEvaluator(settings, buildNotebookIndex([]));

describe("settings evaluator — reserved <root> notebook context", () => {
  it("matches a confirmed-root context for read, edit and delete", () => {
    const evaluate = evaluator(
      file([{ notebooks: ["<root>"], read: true, edit: true, delete: true }]),
    );
    for (const op of ["read", "edit", "delete"] as const) {
      expect(evaluate(op, { noteTitle: "Memo" })).toMatchObject({
        allowed: true,
        matchedBy: { pattern: "<root>" },
      });
    }
  });

  it("matches a notebook-less create context", () => {
    const evaluate = evaluator(file([{ notebooks: ["<root>"], create: true }]));
    expect(evaluate("create", {})).toMatchObject({
      allowed: true,
      matchedBy: { pattern: "<root>" },
    });
  });

  it("does not match a real notebook", () => {
    const evaluate = evaluator(file([{ notebooks: ["<root>"], read: true }]));
    expect(evaluate("read", { notebookPath: "Public", noteTitle: "Memo" })).toEqual({
      allowed: false,
    });
    expect(evaluate("create", { notebookPath: "Public" })).toEqual({ allowed: false });
  });

  it("does not match a real notebook literally titled <root> or its children", () => {
    const evaluate = evaluator(file([{ notebooks: ["<root>"], read: true }]));
    expect(evaluate("read", { notebookPath: "<root>", noteTitle: "Memo" })).toEqual({
      allowed: false,
    });
    expect(evaluate("read", { notebookPath: "<root>/child", noteTitle: "Memo" })).toEqual({
      allowed: false,
    });
    expect(evaluate("create", { notebookPath: "<root>" })).toEqual({ allowed: false });
  });

  it("falls back to defaults when no rule matches a root note", () => {
    const evaluate = evaluator(
      file([{ notebooks: ["Public"], read: false }], {
        read: true,
        edit: false,
        create: false,
        delete: false,
      }),
    );
    expect(evaluate("read", { noteTitle: "Memo" })).toEqual({ allowed: true });
    expect(evaluate("edit", { noteTitle: "Memo" })).toEqual({ allowed: false });
  });

  it("a * rule still matches a confirmed root note for read (owner decision)", () => {
    const evaluate = evaluator(file([{ notebooks: ["*"], read: true }]));
    expect(evaluate("read", { noteTitle: "Memo" })).toMatchObject({ allowed: true });
  });

  it("does not make * match a notebook-less create", () => {
    const evaluate = evaluator(file([{ notebooks: ["*"], create: true }]));
    expect(evaluate("create", {})).toEqual({ allowed: false });
  });

  it("prefers <root> over * on specificity", () => {
    const evaluate = evaluator(
      file([
        { notebooks: ["<root>"], read: false },
        { notebooks: ["*"], read: true },
      ]),
    );
    expect(evaluate("read", { noteTitle: "Memo" })).toMatchObject({
      allowed: false,
      matchedBy: { pattern: "<root>" },
    });
  });
});

describe("settings loader — reserved <root> name", () => {
  const withNotebooks = (notebooks: unknown) => ({
    version: 1,
    defaults: { read: true, edit: false, create: false, delete: false },
    overrides: [{ notebooks, read: true }],
  });

  it("accepts exactly <root> in notebooks", () => {
    expect(loadSettings(withNotebooks(["<root>"])).overrides[0]?.notebooks).toEqual(["<root>"]);
    expect(loadSettings(withNotebooks(["<root>", "Public"])).overrides[0]?.notebooks).toEqual([
      "<root>",
      "Public",
    ]);
  });

  it.each(["<ROOT>", "<Root>", "<root>/x", "<ROOT>/x/y"])("rejects look-alike %s", (pattern) => {
    expect(() => loadSettings(withNotebooks([pattern]))).toThrow(SettingsLoadError);
  });

  it("still accepts <root> as a non-first segment of a real notebook pattern", () => {
    expect(() => loadSettings(withNotebooks(["Parent/<root>"]))).not.toThrow();
  });

  it("rejects <root> in a notes list", () => {
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { read: true, edit: false, create: false, delete: false },
        overrides: [{ notes: ["<root>"], read: true }],
      }),
    ).toThrow(SettingsLoadError);
  });
});
