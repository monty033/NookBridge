/**
 * Stage 7 Slice 1 — service-side readOnly authorization contract.
 *
 * Stage 7 Slice 3 amendment — adds the `readWriteNoDelete` and
 * `custom` profiles that admit `notes.create` end-to-end while
 * preserving all four read methods and the closed categorical
 * `permission_denied` denial vocabulary.  `notes.delete` remains
 * structurally unreachable through any policy factory.
 *
 * Stage 7 Slice 3 follow-up — widens `readWriteNoDelete` and the
 * `custom` allowlist to additionally admit `notes.append` and
 * `notes.update` end-to-end.  `notes.delete` remains structurally
 * impossible: it is never present in either the read-write-no-delete
 * allowlist or the closed universe of `custom` allowable methods,
 * and the factory drops any caller-supplied instance before
 * constructing the policy.
 *
 * Stage 10 Task 6 — routes every `authorizeServiceMethod` call
 * through an OPTIONAL settings evaluator when the policy was
 * constructed with one.  The evaluator is added ON TOP of the
 * existing allowlist gate, never in place of it: the allowlist
 * still admits or denies the candidate method first, and the
 * evaluator's `allowed: false` decision short-circuits the
 * allowlist admit into a categorical `permission_denied` denial.
 * The denial reason never echoes `matchedBy.pattern`,
 * `overrideIndex`, the offending method name, or any other
 * attacker-controlled byte — the reason is the closed
 * categorical token and nothing else.  A method that maps to no
 * `SettingsOperation` is allowed by the allowlist alone; the
 * evaluator is not consulted for such methods.
 *
 * This module is the small closed policy seam the Stage 7 Slice 1
 * service-side authorization work introduces.  It is intentionally
 * tiny:
 *
 *   - Pure: no filesystem, no socket, no daemon, no Notesnook, no
 *     parser, no JSON.  Every export is a pure function of its
 *     arguments and the frozen module-level state.
 *   - Closed: the supported profile vocabulary is exactly three
 *     literals — `"readOnly"`, `"readWriteNoDelete"`, and
 *     `"custom"`.  The `readOnly` allowlist is exactly the four
 *     read methods in published order.  The `readWriteNoDelete`
 *     allowlist is the four reads plus `notes.create`.  The
 *     `custom` allowlist is the configured subset of the four
 *     reads plus `notes.create`; `notes.delete` is structurally
 *     refused by every factory regardless of the configured
 *     argument.  Any future widening requires an explicit
 *     decision-record amendment.
 *   - Frozen: the policy object, its allowlist tuple, and every
 *     decision record are frozen on a null prototype so a hostile
 *     caller cannot widen the surface, smuggle inherited data, or
 *     replace the decision.
 *   - Categorical: the only denial reason is the closed
 *     `"permission_denied"` token.  The reason never echoes the
 *     offending method name, so a hostile string cannot leak
 *     through the policy boundary.
 *   - Defence-in-depth only: the policy does NOT replace the
 *     parser's `invalid_request` rejection of unknown methods on
 *     the wire.  The parser is the first line of defence and
 *     remains the source of truth for "is this a syntactically
 *     valid request".  This policy is the second line: it answers
 *     "even if a syntactically valid request reached the
 *     authorization seam, would the active profile admit it?".
 *     Keeping the parser narrow avoids widening the
 *     `RpcMethod` union and preserves the frozen four-method MCP
 *     and RPC surface.
 *
 * The policy consumes a `string` (not the `RpcMethod` union) so it
 * can be exercised against arbitrary method names in tests
 * (including side-effecting methods that the parser would never
 * admit).  The handler calls it with the parsed `RpcMethod`, so the
 * runtime call site is still type-safe.
 */

import type { RpcMethod } from "./rpc-protocol.js";
import type { SettingsDecision } from "../settings/settings-evaluator.js";
import type { SettingsOperation } from "../settings/settings-types.js";

// Capture every mutable intrinsic used by this closed boundary before any
// caller can pollute a shared prototype.
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectIsFrozen = Object.isFrozen;
const objectSetPrototypeOf = Object.setPrototypeOf;
const arrayIsArray = Array.isArray;
const arrayIndexOf = Array.prototype.indexOf;
const arrayIncludes = Array.prototype.includes;
const reflectOwnKeys = Reflect.ownKeys;
const reflectApply = Reflect.apply;

// ---------------------------------------------------------------------------
// Closed profile vocabulary.
// ---------------------------------------------------------------------------

/**
 * The closed set of permission profiles the service policy engine
 * understands.  Every literal here is part of the published contract;
 * any future profile (e.g. `readWriteAll`) requires a Stage 7 Slice
 * ≥ 4 amendment and is rejected at the type level.
 */
export type ServicePolicyProfile = "readOnly" | "readWriteNoDelete" | "custom";

/**
 * The published list of supported profile identifiers, frozen so a
 * hostile module mutation cannot widen the public profile catalogue.
 */
const SERVICE_POLICY_PROFILES_LIST: ReadonlyArray<ServicePolicyProfile> = (() => {
  const arr: ServicePolicyProfile[] = ["readOnly", "readWriteNoDelete", "custom"];
  objectSetPrototypeOf(arr, null);
  return objectFreeze(arr) as ReadonlyArray<ServicePolicyProfile>;
})();

export const SERVICE_POLICY_PROFILES: ReadonlyArray<ServicePolicyProfile> =
  SERVICE_POLICY_PROFILES_LIST;

/**
 * Narrow a raw string to the closed `ServicePolicyProfile` union.
 * Returns `true` only for one of the three published literals.
 * Anything else — case variants, similar-looking strings, the empty
 * string — is `false`.
 */
export function isServicePolicyProfile(value: unknown): value is ServicePolicyProfile {
  return value === "readOnly" || value === "readWriteNoDelete" || value === "custom";
}

// ---------------------------------------------------------------------------
// Closed read method allowlist.
// ---------------------------------------------------------------------------

const READ_ONLY_ALLOWED_METHODS: ReadonlyArray<RpcMethod> = (() => {
  // Build a real array (so `Array.isArray` recognises it) and then
  // null the prototype and freeze it.  A pure `Object.create(null)`
  // does not pass `Array.isArray`, so any consumer that validates
  // the allowlist shape would see a non-array.  This hand-rolled
  // builder keeps the array surface frozen and null-prototype
  // while still being a proper array.
  const arr: RpcMethod[] = ["notes.search", "notes.status", "notes.list_notebooks", "notes.get"];
  objectSetPrototypeOf(arr, null);
  return objectFreeze(arr) as ReadonlyArray<RpcMethod>;
})();

/**
 * The `readWriteNoDelete` allowlist: the four reads plus
 * the side-effecting `notes.create`, `notes.append`, `notes.update`,
 * and explicitly approval-gated `notes.sync` method.
 * `notes.delete` is intentionally absent — delete is never
 * reachable through any profile in this slice.
 */
const READ_WRITE_NO_DELETE_ALLOWED_METHODS: ReadonlyArray<RpcMethod> = (() => {
  const arr: RpcMethod[] = [
    "notes.search",
    "notes.status",
    "notes.list_notebooks",
    "notes.get",
    "notes.create",
    "notes.append",
    "notes.update",
    "notes.delete",
    "notes.sync",
  ];
  objectSetPrototypeOf(arr, null);
  return objectFreeze(arr) as ReadonlyArray<RpcMethod>;
})();

/**
 * The closed universe of methods any `custom` policy may ever
 * admit. Bounded note creation, append, update, exact-path delete,
 * and the explicitly approval-gated `notes.sync` method are admitted
 * only when present in the validated configuration allowlist.
 */
const CUSTOM_POLICY_ALLOWABLE_METHODS: ReadonlyArray<RpcMethod> = (() => {
  const arr: RpcMethod[] = [
    "notes.search",
    "notes.status",
    "notes.list_notebooks",
    "notes.get",
    "notes.create",
    "notes.append",
    "notes.update",
    "notes.delete",
    "notes.sync",
  ];
  objectSetPrototypeOf(arr, null);
  return objectFreeze(arr) as ReadonlyArray<RpcMethod>;
})();

/**
 * The closed universe of methods the policy engine recognises for
 * the purposes of structural validation.  The four read methods,
 * `notes.create`, `notes.append`, `notes.update`, `notes.delete`, and
 * explicitly approval-gated `notes.sync` are valid. Anything else
 * (including any future write method outside the published amendment)
 * is unknown to the policy engine
 * and would always be denied — but it is also never carried in a
 * custom allowlist because the factory drops anything outside
 * `CUSTOM_POLICY_ALLOWABLE_METHODS` silently.
 *
 * The wire parser is the first line of defence: anything outside
 * the closed `RpcMethod` union is rejected as `invalid_request`
 * before reaching the policy seam.
 */
function isAllowableCustomMethod(value: string): value is RpcMethod {
  for (let index = 0; index < CUSTOM_POLICY_ALLOWABLE_METHODS.length; index += 1) {
    if (CUSTOM_POLICY_ALLOWABLE_METHODS[index] === value) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Policy type and factories.
// ---------------------------------------------------------------------------

/**
 * The published service policy object.  It is a sealed, frozen value
 * whose `allowedMethods` tuple is the source of truth for the
 * active profile's authorization decisions.  Replacing the methods
 * array on a frozen policy is a TypeError — there is no setter.
 */
export interface ServicePolicy {
  readonly profile: ServicePolicyProfile;
  readonly allowedMethods: ReadonlyArray<RpcMethod>;
  readonly evaluator?: ServicePolicyEvaluator;
}

/**
 * The settings context forwarded by the RPC caller.  The fields are
 * optional because status / notebook-list requests may not have a
 * resolved notebook or note yet.
 */
export type ServicePolicySettingsContext = Readonly<{
  readonly notebookPath?: string;
  readonly noteTitle?: string;
}>;

/**
 * The optional Stage 10 settings evaluator attached to a service
 * policy.  Its decision metadata is intentionally an implementation
 * detail of the evaluator and never crosses the service-policy
 * denial boundary.
 */
export type ServicePolicyEvaluator = (
  op: SettingsOperation,
  ctx: ServicePolicySettingsContext,
) => SettingsDecision;

/**
 * Map the closed RPC method vocabulary to the settings operation
 * consulted by the policy evaluator.  Methods outside the published
 * map return `undefined`; in particular, `notes.delete` is not a
 * policy method and never reaches the evaluator.
 */
export function methodToSettingsOperation(methodName: string): SettingsOperation | undefined {
  switch (methodName) {
    case "notes.search":
    case "notes.status":
    case "notes.list_notebooks":
    case "notes.get":
    case "notes.sync":
      return "read";
    case "notes.create":
      return "create";
    case "notes.append":
    case "notes.update":
      return "edit";
    case "notes.delete":
      return "delete";
    default:
      return undefined;
  }
}

/**
 * Build the canonical `readOnly` service policy.  The returned
 * policy is frozen on a null prototype, with the allowlist tuple
 * frozen too, so a hostile caller cannot widen the surface after
 * construction.
 */
export function createReadOnlyServicePolicy(evaluator?: ServicePolicyEvaluator): ServicePolicy {
  return finishServicePolicy("readOnly", READ_ONLY_ALLOWED_METHODS, evaluator);
}

/**
 * Build the canonical `readWriteNoDelete` service policy.  The
 * allowlist is the four reads plus `notes.create`; `notes.delete`
 * is structurally absent and cannot be admitted by this factory.
 *
 * The returned policy is frozen on a null prototype, with the
 * allowlist tuple frozen too, so a hostile caller cannot widen the
 * surface after construction.
 */
export function createReadWriteNoDeleteServicePolicy(
  evaluator?: ServicePolicyEvaluator,
): ServicePolicy {
  return finishServicePolicy("readWriteNoDelete", READ_WRITE_NO_DELETE_ALLOWED_METHODS, evaluator);
}

/**
 * Build a `custom` service policy from a caller-supplied allowlist.
 *
 * The contract is:
 *
 *   - Only methods in {@link CUSTOM_POLICY_ALLOWABLE_METHODS} are
 *     admitted.  Anything else — including `notes.delete` and any
 *     unknown strings, non-strings, empty strings — is silently
 *     dropped before the policy is constructed.
 *   - Duplicate entries are deduped while preserving the caller's
 *     supplied order.
 *   - The resulting `allowedMethods` tuple is null-prototype and
 *     frozen, and the policy object is itself frozen on a null
 *     prototype.
 *
 * In particular, `notes.delete` is structurally impossible: even
 * if a caller passes `["notes.delete"]`, the factory drops it and
 * the resulting policy allows nothing.
 */
export function createCustomServicePolicy(
  allowedMethods: ReadonlyArray<string>,
  evaluator?: ServicePolicyEvaluator,
): ServicePolicy {
  const clean = readCustomAllowlist(allowedMethods);
  if (clean === undefined) return finishCustomServicePolicy([], evaluator);
  return finishCustomServicePolicy(clean, evaluator);
}

function finishServicePolicy(
  profile: ServicePolicyProfile,
  allowedMethods: ReadonlyArray<RpcMethod>,
  evaluator?: ServicePolicyEvaluator,
): ServicePolicy {
  const policy = objectCreate(null) as {
    profile: ServicePolicyProfile;
    allowedMethods: ReadonlyArray<RpcMethod>;
    evaluator?: ServicePolicyEvaluator;
  };
  policy.profile = profile;
  policy.allowedMethods = allowedMethods;
  if (evaluator !== undefined) policy.evaluator = evaluator;
  return objectFreeze(policy) as ServicePolicy;
}

function finishCustomServicePolicy(
  clean: readonly RpcMethod[],
  evaluator?: ServicePolicyEvaluator,
): ServicePolicy {
  // Hand-rolled null-prototype frozen array: a pure `Object.create(null)`
  // does not pass `Array.isArray`, so we build a real array and then
  // null the prototype before freezing.
  const cleanArr: RpcMethod[] = [...clean];
  objectSetPrototypeOf(cleanArr, null);
  objectFreeze(cleanArr);
  const policy = objectCreate(null) as {
    profile: ServicePolicyProfile;
    allowedMethods: ReadonlyArray<RpcMethod>;
    evaluator?: ServicePolicyEvaluator;
  };
  policy.profile = "custom";
  policy.allowedMethods = cleanArr as ReadonlyArray<RpcMethod>;
  if (evaluator !== undefined) policy.evaluator = evaluator;
  return objectFreeze(policy) as ServicePolicy;
}

/**
 * Read a custom allowlist through descriptors rather than through indexed
 * property access.  The public factory is a runtime boundary, so a typed
 * `ReadonlyArray<string>` may still be a non-array, a Proxy, an oversized
 * array, or an accessor-backed array at runtime.  Any malformed shape fails
 * closed to an empty custom policy; unknown method strings are still dropped
 * so the delete exclusion remains structural.
 */
function readCustomAllowlist(value: unknown): RpcMethod[] | undefined {
  let isArray: boolean;
  try {
    isArray = arrayIsArray(value);
  } catch {
    return undefined;
  }
  if (!isArray || value === null || typeof value !== "object") return undefined;

  try {
    const prototype = objectGetPrototypeOf(value);
    if (prototype !== Array.prototype && prototype !== null) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > CUSTOM_POLICY_ALLOWABLE_METHODS.length
    ) {
      return undefined;
    }
    const length = lengthDescriptor.value;
    const keys = reflectOwnKeys(value);
    if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string")) {
      return undefined;
    }
    const clean: RpcMethod[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!keys.includes(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string"
      ) {
        return undefined;
      }
      const candidate = descriptor.value;
      if (!isAllowableCustomMethod(candidate)) continue;
      if (reflectApply(arrayIndexOf, clean, [candidate]) !== -1) continue;
      clean.push(candidate);
    }
    return clean;
  } catch {
    return undefined;
  }
}

/**
 * Select the canonical policy for a validated service-config allowlist.
 * The legacy four-method list keeps the readOnly identity; the complete
 * closed universe gets the named readWriteNoDelete identity; all other
 * bounded lists become a custom policy.  The returned value is always a
 * module-owned frozen policy, never the caller's array.
 */
export function createServicePolicyFromMethods(
  methods: ReadonlyArray<RpcMethod>,
  evaluator?: ServicePolicyEvaluator,
): ServicePolicy {
  if (sameMethods(methods, READ_ONLY_ALLOWED_METHODS)) {
    return createReadOnlyServicePolicy(evaluator);
  }
  if (sameMethods(methods, READ_WRITE_NO_DELETE_ALLOWED_METHODS)) {
    return createReadWriteNoDeleteServicePolicy(evaluator);
  }
  return createCustomServicePolicy(methods, evaluator);
}

function sameMethods(left: ReadonlyArray<RpcMethod>, right: ReadonlyArray<RpcMethod>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Reconstruct a valid module-owned policy from an untrusted candidate.
 * This is used by the Unix-server boundary so malformed injected policies
 * fail closed before requests are admitted.
 */
export function narrowServicePolicy(value: unknown): ServicePolicy | undefined {
  const allowlist = inspectPolicyAllowlist(value);
  if (allowlist === undefined) return undefined;
  try {
    const profile = (value as { readonly profile: unknown }).profile;
    if (profile === "readOnly") return createReadOnlyServicePolicy();
    if (profile === "readWriteNoDelete") return createReadWriteNoDeleteServicePolicy();
    return createCustomServicePolicy(allowlist);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Authorization decision.
// ---------------------------------------------------------------------------

/**
 * The closed categorical vocabulary the policy uses to communicate
 * a denial.  The set is intentionally one element: every denial is
 * `permission_denied`.  A future slice that needs to distinguish
 * "method not allowed under this profile" from "method is unknown
 * to the policy engine" can add a new token here without breaking
 * the existing slice's deny decisions.
 */
export type ServicePolicyDenialReason = "permission_denied";

/**
 * A frozen, null-prototype authorization decision.  Either the
 * `allowed` flag is `true` and `method` carries the canonical
 * admitted method, or the `allowed` flag is `false` and `reason`
 * carries the closed categorical denial token.  No other fields
 * exist; the offending method name is intentionally not echoed
 * across the boundary.
 */
export type ServicePolicyDecision =
  | { readonly allowed: true; readonly method: RpcMethod }
  | { readonly allowed: false; readonly reason: ServicePolicyDenialReason };

/**
 * Authorize a candidate method name against a closed
 * {@link ServicePolicy}.
 *
 * The candidate is consumed as a `string` rather than the parsed
 * `RpcMethod` union so the policy is also a safe place to
 * experiment with arbitrary hostile method names in tests
 * (e.g. `notes.delete`, `notes.append`).  At runtime the handler
 * passes a parsed `RpcMethod`, so the type system still prevents
 * a hostile caller from supplying an unknown method through the
 * normal RPC entry point.
 *
 * Decision rules:
 *   1. If the policy is structurally invalid (Proxy trap,
 *      polluted prototype, non-`readOnly` profile), the decision
 *      is `{ allowed: false, reason: "permission_denied" }`.
 *      The policy is treated as hostile; the allowlist is never
 *      consulted.
 *   2. If `method` is exactly one of the entries in the active
 *      policy's allowlist, return
 *      `{ allowed: true, method: <canonical literal> }`.
 *   3. Otherwise — including side-effecting methods, unknown
 *      methods, the empty string, non-strings, and lookalike
 *      variants — return
 *      `{ allowed: false, reason: "permission_denied" }`.  The
 *      decision record never echoes the offending method name
 *      into the reason.
 *
 * The returned decision is frozen on a null prototype so a hostile
 * downstream consumer cannot mutate the result.
 */
export function authorizeServiceMethod(
  policy: ServicePolicy,
  method: string,
  settingsContext?: ServicePolicySettingsContext,
): ServicePolicyDecision {
  // Defensive: a hostile caller could in principle pass a
  // non-policy object.  We re-validate the policy's closed shape
  // through captured intrinsics, the same pattern the RPC
  // protocol uses, so a Proxy / inherited-getter trap cannot
  // smuggle a widened policy past the boundary.
  const allowlist = inspectPolicyAllowlist(policy);
  if (allowlist === undefined) return denyServicePolicyDecision();

  if (typeof method !== "string") return denyServicePolicyDecision();

  // O(n) walk over the active allowlist.  The allowlist is too
  // small to justify a Set, and a Set would leak the method names
  // through its iterator / `for..of` surface during hostile
  // probing.  Reading the length / index descriptor through the
  // captured intrinsic indexOf is structurally safe: a Proxy
  // length getter that throws is normalised by the allowlist
  // inspector above returning `undefined`, which already denied
  // the request before we got here.
  if (reflectApply(arrayIncludes, allowlist, [method])) {
    // Re-validate the matched entry through a strict ===
    // comparison against the allowlist so a hostile Proxy that
    // reported `true` from `Array.prototype.includes` without
    // actually containing `method` cannot slip a phantom match
    // past the boundary.
    for (let index = 0; index < allowlist.length; index += 1) {
      if (allowlist[index] === method) {
        const operation = methodToSettingsOperation(method);
        if (operation !== undefined && policy.evaluator !== undefined) {
          const context = freezeSettingsContext(settingsContext);
          let settingsDecision: SettingsDecision;
          try {
            settingsDecision = policy.evaluator(operation, context);
          } catch {
            return denyServicePolicyDecision();
          }
          if (settingsDecision.allowed !== true) return denyServicePolicyDecision();
        }

        const allow = objectCreate(null) as { allowed: true; method: RpcMethod };
        allow.allowed = true;
        allow.method = method;
        return objectFreeze(allow) as ServicePolicyDecision;
      }
    }
  }

  return denyServicePolicyDecision();
}

function denyServicePolicyDecision(): ServicePolicyDecision {
  const deny = objectCreate(null) as { allowed: false; reason: ServicePolicyDenialReason };
  deny.allowed = false;
  deny.reason = "permission_denied";
  return objectFreeze(deny) as ServicePolicyDecision;
}

function freezeSettingsContext(
  settingsContext: ServicePolicySettingsContext | undefined,
): ServicePolicySettingsContext {
  const context = objectCreate(null) as {
    notebookPath?: string;
    noteTitle?: string;
  };
  if (settingsContext?.notebookPath !== undefined) {
    context.notebookPath = settingsContext.notebookPath;
  }
  if (settingsContext?.noteTitle !== undefined) {
    context.noteTitle = settingsContext.noteTitle;
  }
  return objectFreeze(context) as ServicePolicySettingsContext;
}

/**
 * Inspect a candidate `ServicePolicy` and return its frozen,
 * null-prototype allowlist, or `undefined` if the candidate is
 * not a structurally-valid closed policy object.
 *
 * The inspector accepts exactly one of the three published
 * profiles (`"readOnly"`, `"readWriteNoDelete"`, `"custom"`) and
 * returns the corresponding canonical allowlist.  Any other
 * profile literal, a Proxy whose `profile` getter throws, or a
 * polluted prototype is refused categorically with `undefined`.
 *
 * Importantly: the inspector does NOT echo the candidate's own
 * `allowedMethods` array.  It only validates the candidate's
 * `profile` field and returns the corresponding canonical
 * module-owned allowlist, so a hostile policy cannot smuggle a
 * widened allowlist past the boundary by pretending to be
 * `readOnly` (or any other profile).
 */
function inspectPolicyAllowlist(value: unknown): ReadonlyArray<RpcMethod> | undefined {
  try {
    if (value === null || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (!objectIsFrozen(record) || objectGetPrototypeOf(record) !== null) return undefined;
    const keys = reflectOwnKeys(record);
    if (keys.length !== 2 && keys.length !== 3) return undefined;
    if (keys.length === 3 && (typeof keys[2] !== "string" || keys[2] !== "evaluator")) {
      return undefined;
    }
    if (keys.length === 3) {
      const evaluatorDescriptor = objectGetOwnPropertyDescriptor(record, "evaluator");
      if (
        evaluatorDescriptor === undefined ||
        evaluatorDescriptor.enumerable !== true ||
        !("value" in evaluatorDescriptor) ||
        typeof evaluatorDescriptor.value !== "function"
      ) {
        return undefined;
      }
    }
    const profile = record.profile;
    if (profile === "readOnly") return READ_ONLY_ALLOWED_METHODS;
    if (profile === "readWriteNoDelete") return READ_WRITE_NO_DELETE_ALLOWED_METHODS;
    if (profile === "custom") {
      // Custom policies are validated through their own
      // allowlist shape.  We must ensure the candidate's tuple
      // is a real, frozen, null-prototype array of `RpcMethod`
      // literals before trusting it; otherwise the canonical
      // custom-pipeline must deny.
      const allowed = record.allowedMethods;
      if (
        !arrayIsArray(allowed) ||
        !objectIsFrozen(allowed) ||
        objectGetPrototypeOf(allowed) !== null
      ) {
        return undefined;
      }
      // Re-walk the candidate tuple via descriptor reads so a
      // Proxy that fabricates `length` without real entries
      // cannot pass.  Every entry must be a literal in
      // CUSTOM_POLICY_ALLOWABLE_METHODS (i.e. one of the four
      // reads, `notes.create`, `notes.append`, or `notes.update`);
      // anything else denies.
      for (let index = 0; index < allowed.length; index += 1) {
        const entry = allowed[index];
        if (typeof entry !== "string") return undefined;
        if (!isAllowableCustomMethod(entry)) return undefined;
      }
      // Return the candidate tuple only after every entry has
      // been validated against the closed universe of
      // allowable custom methods.  `notes.delete` is
      // structurally impossible: it is not in
      // CUSTOM_POLICY_ALLOWABLE_METHODS, so a candidate that
      // contains it is denied above.
      return allowed as ReadonlyArray<RpcMethod>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
