/**
 * Stage 10 Task 5 — pure settings evaluator.
 *
 * The evaluator takes an already-loaded `SettingsFile` plus a
 * `NotebookIndex` and returns a `SettingsDecision` describing
 * whether a given operation is allowed under the configured
 * policy.
 *
 * The evaluator is the *decision* layer; the parser / loader is
 * the *validation* layer.  By the time a caller hands a
 * `SettingsFile` to `createSettingsEvaluator`, every override
 * has been shape-validated by the loader and every pattern
 * string has been id-validated by the loader's
 * `isValidIdEntry` predicate (which mirrors the glob module's
 * `validatePattern`).  The evaluator still fail-closes on
 * pattern compilation: it pre-compiles every notebook / note
 * pattern via `compileGlob` and throws
 * `SettingsEvaluatorError` with `code: "settings_pattern_invalid"`
 * if any single pattern fails to compile, so a hostile caller
 * that bypasses the loader cannot slip an un-compileable
 * pattern into a decision call.
 *
 * Decision algorithm
 * ------------------
 *
 *  1. Start with `decision = { allowed: defaults[op] }`.
 *  2. Iterate `settings.overrides` in array order with index `i`.
 *  3. For each override:
 *       - If `override[op]` is undefined, skip.
 *       - For `create`: matches iff `ctx.notebookPath` is
 *         present and any pattern in `override.notebooks` matches
 *         the full path or one of its parent paths at a `/`
 *         boundary. `override.notes` is never consulted for `create`.
 *       - For `read` / `edit` / `delete`: matches via
 *         `override.notes` against `<notebookPath>/<noteTitle>`
 *         when a note title is present, or via `override.notebooks`
 *         against the full notebook path or one of its parent paths.
 *         A `Financial` pattern therefore applies to
 *         `Financial/Banking` descendants but not `Financialness`.
 *         The loader guarantees an override MUST NOT mix
 *         `notebooks` and `notes`; the evaluator does not need to
 *         re-check that invariant.
 *  4. For every override that matches, collect one candidate
 *     record: `{ overrideIndex, pattern, value }` where
 *     `pattern` is the single pattern that won the
 *     match-any scan inside that override and `value` is
 *     `override[op]`.
 *  5. Specificity tie-break across the collected candidates:
 *       - If no candidate was collected, the decision remains
 *         the default and `matchedBy` is undefined.
 *       - Otherwise pick the candidate whose `pattern` has the
 *         longest character length.  On exact length tie, the
 *         later override in the file wins.  When multiple
 *         candidates agree on `value`, the tie-break still
 *         applies but the value is unambiguous.
 *  6. The chosen candidate's `value` becomes `decision.allowed`
 *     and its `overrideIndex` + `pattern` populate
 *     `decision.matchedBy`.
 *
 * Categorical error
 * -----------------
 *
 * `SettingsEvaluatorError` is an `Error` subclass with a fixed
 * `code: "settings_pattern_invalid"` and a fixed `message`.  The
 * message never echoes any user input (no pattern, no override
 * index, no notebook id) so a caller that forwards the error
 * to a log / RPC cannot accidentally exfiltrate
 * attacker-controlled bytes through the diagnostic.  `cause`
 * is intentionally not set.
 *
 * Closed categories
 * -----------------
 *
 *   - `SettingsDecision.allowed` is a strict `boolean`.
 *   - `SettingsDecision.matchedBy.pattern` is a `string`.
 *   - `SettingsDecision.matchedBy.overrideIndex` is a
 *     non-negative integer.
 *
 * No I/O, no Notesnook imports, no daemon imports, no global
 * state (the evaluator itself is stateless; the glob matcher
 * has its own memoisation cache which is module-private to
 * the glob module).
 */

// ---------------------------------------------------------------------------
// Imports.
// ---------------------------------------------------------------------------

import { compileGlob } from "./settings-glob.js";
import type { NotebookIndex } from "./notebook-index.js";
import type { SettingsFile, SettingsOperation } from "./settings-types.js";

// ---------------------------------------------------------------------------
// Internal type aliases.
// ---------------------------------------------------------------------------

/**
 * The compiled-glob matcher surface `compileGlob` returns.  We
 * re-declare the type here rather than importing the function's
 * return type so the evaluator does not pick up a public surface
 * from `settings-glob.ts`.  The contract — a callable that takes
 * a string and returns a boolean — is stable.
 */
type CompiledMatcher = (input: string) => boolean;

/**
 * A pre-compiled override.  Every pattern in the original
 * override is replaced by its compiled matcher; the original
 * string is kept alongside so the evaluator can record
 * `matchedBy.pattern` as the original string and so a failing
 * compile surfaces with the failing pattern index in the
 * error message (the index alone — the pattern string is NOT
 * echoed, see the categorical-error doc-comment).
 *
 * The two `compiled*` fields are always non-empty arrays;
 * `compileOverrides` substitutes a frozen `[]` when the
 * original override lacks the corresponding list, so the
 * matcher helpers can iterate unconditionally and the type is
 * `exactOptionalPropertyTypes`-clean.
 */
type CompiledOverride = {
  readonly overrideIndex: number;
  readonly original: Readonly<{
    readonly notebooks?: readonly string[];
    readonly notes?: readonly string[];
    readonly read?: boolean;
    readonly edit?: boolean;
    readonly create?: boolean;
    readonly delete?: boolean;
  }>;
  readonly compiledNotebooks: ReadonlyArray<{
    readonly original: string;
    readonly matcher: CompiledMatcher;
  }>;
  readonly compiledNotes: ReadonlyArray<{
    readonly original: string;
    readonly matcher: CompiledMatcher;
  }>;
};

/**
 * The frozen empty-list sentinel used by `compileOverrides` when
 * an override lacks a `notebooks` / `notes` list.  Sharing a
 * single frozen empty array means the matcher helpers can
 * iterate unconditionally without allocating per-override.
 */
const EMPTY_COMPILED: ReadonlyArray<{
  readonly original: string;
  readonly matcher: CompiledMatcher;
}> = Object.freeze([]);

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

/**
 * The published decision shape.  `allowed` is always present;
 * `matchedBy` is present only when an override applied.
 */
export type SettingsDecision = Readonly<{
  readonly allowed: boolean;
  readonly matchedBy?: Readonly<{
    readonly overrideIndex: number;
    readonly pattern: string;
  }>;
}>;

/**
 * The evaluation context.  Every field is optional and the
 * caller may supply any subset.  The evaluator never resolves
 * `notebookPath` against the supplied `NotebookIndex`; the
 * caller is responsible for pre-resolution if it needs to
 * discriminate against unknown paths at evaluation time.
 */
export type SettingsEvaluationContext = Readonly<{
  readonly notebookPath?: string;
  readonly noteTitle?: string;
}>;

// ---------------------------------------------------------------------------
// Categorical error.
// ---------------------------------------------------------------------------

/**
 * The single, fixed error class the evaluator throws.  `code` is
 * the literal `"settings_pattern_invalid"`; `message` is a
 * fixed string; `cause` is intentionally not set so the
 * diagnostic surface is fully deterministic and does not
 * echo user input (no pattern, no override index).
 */
export class SettingsEvaluatorError extends Error {
  public readonly code = "settings_pattern_invalid" as const;

  public constructor() {
    super("settings pattern failed to compile");
    // Pin the prototype to defend against a hostile caller
    // widening the contract after construction.  The instance
    // itself is intentionally NOT frozen: V8 installs internal
    // properties (such as `stackStr`) on first capture and
    // freezing the instance would make
    // `Error.captureStackTrace` throw.  The `code` is `readonly`
    // so the published surface is still immutable.
    Object.setPrototypeOf(this, SettingsEvaluatorError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Compilation helper.
// ---------------------------------------------------------------------------

/**
 * Compile every pattern in a string list.  Returns a frozen
 * list of `{ original, matcher }` records on success or throws
 * `SettingsEvaluatorError` on the first failure.  The pattern
 * that failed is NOT echoed; only the categorical error is
 * surfaced.
 *
 * A `undefined` input returns the shared frozen `EMPTY_COMPILED`
 * sentinel so the matcher helpers can iterate unconditionally.
 */
const compileList = (
  list: readonly string[] | undefined,
): ReadonlyArray<{ readonly original: string; readonly matcher: CompiledMatcher }> => {
  if (list === undefined) return EMPTY_COMPILED;
  const compiled: { original: string; matcher: CompiledMatcher }[] = [];
  for (const pattern of list) {
    let matcher: CompiledMatcher;
    try {
      matcher = compileGlob(pattern);
    } catch {
      throw new SettingsEvaluatorError();
    }
    compiled.push({ original: pattern, matcher });
  }
  return Object.freeze(compiled);
};

/**
 * Compile every override in a `SettingsFile`.  Throws
 * `SettingsEvaluatorError` on the first failing pattern; the
 * caller never sees a partial evaluator.  Each compiled
 * override remembers its original pattern strings so
 * `matchedBy.pattern` can be reported verbatim.
 */
const compileOverrides = (
  overrides: ReadonlyArray<{
    readonly notebooks?: readonly string[];
    readonly notes?: readonly string[];
    readonly read?: boolean;
    readonly edit?: boolean;
    readonly create?: boolean;
    readonly delete?: boolean;
  }>,
): readonly CompiledOverride[] => {
  const compiled: CompiledOverride[] = [];
  let index = 0;
  for (const override of overrides) {
    const compiledNotebooks = compileList(override.notebooks);
    const compiledNotes = compileList(override.notes);
    compiled.push(
      Object.freeze({
        overrideIndex: index,
        original: override,
        compiledNotebooks,
        compiledNotes,
      }),
    );
    index += 1;
  }
  return Object.freeze(compiled);
};

// ---------------------------------------------------------------------------
// Matching helpers.
// ---------------------------------------------------------------------------

/**
 * Find the first pattern in a compiled list whose matcher
 * returns `true` for the given input.  Returns the matched
 * `{ original, matcher }` record or `undefined`.  The
 * match-any semantics live here: ANY single match counts.
 */
const findMatch = (
  list: ReadonlyArray<{ readonly original: string; readonly matcher: CompiledMatcher }> | undefined,
  input: string,
): { readonly original: string; readonly matcher: CompiledMatcher } | undefined => {
  if (list === undefined) return undefined;
  for (const entry of list) {
    if (entry.matcher(input)) return entry;
  }
  return undefined;
};

/**
 * Find a notebook pattern that matches the full path or one of its
 * parent paths.  Parent candidates are cut only at `/` boundaries,
 * so a `Financial` override matches `Financial/Banking` but not
 * `Financialness`.  The full path is checked first so the existing
 * specificity rules continue to prefer a child notebook override.
 */
const findNotebookMatch = (
  list: ReadonlyArray<{ readonly original: string; readonly matcher: CompiledMatcher }> | undefined,
  notebookPath: string,
): { readonly original: string; readonly matcher: CompiledMatcher } | undefined => {
  if (list === undefined) return undefined;

  let candidateEnd = notebookPath.length;
  while (true) {
    const matched = findMatch(list, notebookPath.slice(0, candidateEnd));
    if (matched !== undefined) return matched;

    const separator = notebookPath.lastIndexOf("/", candidateEnd - 1);
    if (separator < 0) return undefined;
    candidateEnd = separator;
  }
};

/**
 * Does the compiled override's `notebooks` patterns match the
 * current ctx?  Returns the matched `{ original }` or
 * `undefined`.  When a notebook path is present, the full path and
 * each parent path are checked at `/` boundaries so notebook rules
 * cascade through descendants.  An undefined `notebookPath` is
 * matched only when the supplied list contains at least one
 * single-segment pattern (no `/`) that matches the empty input —
 * multi-segment patterns cannot match a zero-segment input.
 */
const matchNotebooks = (
  compiled: CompiledOverride,
  notebookPath: string | undefined,
): string | undefined => {
  const list = compiled.compiledNotebooks;
  if (list === undefined) return undefined;
  if (notebookPath !== undefined) {
    const matched = findNotebookMatch(list, notebookPath);
    return matched?.original;
  }
  // notebookPath is undefined — substitute the empty input.
  // Only single-segment patterns can match; multi-segment
  // patterns will be rejected by `compileGlob` if they contain
  // `//` and the matcher enforces equal segment counts, so the
  // attempt is harmless.  The matcher returns `false` for any
  // length-mismatch, so we just call into it.
  for (const entry of list) {
    if (entry.matcher("")) return entry.original;
  }
  return undefined;
};

/**
 * Does the compiled override's `notes` patterns match the
 * current ctx?  Returns the matched `{ original }` or
 * `undefined`.  The note input is
 * `<notebookPath>/<noteTitle>` with `<notebookPath>` substituted
 * with `""` when undefined — the case "no parent notebook".
 */
const matchNotes = (
  compiled: CompiledOverride,
  notebookPath: string | undefined,
  noteTitle: string | undefined,
): string | undefined => {
  if (noteTitle === undefined) return undefined;
  const list = compiled.compiledNotes;
  if (list === undefined) return undefined;
  const notebookSegment = notebookPath ?? "";
  const input = notebookSegment === "" ? noteTitle : `${notebookSegment}/${noteTitle}`;
  const matched = findMatch(list, input);
  return matched?.original;
};

// ---------------------------------------------------------------------------
// Public factory.
// ---------------------------------------------------------------------------

/**
 * Build a closure-based evaluator.  The closure accepts an
 * operation + a context and returns a `SettingsDecision`.  All
 * pattern compilation happens up front; the closure itself
 * performs only structural iteration and string concatenation
 * at decision time.
 *
 * Construction throws `SettingsEvaluatorError` on the first
 * un-compileable pattern; a hostile caller that bypassed the
 * loader cannot slip an invalid pattern into a decision.
 *
 * The `index` parameter is part of the published contract so the
 * evaluator can be extended to consult it in a future slice;
 * today the evaluator never calls any resolver on `index`.
 */
export const createSettingsEvaluator = (
  settings: SettingsFile,
  // `index` is currently unused at decision time.  The signature
  // takes it so a future slice can resolve notebook ids against
  // the published index without a follow-up constructor change.
  _index: NotebookIndex,
): ((op: SettingsOperation, ctx: SettingsEvaluationContext) => SettingsDecision) => {
  const compiled = compileOverrides(settings.overrides);
  const defaults = settings.defaults;

  const evaluate = (op: SettingsOperation, ctx: SettingsEvaluationContext): SettingsDecision => {
    let decision: SettingsDecision = { allowed: defaults[op] };

    // Specificity tracking — we collect every matching candidate
    // and apply the tie-break at the end so the same evaluation
    // is well-defined regardless of override order.
    let winningIndex = -1;
    let winningPattern: string | undefined;
    let winningValue: boolean | undefined;

    for (const entry of compiled) {
      const overrideValue = entry.original[op];
      if (overrideValue === undefined) continue;

      let matchedPattern: string | undefined;
      if (op === "create") {
        // `create` only consults the `notebooks` list against
        // `ctx.notebookPath`.  The override's `notes` list is
        // ignored even when present.
        if (ctx.notebookPath !== undefined) {
          matchedPattern = matchNotebooks(entry, ctx.notebookPath);
        }
      } else {
        // `read` / `edit` / `delete`.  Try `notes` first (the
        // matcher contract says notes takes precedence when both
        // could apply; the loader guarantees an override has at
        // most one of the two).
        matchedPattern = matchNotes(entry, ctx.notebookPath, ctx.noteTitle);
        if (matchedPattern === undefined) {
          matchedPattern = matchNotebooks(entry, ctx.notebookPath);
        }
      }

      if (matchedPattern === undefined) continue;

      const candidateLength = matchedPattern.length;
      const winningLength = winningPattern !== undefined ? winningPattern.length : -1;

      if (
        winningPattern === undefined ||
        candidateLength > winningLength ||
        (candidateLength === winningLength && entry.overrideIndex > winningIndex)
      ) {
        winningIndex = entry.overrideIndex;
        winningPattern = matchedPattern;
        winningValue = overrideValue;
      }
    }

    if (winningPattern !== undefined && winningValue !== undefined) {
      decision = {
        allowed: winningValue,
        matchedBy: Object.freeze({
          overrideIndex: winningIndex,
          pattern: winningPattern,
        }),
      };
    }

    return decision;
  };

  // Pin the closure's prototype to defend against hostile post-
  // construction widening, and freeze the closure itself.
  Object.setPrototypeOf(evaluate, null);
  Object.freeze(evaluate);
  return evaluate;
};

// ---------------------------------------------------------------------------
// Convenience function.
// ---------------------------------------------------------------------------

/**
 * One-shot evaluator.  Builds a fresh closure per call and
 * discards it; use `createSettingsEvaluator` when the same
 * `SettingsFile` is consulted many times (e.g. per-RPC) so the
 * compile-once cost is amortised.
 */
export const evaluateSettings = (
  settings: SettingsFile,
  index: NotebookIndex,
  op: SettingsOperation,
  ctx: SettingsEvaluationContext,
): SettingsDecision => createSettingsEvaluator(settings, index)(op, ctx);
