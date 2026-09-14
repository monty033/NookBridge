/**
 * Closed Notesnook list-intent vocabulary.
 *
 * Notesnook stores two distinct check-list representations:
 *
 *   - `simple-checklist` — the lightweight `<ul class="simple-checklist">`
 *     shape that does not interact with the pinned `@notesnook/core@8.1.3`
 *     Tiptap task-list extension;
 *   - `task-list` — the rich interactive `<ul class="checklist">` shape
 *     that wires every item through the native task-list extension.
 *
 * `listKind` lets an agent pick which representation Notesnook should
 * store.  When the field is omitted (or `undefined`) the codec defaults
 * to `simple-checklist` so the existing callers — every wire envelope
 * written before this selector existed — see the same stored HTML
 * shape they produced before.  Any value outside this closed set is
 * refused categorically (the adapter maps the throw to
 * `unsupported_content`).
 *
 * This module is intentionally tiny — it owns the closed list-kind
 * vocabulary used by the codec, the write contract, the RPC protocol,
 * the MCP server, and the operator boundary.  Keeping it in its own
 * file makes the closed set a single source of truth and lets tests
 * import the same constant the production code uses.
 */

export type NotesnookListKind = "simple-checklist" | "task-list";

export const NOTESNOOK_LIST_KINDS: ReadonlyArray<NotesnookListKind> = Object.freeze([
  "simple-checklist",
  "task-list",
]);

/** Default list intent when the caller omits the selector. */
export const DEFAULT_NOTESNOOK_LIST_KIND: NotesnookListKind = "simple-checklist";

/**
 * Normalise a list-intent selector into the closed set.  Returns the
 * default when the value is `undefined` so every caller can pass a
 * possibly-missing field straight through without branching.
 *
 * Any non-`undefined` value outside the closed set is a structural
 * refusal: the caller passed a recognised-looking string that simply
 * is not one of the two intents Notesnook supports, so the request
 * must fail closed before the codec touches the body.
 */
export function normaliseNotesnookListKind(value: unknown): NotesnookListKind {
  if (value === undefined) return DEFAULT_NOTESNOOK_LIST_KIND;
  if (value === "simple-checklist" || value === "task-list") return value;
  refuseListKind();
}

/**
 * Internal refusal helper.  Throws an `Error` whose name is the codec's
 * private name so callers that already wrap the codec with a categorical
 * error (the Stage 4 write adapter) can rewrite it to
 * `unsupported_content` without leaking operator content.
 */
function refuseListKind(): never {
  const error = new Error("Notesnook markdown codec: list kind is not supported");
  Object.defineProperty(error, "name", {
    configurable: true,
    value: "NotesnookListKindError",
  });
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  throw error;
}
