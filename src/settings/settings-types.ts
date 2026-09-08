/**
 * Stage 10 — settings schema types.
 *
 * This module is the small closed type seam the Stage 10 settings
 * work introduces.  It is intentionally tiny:
 *
 *   - Pure: no filesystem, no socket, no daemon, no Notesnook, no
 *     parser, no JSON.  Every export is a pure type, a pure value,
 *     or a pure predicate of its argument and the frozen module-level
 *     state.
 *   - Closed: the supported operation vocabulary is exactly four
 *     literals — `"read"`, `"edit"`, `"create"`, `"delete"`.  The
 *     `SettingsDefaults` record admits *only* those four keys; any
 *     other key (including case variants, the empty string, or
 *     lookalike strings) is structurally refused by the predicate.
 *   - Frozen: the schema version, the operation-key tuple, and the
 *     predicates themselves are exported on a null-prototype surface
 *     so a hostile caller cannot widen the public contract after
 *     import.  The `SETTINGS_OPERATION_KEYS` tuple is built as a real
 *     array, then null-prototyped and frozen so `Array.isArray` still
 *     recognises it.
 *   - Defence-in-depth only: this module is the *type* layer.  The
 *     parser, the file loader, and the daemon boundary are the
 *     runtime lines of defence.  This module's predicates narrow an
 *     untrusted `unknown` to the published unions and nothing else.
 *
 * Any future widening (a fifth operation, an additional defaults
 * field, a richer override shape) requires an explicit Stage 10
 * amendment and an explicit decision record.
 */

// Capture every mutable intrinsic used by this closed boundary before any
// caller can pollute a shared prototype.  This mirrors the pattern used
// by the Stage 7 service-policy seam.
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectSetPrototypeOf = Object.setPrototypeOf;
const reflectOwnKeys = Reflect.ownKeys;

// ---------------------------------------------------------------------------
// Schema version.
// ---------------------------------------------------------------------------

/**
 * The closed schema version this Stage 10 module understands.  Exported
 * as `as const` so the exported value's type is the literal `1` and a
 * hostile caller cannot assign a wider numeric type to it.  Any future
 * version bump requires a new module and an explicit Stage 10
 * amendment.
 */
export const SETTINGS_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Operation vocabulary.
// ---------------------------------------------------------------------------

/**
 * The closed set of operations a settings override or a defaults
 * record may speak about.  Every literal here is part of the published
 * contract; any future operation (e.g. `"share"`, `"export"`,
 * `"sync"`) requires an explicit Stage 10 amendment and is rejected at
 * the type level.
 */
export type SettingsOperation = "read" | "edit" | "create" | "delete";

/**
 * The published list of supported operation identifiers, frozen at the
 * type level via `as const` and at runtime via `Object.freeze` on a
 * null prototype.  Order is part of the contract: the four keys appear
 * here exactly as `["read", "edit", "create", "delete"]` and the
 * `isSettingsDefaults` predicate requires the same order over the
 * incoming candidate's enumerable own keys.
 */
const SETTINGS_OPERATION_KEYS_RAW: readonly ["read", "edit", "create", "delete"] = (() => {
  // Build a real array (so `Array.isArray` recognises it) and then
  // null the prototype and freeze it.  A pure `Object.create(null)`
  // does not pass `Array.isArray`, so any consumer that validates the
  // tuple shape would see a non-array.  This hand-rolled builder
  // keeps the array surface frozen and null-prototype while still
  // being a proper array, and the `as const` cast preserves the
  // tuple-of-literals type at the type level.
  const arr = ["read", "edit", "create", "delete"] as const;
  // The `as const` literal array is `readonly [...]`; cast through a
  // mutable local so we can null the prototype and freeze it without
  // re-typing.
  const mutable = arr as unknown as SettingsOperation[];
  objectSetPrototypeOf(mutable, null);
  return objectFreeze(mutable) as unknown as readonly ["read", "edit", "create", "delete"];
})();

export const SETTINGS_OPERATION_KEYS: readonly ["read", "edit", "create", "delete"] =
  SETTINGS_OPERATION_KEYS_RAW;

/**
 * Narrow an arbitrary `unknown` to the closed `SettingsOperation`
 * union.  Returns `true` only for one of the four published literals.
 * Anything else — case variants, similar-looking strings, the empty
 * string, non-strings, `null`, objects, arrays, numbers, booleans —
 * is `false`.
 */
export function isSettingsOperation(value: unknown): value is SettingsOperation {
  return value === "read" || value === "edit" || value === "create" || value === "delete";
}

// ---------------------------------------------------------------------------
// Defaults.
// ---------------------------------------------------------------------------

/**
 * The closed defaults record.  Every key is one of the four
 * published operations; every value is a strict `boolean`.  The
 * record is `Readonly` so a hostile caller cannot mutate the seam
 * after construction.
 */
export type SettingsDefaults = Readonly<Record<SettingsOperation, boolean>>;

/**
 * Narrow an arbitrary `unknown` to the closed `SettingsDefaults`
 * shape.  The contract is:
 *
 *   - `value` must be a non-null object whose prototype is either
 *     `Object.prototype` or `null`.  A Proxy / accessor-backed
 *     candidate is rejected if its descriptor shape is not a plain
 *     data descriptor with `enumerable: true`.
 *   - The candidate's enumerable own keys must be exactly the four
 *     published operation keys, in the published order
 *     (`["read", "edit", "create", "delete"]`).
 *   - Every value must be a strict `boolean`.  Any truthy /
 *     falsy-coercible type (`0`, `1`, `""`, `"true"`, `null`,
 *     `undefined`, `NaN`, objects, arrays) is rejected.
 *   - Inherited keys (a polluted `Object.prototype`, a Proxy trap,
 *     a subclass) are rejected because we only inspect own keys.
 */
export function isSettingsDefaults(value: unknown): value is SettingsDefaults {
  if (value === null || typeof value !== "object") return false;

  try {
    const prototype = objectGetPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;

    const keys = reflectOwnKeys(value);
    // The candidate must carry exactly 4 own keys and no Symbol
    // keys.  Anything else (missing key, extra key, Symbol-keyed
    // smuggling) is rejected.  We then require each indexed own key
    // to match the published operation literal at the same
    // position.  Plain JavaScript objects iterate own string keys in
    // insertion order, and a Proxy trap that scrambles order is
    // rejected here because the published literal at the same index
    // must match the candidate's key at that index.
    if (keys.length !== SETTINGS_OPERATION_KEYS.length) return false;
    for (let index = 0; index < SETTINGS_OPERATION_KEYS.length; index += 1) {
      const expected = SETTINGS_OPERATION_KEYS[index];
      const candidateKey = keys[index];
      if (typeof candidateKey !== "string" || candidateKey !== expected) {
        return false;
      }
      const descriptor = objectGetOwnPropertyDescriptor(value, candidateKey);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "boolean"
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Override shape.
// ---------------------------------------------------------------------------

/**
 * The closed per-target override shape.  Every field is optional —
 * a caller may scope an override to a single notebook, a single note,
 * a single operation, or any combination of those — and the resulting
 * shape is `Readonly` so the daemon boundary cannot mutate the
 * resolved override after it is read.
 *
 * The id lists are `readonly string[]`.  No Notesnook import lives
 * here: this module is the *type* layer and id lists are pure
 * strings until a downstream module (parser / loader / resolver)
 * narrows them against the published vocabulary.
 */
export type SettingsOverride = Readonly<{
  notebooks?: readonly string[];
  notes?: readonly string[];
  read?: boolean;
  edit?: boolean;
  create?: boolean;
  delete?: boolean;
}>;

// ---------------------------------------------------------------------------
// File shape.
// ---------------------------------------------------------------------------

/**
 * The closed settings file shape.  `version` is the literal `1`
 * (matching `SETTINGS_SCHEMA_VERSION`); `defaults` is the closed
 * `SettingsDefaults` record; `overrides` is the read-only list of
 * `SettingsOverride` entries.  Every field is `Readonly` so the
 * loaded file is immutable once the loader hands it back.
 */
export type SettingsFile = Readonly<{
  version: 1;
  defaults: SettingsDefaults;
  overrides: readonly SettingsOverride[];
}>;

// `objectCreate` is captured above but unused here; silence the
// "declared but never read" warning by referencing the binding once
// in a way that does not affect runtime behaviour.
void objectCreate;
