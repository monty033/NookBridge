/**
 * Stage 10 Task 3 — fail-closed settings loader.
 *
 * The loader takes an already-parsed JSON value of type `unknown` and
 * returns either a deeply frozen `SettingsFile` or throws a
 * categorical `SettingsLoadError`.  It performs no I/O, does no JSON
 * parsing, and depends on nothing outside the closed settings seam
 * (schema types, this loader, and the glob module's string rules,
 * which we replicate verbatim here so the loader has no runtime
 * dependency on the glob module).
 *
 * Why the rules are replicated here
 * ---------------------------------
 *
 * The glob module (`settings-glob.ts`) validates pattern strings at
 * `compileGlob` time and rejects exactly four shapes: the empty
 * string, strings containing empty segments (`//`), strings
 * containing characters with code points outside the printable ASCII
 * range `[0x20, 0x7e]`, and non-strings.  The loader's id-list
 * validator must speak the same vocabulary as the glob module so an
 * override whose `notebooks` / `notes` lists would be rejected at
 * match time is rejected here at load time — fail-closed.  The glob
 * module intentionally keeps `validatePattern` module-private (it is
 * a compile-time guarantee, not a runtime predicate), so the loader
 * does not import it.  Instead, the loader carries its own private
 * `isValidIdEntry` predicate whose rule set is byte-identical to the
 * glob module's, and the loader doc-comments both call out the
 * coupling so a future change to either side is forced to update
 * the other.
 *
 * Categorical error
 * -----------------
 *
 * `SettingsLoadError` is an `Error` subclass that carries a fixed
 * `code: "settings_invalid"` and a fixed `message`.  The message
 * never echoes any user input (no version number, no field name
 * beyond a small closed vocabulary, no id-list entry, no path) so a
 * caller that forwards the error to a log / RPC cannot accidentally
 * exfiltrate attacker-controlled bytes through the diagnostic.
 */

import {
  SETTINGS_SCHEMA_VERSION,
  isSettingsDefaults,
  type SettingsDefaults,
  type SettingsFile,
  type SettingsOverride,
} from "./settings-types.js";

// ---------------------------------------------------------------------------
// Categorical error.
// ---------------------------------------------------------------------------

/**
 * The single, fixed error class the loader throws.  `code` is the
 * literal `"settings_invalid"`; `message` is a fixed string; `cause`
 * is intentionally not set so the diagnostic surface is fully
 * deterministic and does not echo user input.
 */
export class SettingsLoadError extends Error {
  public readonly code = "settings_invalid" as const;

  public constructor() {
    super("settings file failed validation");
    // `cause` is explicitly not assigned; the loader never forwards
    // an underlying error and never echoes any user input.  Pinning
    // the prototype closes the door on a hostile caller widening
    // the contract after construction.  The instance itself is
    // intentionally NOT frozen: V8 installs internal properties
    // (such as `stackStr`) on first capture and freezing the
    // instance makes `Error.captureStackTrace` (and any later stack
    // mutation) throw.
    Object.setPrototypeOf(this, SettingsLoadError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Id-entry validator (mirrors settings-glob's `validatePattern`).
// ---------------------------------------------------------------------------

/**
 * The four published operations a settings override may speak about.
 * Re-declared locally so this module does not need to import the
 * tuple order from `settings-types.ts` for the "at least one
 * operation boolean" check; the canonical list is still
 * `SETTINGS_OPERATION_KEYS` and the type layer's `SettingsOperation`
 * union is the only allowed key shape.
 */
const OPERATION_KEYS = ["read", "edit", "create", "delete"];

/**
 * Validate one id-list entry (a notebook id or a note id).  The
 * rule set is intentionally byte-identical to the glob module's
 * `validatePattern` helper:
 *
 *   - must be a non-empty string,
 *   - must not contain the empty-segment marker `"//"`,
 *   - must not contain any character with a code point outside the
 *     printable ASCII range `[0x20, 0x7e]` (this rejects both
 *     control characters — `< 0x20` or `=== 0x7f` — and non-ASCII
 *     characters — `> 0x7e`).
 *
 * Keeping the rule set duplicated here is deliberate.  The glob
 * module's validator is intentionally not exported (it is a
 * compile-time guarantee, not a runtime predicate), so the loader
 * replicates the rule by hand.  A drift between the two helpers
 * would be a silent security bug, so this doc-comment names the
 * coupling: any change to the glob module's validation surface
 * MUST be mirrored here in the same commit.
 */
const isValidIdEntry = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value.includes("//")) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return false;
    if (codePoint < 0x20 || codePoint > 0x7e) return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Override validator.
// ---------------------------------------------------------------------------

/**
 * The closed set of override keys.  Anything outside this set
 * (including case variants, lookalike strings, or extra fields) is
 * rejected by `validateOverride`.  Order does not matter here
 * because we iterate via `Reflect.ownKeys`.
 */
const OVERRIDE_KEYS: ReadonlySet<string> = new Set<string>([
  "notebooks",
  "notes",
  ...OPERATION_KEYS,
]);

/**
 * Validate one override entry from `overrides`.  Returns a frozen
 * `SettingsOverride` on success or throws a `SettingsLoadError` on
 * any failure.  Every failure path throws the same categorical
 * error so a caller cannot distinguish the underlying reason
 * (which would otherwise leak information about the caller's
 * settings schema).
 */
const validateOverride = (rawOverride: unknown): SettingsOverride => {
  if (rawOverride === null || typeof rawOverride !== "object") {
    throw new SettingsLoadError();
  }

  // Reject arrays masquerading as overrides.  An array is an object
  // in JavaScript, but its prototype is `Array.prototype` and its
  // indexed own keys are `"0"`, `"1"`, ... — neither of which is
  // an allowed override key.  Reject here so a hostile caller
  // cannot smuggle an array through the override slot.
  if (Array.isArray(rawOverride)) {
    throw new SettingsLoadError();
  }

  const override = rawOverride as Record<string, unknown>;

  // Reject any key outside the closed vocabulary.  This catches
  // typos (`Read`, `read_only`), smuggling (`__proto__`), and
  // unexpected fields (`banana`) without enumerating every illegal
  // shape.  Reflect.ownKeys catches both string keys and Symbol
  // keys; any Symbol key is automatically rejected.
  for (const key of Reflect.ownKeys(override)) {
    if (typeof key !== "string" || !OVERRIDE_KEYS.has(key)) {
      throw new SettingsLoadError();
    }
  }

  const hasNotebooks = Object.prototype.hasOwnProperty.call(override, "notebooks");
  const hasNotes = Object.prototype.hasOwnProperty.call(override, "notes");

  // An override must speak about notebooks XOR notes — never both
  // and never neither.  "Neither" is also rejected by the
  // "at least one operation boolean" check below, but checking it
  // here keeps the rule explicit and prevents a no-op override from
  // passing through with no operation booleans by accident.
  if (hasNotebooks && hasNotes) {
    throw new SettingsLoadError();
  }

  const notebooks = hasNotebooks ? override["notebooks"] : undefined;
  const notes = hasNotes ? override["notes"] : undefined;

  if (hasNotebooks) {
    if (!Array.isArray(notebooks)) {
      throw new SettingsLoadError();
    }
    for (const entry of notebooks) {
      if (!isValidIdEntry(entry)) {
        throw new SettingsLoadError();
      }
    }
  }

  if (hasNotes) {
    if (!Array.isArray(notes)) {
      throw new SettingsLoadError();
    }
    for (const entry of notes) {
      if (!isValidIdEntry(entry)) {
        throw new SettingsLoadError();
      }
    }
  }

  // Operation boolean checks.  Every operation key, if present,
  // must be a strict `boolean`; the override must speak about at
  // least one operation.
  let operationCount = 0;
  for (const key of OPERATION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(override, key)) continue;
    const value = override[key];
    if (typeof value !== "boolean") {
      throw new SettingsLoadError();
    }
    operationCount += 1;
  }

  if (operationCount === 0) {
    throw new SettingsLoadError();
  }

  // Build the frozen override.  We assemble it field-by-field so
  // the returned shape never carries an `undefined` for a missing
  // operation key — `exactOptionalPropertyTypes` would otherwise
  // widen the property to `boolean | undefined`, which is not what
  // the published `SettingsOverride` type advertises.
  const result: {
    -readonly [K in keyof SettingsOverride]: SettingsOverride[K];
  } = {};
  if (hasNotebooks) {
    result.notebooks = Object.freeze([...(notebooks as string[])]);
  }
  if (hasNotes) {
    result.notes = Object.freeze([...(notes as string[])]);
  }
  for (const key of OPERATION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(override, key)) {
      // The strict-boolean check above guarantees this assignment
      // is type-safe.
      (result as Record<string, unknown>)[key] = override[key];
    }
  }
  return Object.freeze(result);
};

// ---------------------------------------------------------------------------
// Recursive deep-freeze for the returned `SettingsFile`.
// ---------------------------------------------------------------------------

/**
 * Deep-freeze the candidate in place.  Object.freeze is shallow, so
 * the loader walks every nested array and object the candidate
 * carries and freezes each one before returning the top-level
 * reference.  Cycles are not a concern here because the validator
 * only ever builds acyclic structures (objects whose values are
 * primitives, arrays of primitives, or further frozen objects).
 */
const deepFreeze = <T>(value: T): T => {
  Object.freeze(value);
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return value;
  }
  for (const key of Reflect.ownKeys(value as object)) {
    if (typeof key !== "string") continue;
    const member = (value as Record<string, unknown>)[key];
    if (member !== null && typeof member === "object") {
      deepFreeze(member);
    }
  }
  return value;
};

// ---------------------------------------------------------------------------
// Public loader.
// ---------------------------------------------------------------------------

/**
 * Load an already-parsed JSON value as a closed `SettingsFile`.
 *
 * The loader is fail-closed: any deviation from the published
 * schema — wrong shape, wrong version, malformed defaults,
 * malformed override — throws a `SettingsLoadError` whose `code`
 * is the literal `"settings_invalid"` and whose `message` is a
 * fixed string.  No user input is echoed in the diagnostic, no
 * `cause` is forwarded, and the returned object is deeply frozen
 * so the daemon boundary cannot mutate it after construction.
 *
 * The loader performs no I/O and depends on nothing outside the
 * closed settings seam.  Callers (parser, file loader, daemon
 * boundary) are responsible for parsing the on-disk bytes, for
 * sizing limits, and for surfacing the categorical error.
 */
export const loadSettings = (input: unknown): SettingsFile => {
  // Shape check: must be a non-null object that is not an array.
  // Arrays are objects in JavaScript, so the array check has to
  // come before the generic object check.
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SettingsLoadError();
  }

  const candidate = input as Record<string, unknown>;

  // Version check: must be the literal `1`.  `===` is correct here
  // because `SETTINGS_SCHEMA_VERSION` is exported as `as const`
  // and the published type is the literal `1`.
  if (candidate["version"] !== SETTINGS_SCHEMA_VERSION) {
    throw new SettingsLoadError();
  }

  // Defaults check: must satisfy the closed `isSettingsDefaults`
  // predicate.  This catches missing fields, extra fields, wrong
  // value types, and Proxy / subclass shapes in one place.
  if (!isSettingsDefaults(candidate["defaults"])) {
    throw new SettingsLoadError();
  }

  // Overrides check: must be a real array; each element must
  // satisfy `validateOverride`.  A missing overrides field is
  // rejected (the schema requires it) but an empty array is
  // accepted.
  if (!Array.isArray(candidate["overrides"])) {
    throw new SettingsLoadError();
  }

  const validatedOverrides: SettingsOverride[] = [];
  for (const rawOverride of candidate["overrides"]) {
    validatedOverrides.push(validateOverride(rawOverride));
  }

  const defaults: SettingsDefaults = candidate["defaults"] as SettingsDefaults;

  // Assemble the frozen file.  The deep-freeze walks the
  // validated overrides array and freezes every nested array and
  // object, so callers cannot mutate the returned structure
  // through any path.
  const file: SettingsFile = deepFreeze({
    version: SETTINGS_SCHEMA_VERSION,
    defaults,
    overrides: validatedOverrides,
  });

  return file;
};
