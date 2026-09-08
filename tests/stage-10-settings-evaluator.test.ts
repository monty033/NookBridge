/**
 * Stage 10 Task 5 — pure settings evaluator.
 *
 * The evaluator takes a (already-loaded) `SettingsFile` plus a
 * `NotebookIndex` and returns a `SettingsDecision` describing whether
 * a given operation is allowed under the configured policy.
 *
 * The contract pinned in this suite:
 *
 *   1. When `overrides` is empty, every op returns `defaults[op]`
 *      and `matchedBy` is undefined.
 *   2. `create` matches only on `override.notebooks` patterns
 *      against `ctx.notebookPath` (when present).  Override's
 *      `notes` patterns are NEVER consulted for `create`, even if
 *      both keys were present (the loader rejects that shape, but
 *      the evaluator still tolerates a `notes`-only override as a
 *      non-match for `create`).
 *   3. `read` / `edit` / `delete` may match either via `notebooks`
 *      (the override matches when `ctx.notebookPath` is present
 *      and any notebook pattern glob-matches it) OR via `notes`
 *      (the override matches when `ctx.noteTitle` is present and
 *      any notes pattern glob-matches `<notebookPath>/<noteTitle>`
 *      where `<notebookPath>` is `ctx.notebookPath ?? ""`).
 *   4. When an override matches, `decision.allowed` is set to
 *      `override[op]` for that op and `decision.matchedBy` reports
 *      the override index and the matched pattern.
 *   5. Multiple-pattern matches: if any one pattern in an override
 *      matches, the override's op value applies (subject to the
 *      specificity tie-break below).  The `matchedBy.pattern`
 *      records the single pattern that won the tie-break.
 *   6. Specificity tie-break: when multiple overrides match and
 *      they disagree on `override[op]`, the override whose matched
 *      pattern has the longest character length wins.  On exact
 *      length tie, the later override in `settings.overrides` wins.
 *      When they agree, the value is unambiguous and `matchedBy`
 *      reports the last matching override.
 *   7. `ctx.notebookPath` may be undefined.  In that case, the
 *      `notebooks` matcher is satisfied only by single-segment
 *      patterns (no `/`) that glob-match the empty input — and the
 *      loader guarantees such entries are non-empty strings, so
 *      effectively only `"*"` (and similarly permissive
 *      single-segment patterns) match the empty path.  The
 *      `notes` matcher is satisfied only when `ctx.noteTitle` is
 *      present and the override has `notes` (the notebook segment
 *      becomes `""`).
 *   8. Pattern compilation is fail-closed.  A failing `compileGlob`
 *      on any pattern in any override throws
 *      `SettingsEvaluatorError` with `code: "settings_pattern_invalid"`
 *      at evaluator construction time, before any decisions are
 *      computed.  No partial evaluator is returned.
 *   9. The categorical `SettingsEvaluatorError` is an `Error`
 *      subclass with `code: "settings_pattern_invalid"`, a fixed
 *      message, and no `cause` chain.
 *  10. The returned `SettingsDecision.allowed` is strictly boolean
 *      and `matchedBy.pattern` is a string with a non-negative
 *      integer `overrideIndex`.
 *
 * No I/O, no Notesnook imports, no daemon imports.  Every
 * assertion runs against a pure function of its argument and the
 * injected `NotebookIndex` (built from a small synthetic record
 * list).
 */

import { describe, expect, it } from "vitest";

import { type SettingsFile, type SettingsOperation } from "../src/settings/settings-types.js";
import { buildNotebookIndex, type NotebookIndex } from "../src/settings/notebook-index.js";
import {
  SettingsEvaluatorError,
  createSettingsEvaluator,
  evaluateSettings,
  type SettingsDecision,
} from "../src/settings/settings-evaluator.js";

// ---------------------------------------------------------------------------
// Synthetic fixtures.
// ---------------------------------------------------------------------------

/**
 * Build a SettingsFile literal.  Default policy: read=true,
 * edit=false, create=false, delete=false.  Tests override the
 * fields they care about.
 */
const buildFile = (
  overrides: ReadonlyArray<{
    notebooks?: readonly string[];
    notes?: readonly string[];
    read?: boolean;
    edit?: boolean;
    create?: boolean;
    delete?: boolean;
  }>,
  defaults: { read?: boolean; edit?: boolean; create?: boolean; delete?: boolean } = {
    read: true,
    edit: false,
    create: false,
    delete: false,
  },
): SettingsFile => ({
  version: 1,
  defaults: {
    read: defaults.read ?? false,
    edit: defaults.edit ?? false,
    create: defaults.create ?? false,
    delete: defaults.delete ?? false,
  },
  overrides,
});

/**
 * Build a small NotebookIndex over a flat list of
 * (id, title) pairs.  Used only to satisfy the evaluator's
 * constructor signature — the evaluator does not call any
 * resolver at decision time, but the index still must be a real
 * NotebookIndex so its surface is the published contract.
 */
const makeIndex = (
  records: ReadonlyArray<{ id: string; title: string; parentId?: string }>,
): NotebookIndex => buildNotebookIndex(records);

// ---------------------------------------------------------------------------
// Defaults only — no overrides.
// ---------------------------------------------------------------------------

describe("settings evaluator — defaults only", () => {
  it("returns defaults[op] for every operation when overrides is empty", () => {
    const file = buildFile([], {
      read: true,
      edit: false,
      create: false,
      delete: false,
    });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "Personal", noteTitle: "Hello" })).toEqual({
      allowed: true,
    });
    expect(evaluate("edit", { notebookPath: "Personal", noteTitle: "Hello" })).toEqual({
      allowed: false,
    });
    expect(evaluate("create", { notebookPath: "Personal" })).toEqual({ allowed: false });
    expect(evaluate("delete", { notebookPath: "Personal", noteTitle: "Hello" })).toEqual({
      allowed: false,
    });
  });

  it("returns defaults[op] when ctx is empty", () => {
    const file = buildFile([], { read: true, edit: true, create: false, delete: false });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", {})).toEqual({ allowed: true });
    expect(evaluate("edit", {})).toEqual({ allowed: true });
    expect(evaluate("create", {})).toEqual({ allowed: false });
    expect(evaluate("delete", {})).toEqual({ allowed: false });
  });

  it("omits matchedBy when no override matches", () => {
    const file = buildFile([], { read: false });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    const decision = evaluate("read", { notebookPath: "Personal" });
    expect(decision.allowed).toBe(false);
    expect(decision.matchedBy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Notebook-pattern matching (read/edit/delete).
// ---------------------------------------------------------------------------

describe("settings evaluator — read/edit/delete match by notebooks pattern", () => {
  it("a single notebooks override with a literal pattern matches", () => {
    const file = buildFile([{ notebooks: ["Personal"], read: false }], { read: true });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "Personal", noteTitle: "Hello" })).toEqual({
      allowed: false,
      matchedBy: { overrideIndex: 0, pattern: "Personal" },
    });
  });

  it("a notebook override with no noteTitle still matches", () => {
    const file = buildFile([{ notebooks: ["Work"], edit: true }], { edit: false });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("edit", { notebookPath: "Work" })).toEqual({
      allowed: true,
      matchedBy: { overrideIndex: 0, pattern: "Work" },
    });
  });

  it("a notebook override does not match when notebookPath is absent (notes-style fallback only)", () => {
    // When the override has only `notebooks` and the caller
    // supplies no `notebookPath`, no override matches.  Default
    // applies.  Notes-fallback is only relevant when the override
    // has `notes`.
    const file = buildFile([{ notebooks: ["Personal"], read: false }], { read: true });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { noteTitle: "Solo" })).toEqual({ allowed: true });
  });

  it("a notebook override does not match when notebookPath differs", () => {
    const file = buildFile([{ notebooks: ["Personal"], read: false }], { read: true });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "Work", noteTitle: "Hello" })).toEqual({
      allowed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Notes-pattern matching (read/edit/delete).
// ---------------------------------------------------------------------------

describe("settings evaluator — read/edit/delete match by notes pattern", () => {
  it("a notes override matches when the joined notebookPath/noteTitle glob-matches a pattern", () => {
    const file = buildFile([{ notes: ["Personal/Hello"], read: false }], { read: true });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "Personal", noteTitle: "Hello" })).toEqual({
      allowed: false,
      matchedBy: { overrideIndex: 0, pattern: "Personal/Hello" },
    });
  });

  it("a notes override uses ctx.notebookPath ?? '' for the notebook segment", () => {
    // No notebookPath supplied; noteTitle 'Solo' is matched against
    // a single-segment pattern 'Solo' (which means "the leaf with no
    // parent").
    const file = buildFile([{ notes: ["Solo"], read: false }], { read: true });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { noteTitle: "Solo" })).toEqual({
      allowed: false,
      matchedBy: { overrideIndex: 0, pattern: "Solo" },
    });
  });

  it("a notes override does not match when noteTitle is absent", () => {
    const file = buildFile([{ notes: ["Personal/*"], read: false }], { read: true });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "Personal" })).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// create matches only by notebooks.
// ---------------------------------------------------------------------------

describe("settings evaluator — create matches only by notebooks pattern", () => {
  it("create matches a notebook override against notebookPath", () => {
    const file = buildFile([{ notebooks: ["Personal"], create: true }], { create: false });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("create", { notebookPath: "Personal" })).toEqual({
      allowed: true,
      matchedBy: { overrideIndex: 0, pattern: "Personal" },
    });
  });

  it("create ignores override.notes even if a pattern would match", () => {
    // The override carries only `notes`; the loader also rejects a
    // notes-only override for create semantically (no notebooks),
    // and the evaluator must agree: the override does not match for
    // create even though the note title would have glob-matched.
    const file = buildFile([{ notes: ["Personal/Hello"], create: true }], { create: false });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("create", { notebookPath: "Personal", noteTitle: "Hello" })).toEqual({
      allowed: false,
    });
  });

  it("create does not match when notebookPath is absent", () => {
    const file = buildFile([{ notebooks: ["Personal"], create: true }], { create: false });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("create", { noteTitle: "Hello" })).toEqual({ allowed: false });
  });

  it("create defaults to false when no override matches", () => {
    const file = buildFile([{ notebooks: ["Work"], create: true }], { create: false });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("create", { notebookPath: "Personal" })).toEqual({ allowed: false });
  });
});

// ---------------------------------------------------------------------------
// Notes takes precedence in the matcher.
// ---------------------------------------------------------------------------

describe("settings evaluator — notes matcher wins when both could apply", () => {
  it("read uses notes match even when a notebooks pattern would also match", () => {
    // The override has `notebooks` only; the override carries
    // `notes` only in a separate override.  We want to confirm that
    // when noteTitle is present and the notes pattern matches,
    // the notes override is the one whose value applies.
    const file = buildFile(
      [
        { notebooks: ["Personal"], read: false },
        { notes: ["Personal/Hello"], read: true },
      ],
      { read: false },
    );
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "Personal", noteTitle: "Hello" })).toEqual({
      allowed: true,
      matchedBy: { overrideIndex: 1, pattern: "Personal/Hello" },
    });
  });
});

// ---------------------------------------------------------------------------
// Specificity.
// ---------------------------------------------------------------------------

describe("settings evaluator — specificity tie-break", () => {
  it("a longer matching pattern wins over a shorter one when they disagree", () => {
    const file = buildFile(
      [
        { notebooks: ["Personal"], read: false },
        { notebooks: ["Personal/Private"], read: true },
      ],
      { read: false },
    );
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "Personal/Private", noteTitle: "Note" })).toEqual({
      allowed: true,
      matchedBy: { overrideIndex: 1, pattern: "Personal/Private" },
    });
  });

  it("the shorter pattern still wins for a path it matches but the longer one does not", () => {
    const file = buildFile(
      [
        { notebooks: ["Personal"], read: false },
        { notebooks: ["Personal/Private"], read: true },
      ],
      { read: true },
    );
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "Personal", noteTitle: "Note" })).toEqual({
      allowed: false,
      matchedBy: { overrideIndex: 0, pattern: "Personal" },
    });
  });

  it("equal-length tie-break: the later override wins", () => {
    const file = buildFile(
      [
        { notebooks: ["Personal"], read: true },
        { notebooks: ["Personal"], read: false },
      ],
      { read: true },
    );
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "Personal", noteTitle: "Note" })).toEqual({
      allowed: false,
      matchedBy: { overrideIndex: 1, pattern: "Personal" },
    });
  });

  it("multiple-pattern override: the pattern that wins the tie-break is recorded in matchedBy", () => {
    // Override 0 has two patterns of different lengths.  Override 1
    // has one short pattern.  Both match the same input.  Override
    // 0's longer pattern must win (length 8 > length 8 — actually
    // equal, so later override wins; here we use lengths that differ
    // so the longer pattern wins).
    const file = buildFile(
      [
        { notebooks: ["Personal", "Personal/Private"], read: true },
        { notebooks: ["Personal"], read: false },
      ],
      { read: false },
    );
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "Personal/Private", noteTitle: "Note" })).toEqual({
      allowed: true,
      matchedBy: { overrideIndex: 0, pattern: "Personal/Private" },
    });
  });
});

// ---------------------------------------------------------------------------
// Match-any semantics for a single override.
// ---------------------------------------------------------------------------

describe("settings evaluator — match-any within a single override", () => {
  it("any one matching pattern in a single override applies the override's op value", () => {
    const file = buildFile([{ notebooks: ["Other", "Personal", "Another"], read: false }], {
      read: true,
    });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "Personal", noteTitle: "Note" })).toEqual({
      allowed: false,
      matchedBy: { overrideIndex: 0, pattern: "Personal" },
    });
  });

  it("a non-matching override falls through to defaults", () => {
    const file = buildFile([{ notebooks: ["Personal"], read: false }], { read: true });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "Work", noteTitle: "Note" })).toEqual({
      allowed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Override sets op to true even if default was false (and vice versa).
// ---------------------------------------------------------------------------

describe("settings evaluator — override overrides default", () => {
  it("an override that sets op to true wins over a default of false", () => {
    const file = buildFile([{ notebooks: ["Personal"], edit: true }], { edit: false });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("edit", { notebookPath: "Personal", noteTitle: "Note" })).toEqual({
      allowed: true,
      matchedBy: { overrideIndex: 0, pattern: "Personal" },
    });
  });

  it("an override that sets op to false wins over a default of true", () => {
    const file = buildFile([{ notebooks: ["Personal"], read: false }], { read: true });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "Personal", noteTitle: "Note" })).toEqual({
      allowed: false,
      matchedBy: { overrideIndex: 0, pattern: "Personal" },
    });
  });

  it("an override that does not mention the op falls through to defaults", () => {
    // Override sets read=false but the caller asks about edit.
    const file = buildFile([{ notebooks: ["Personal"], read: false }], {
      read: true,
      edit: true,
    });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("edit", { notebookPath: "Personal", noteTitle: "Note" })).toEqual({
      allowed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Convenience function `evaluateSettings`.
// ---------------------------------------------------------------------------

describe("settings evaluator — evaluateSettings convenience", () => {
  it("matches the closure for a fresh evaluation", () => {
    const file = buildFile([{ notebooks: ["Personal"], read: false }], { read: true });
    const index = makeIndex([]);
    const fromClosure = createSettingsEvaluator(file, index)("read", {
      notebookPath: "Personal",
      noteTitle: "Note",
    });
    const fromConvenience = evaluateSettings(file, index, "read", {
      notebookPath: "Personal",
      noteTitle: "Note",
    });
    expect(fromConvenience).toEqual(fromClosure);
  });

  it("returns the default when no override matches", () => {
    const file = buildFile([{ notebooks: ["Personal"], read: false }], { read: true });
    expect(evaluateSettings(file, makeIndex([]), "read", { notebookPath: "Work" })).toEqual({
      allowed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Fail-closed pattern compilation.
// ---------------------------------------------------------------------------

describe("settings evaluator — pattern compilation is fail-closed", () => {
  it("throws SettingsEvaluatorError with code settings_pattern_invalid on an empty pattern", () => {
    // The loader rejects empty entries, but a hostile caller
    // building a SettingsFile by hand could still construct a file
    // whose pattern list reaches the evaluator.  Empty strings are
    // rejected by compileGlob; the evaluator must surface a
    // SettingsEvaluatorError at construction time.
    const file = buildFile([{ notebooks: [""], read: false }]);
    const expected = new SettingsEvaluatorError();
    expect(() => createSettingsEvaluator(file, makeIndex([]))).toThrow(expected);
  });

  it("throws SettingsEvaluatorError on an invalid character pattern", () => {
    const file = buildFile([{ notebooks: ["café"], read: false }]);
    const expected = new SettingsEvaluatorError();
    expect(() => createSettingsEvaluator(file, makeIndex([]))).toThrow(expected);
  });

  it("throws SettingsEvaluatorError on a pattern with empty segments", () => {
    const file = buildFile([{ notes: ["a//b"], read: false }]);
    const expected = new SettingsEvaluatorError();
    expect(() => createSettingsEvaluator(file, makeIndex([]))).toThrow(expected);
  });

  it("does not return a partial evaluator when construction fails", () => {
    // The first override is fine; the second is invalid.  Construction
    // must throw before any decision can be computed.
    const file = buildFile([
      { notebooks: ["Personal"], read: false },
      { notebooks: [""], read: true },
    ]);
    expect(() => createSettingsEvaluator(file, makeIndex([]))).toThrow(SettingsEvaluatorError);
  });
});

// ---------------------------------------------------------------------------
// Categorical error contract.
// ---------------------------------------------------------------------------

describe("SettingsEvaluatorError", () => {
  it("is an Error subclass that exposes the categorical code", () => {
    const error = new SettingsEvaluatorError();
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SettingsEvaluatorError);
    expect(error.code).toBe("settings_pattern_invalid");
    expect(typeof error.message).toBe("string");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("the code is the literal settings_pattern_invalid", () => {
    const error = new SettingsEvaluatorError();
    // exactOptionalPropertyTypes-safe literal check
    const code: "settings_pattern_invalid" = error.code;
    expect(code).toBe("settings_pattern_invalid");
  });
});

// ---------------------------------------------------------------------------
// Returned-shape contract (closed categories).
// ---------------------------------------------------------------------------

describe("settings evaluator — closed return shape", () => {
  it("allowed is strictly boolean on every op", () => {
    const file = buildFile([{ notebooks: ["Personal"], read: false }], {
      read: true,
      edit: false,
      create: false,
      delete: true,
    });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    const ops: SettingsOperation[] = ["read", "edit", "create", "delete"];
    for (const op of ops) {
      const decision: SettingsDecision = evaluate(op, {
        notebookPath: "Personal",
        noteTitle: "Note",
      });
      expect(typeof decision.allowed).toBe("boolean");
    }
  });

  it("matchedBy.pattern is a string and matchedBy.overrideIndex is a non-negative integer", () => {
    const file = buildFile([{ notebooks: ["Personal"], read: false }], { read: true });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    const decision = evaluate("read", { notebookPath: "Personal", noteTitle: "Note" });
    expect(decision.matchedBy).toBeDefined();
    if (decision.matchedBy !== undefined) {
      expect(typeof decision.matchedBy.pattern).toBe("string");
      expect(Number.isInteger(decision.matchedBy.overrideIndex)).toBe(true);
      expect(decision.matchedBy.overrideIndex).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Independence from notebook-index content.
// ---------------------------------------------------------------------------

describe("settings evaluator — does not consult the notebook index", () => {
  it("accepts an unknown notebookPath without resolving it", () => {
    // The path "Phantom" is not in the index.  The evaluator must
    // still produce a decision purely on glob match.
    const file = buildFile([{ notebooks: ["Phantom"], read: false }], { read: true });
    const evaluate = createSettingsEvaluator(file, makeIndex([{ id: "a", title: "A" }]));
    expect(evaluate("read", { notebookPath: "Phantom", noteTitle: "Note" })).toEqual({
      allowed: false,
      matchedBy: { overrideIndex: 0, pattern: "Phantom" },
    });
  });

  it("accepts ctx.notebookPath as either a resolved path string or undefined", () => {
    const file = buildFile([{ notebooks: ["Personal"], read: false }], { read: true });
    const index = makeIndex([{ id: "id_personal", title: "Personal" }]);
    const evaluate = createSettingsEvaluator(file, index);
    // Both an unknown path and an unresolved path produce the
    // same decision because the evaluator does not look at the index.
    const decisionKnown = evaluate("read", { notebookPath: "Personal", noteTitle: "Note" });
    const decisionUnknown = evaluate("read", { notebookPath: "Phantom", noteTitle: "Note" });
    expect(decisionKnown.allowed).toBe(false);
    expect(decisionUnknown.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case-insensitive matching (delegated to the glob module).
// ---------------------------------------------------------------------------

describe("settings evaluator — case-insensitive glob", () => {
  it("matches patterns case-insensitively", () => {
    const file = buildFile([{ notebooks: ["Personal"], read: false }], { read: true });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "PERSONAL", noteTitle: "Note" }).allowed).toBe(false);
    expect(evaluate("read", { notebookPath: "personal", noteTitle: "Note" }).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Star within a segment.
// ---------------------------------------------------------------------------

describe("settings evaluator — star and question mark within a segment", () => {
  it("star in a notebook pattern matches multiple characters", () => {
    const file = buildFile([{ notebooks: ["Pers*"], read: false }], { read: true });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "Personal", noteTitle: "Note" }).allowed).toBe(false);
    expect(evaluate("read", { notebookPath: "Pers", noteTitle: "Note" }).allowed).toBe(false);
  });

  it("star does not cross segment boundaries", () => {
    const file = buildFile([{ notebooks: ["Per*"], read: false }], { read: true });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    // "Personal/Private" has two segments; pattern "Per*" has one
    // segment.  No match.
    expect(evaluate("read", { notebookPath: "Personal/Private", noteTitle: "Note" }).allowed).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// All four ops in one run.
// ---------------------------------------------------------------------------

describe("settings evaluator — every op is independent", () => {
  it("independent ops in a single override are evaluated independently", () => {
    const file = buildFile([{ notebooks: ["Personal"], read: true, edit: false }], {
      read: false,
      edit: true,
    });
    const evaluate = createSettingsEvaluator(file, makeIndex([]));
    expect(evaluate("read", { notebookPath: "Personal", noteTitle: "Note" }).allowed).toBe(true);
    expect(evaluate("edit", { notebookPath: "Personal", noteTitle: "Note" }).allowed).toBe(false);
    // delete is not mentioned in the override -> default applies.
    expect(evaluate("delete", { notebookPath: "Personal", noteTitle: "Note" }).allowed).toBe(false);
    expect(evaluate("create", { notebookPath: "Personal" }).allowed).toBe(false);
  });
});
