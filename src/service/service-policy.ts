/**
 * Stage 7 Slice 1 — service-side readOnly authorization contract.
 *
 * This module is the small closed policy seam the Stage 7 Slice 1
 * service-side authorization work introduces.  It is intentionally
 * tiny:
 *
 *   - Pure: no filesystem, no socket, no daemon, no Notesnook, no
 *     parser, no JSON.  Every export is a pure function of its
 *     arguments and the frozen module-level state.
 *   - Closed: the supported profile vocabulary is exactly one
 *     literal — `"readOnly"`.  The allowed-method tuple is exactly
 *     the four read methods in published order.  Any future
 *     profile (`readWriteNoDelete`, `custom`) is out of scope for
 *     this slice and requires a Stage 7 Slice ≥ 2 amendment.
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

// Capture every mutable intrinsic used by this closed boundary before any
// caller can pollute a shared prototype.
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectIsFrozen = Object.isFrozen;
const objectSetPrototypeOf = Object.setPrototypeOf;
const arrayIsArray = Array.isArray;
const reflectOwnKeys = Reflect.ownKeys;

// ---------------------------------------------------------------------------
// Closed profile vocabulary.
// ---------------------------------------------------------------------------

/**
 * The closed set of permission profiles the service policy engine
 * understands in this slice.  Only `readOnly` is part of the Slice 1
 * contract; any other profile literal would require a Stage 7 Slice
 * ≥ 2 amendment and is rejected at the type level.
 */
export type ServicePolicyProfile = "readOnly";

/**
 * The published list of supported profile identifiers, frozen so a
 * hostile module mutation cannot widen the public profile catalogue.
 */
const SERVICE_POLICY_PROFILES_LIST: ReadonlyArray<ServicePolicyProfile> = (() => {
  const arr: ServicePolicyProfile[] = ["readOnly"];
  objectSetPrototypeOf(arr, null);
  return objectFreeze(arr) as ReadonlyArray<ServicePolicyProfile>;
})();

export const SERVICE_POLICY_PROFILES: ReadonlyArray<ServicePolicyProfile> =
  SERVICE_POLICY_PROFILES_LIST;

/**
 * Narrow a raw string to the closed `ServicePolicyProfile` union.
 * Returns `true` only for the literal `"readOnly"`.  Anything else —
 * case variants, similar-looking strings, the empty string — is
 * `false`.
 */
export function isServicePolicyProfile(value: unknown): value is ServicePolicyProfile {
  return value === "readOnly";
}

// ---------------------------------------------------------------------------
// Closed read method allowlist.
//
// This tuple is the exact published Stage 6 Slice 2 RPC allowlist,
// in published order.  It mirrors `SERVICE_CONFIG_READ_POLICY` in
// the service-config loader but is the *authorization* source of
// truth, not the configuration schema.  Keeping the two in lockstep
// is intentional: the deployment cannot ship a config that admits a
// method the policy would deny, and the policy cannot admit a method
// the config rejects.
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

// ---------------------------------------------------------------------------
// Policy type and factory.
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
}

/**
 * Build the canonical `readOnly` service policy.  This is the only
 * factory the Slice 1 contract exposes; any future profile
 * (`readWriteNoDelete`, `custom`) requires a Stage 7 Slice ≥ 2
 * amendment.
 *
 * The returned policy is frozen on a null prototype, with the
 * allowlist tuple frozen too, so a hostile caller cannot widen the
 * surface after construction.
 */
export function createReadOnlyServicePolicy(): ServicePolicy {
  const policy = objectCreate(null) as {
    profile: ServicePolicyProfile;
    allowedMethods: ReadonlyArray<RpcMethod>;
  };
  policy.profile = "readOnly";
  policy.allowedMethods = READ_ONLY_ALLOWED_METHODS;
  return objectFreeze(policy) as ServicePolicy;
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
 * (e.g. `notes.create`, `notes.delete`).  At runtime the handler
 * passes a parsed `RpcMethod`, so the type system still prevents
 * a hostile caller from supplying an unknown method through the
 * normal RPC entry point.
 *
 * Decision rules:
 *   1. If `method` is exactly one of the four read methods in the
 *      allowlist, return `{ allowed: true, method }`.
 *   2. Otherwise — including side-effecting methods, unknown
 *      methods, the empty string, non-strings, and lookalike
 *      variants — return `{ allowed: false, reason:
 *      "permission_denied" }`.  The decision record never echoes
 *      the offending method name into the reason.
 *
 * The returned decision is frozen on a null prototype so a hostile
 * downstream consumer cannot mutate the result.
 */
export function authorizeServiceMethod(
  policy: ServicePolicy,
  method: string,
): ServicePolicyDecision {
  // Defensive: a hostile caller could in principle pass a
  // non-policy object.  We re-validate the profile and the
  // allowlist through captured intrinsics, the same pattern the
  // RPC protocol uses, so a Proxy / inherited-getter trap cannot
  // smuggle a widened policy past the boundary.
  if (!isReadOnlyPolicy(policy)) {
    const deny = objectCreate(null) as { allowed: false; reason: ServicePolicyDenialReason };
    deny.allowed = false;
    deny.reason = "permission_denied";
    return objectFreeze(deny) as ServicePolicyDecision;
  }

  if (typeof method !== "string") {
    const deny = objectCreate(null) as { allowed: false; reason: ServicePolicyDenialReason };
    deny.allowed = false;
    deny.reason = "permission_denied";
    return objectFreeze(deny) as ServicePolicyDecision;
  }

  // O(n) walk over the closed four-element allowlist.  The
  // allowlist is too small to justify a Set, and a Set would
  // leak the method names through its iterator / `for..of`
  // surface during hostile probing.
  for (let index = 0; index < READ_ONLY_ALLOWED_METHODS.length; index += 1) {
    const candidate = READ_ONLY_ALLOWED_METHODS[index];
    if (candidate === method) {
      const allow = objectCreate(null) as { allowed: true; method: RpcMethod };
      allow.allowed = true;
      allow.method = candidate;
      return objectFreeze(allow) as ServicePolicyDecision;
    }
  }

  const deny = objectCreate(null) as { allowed: false; reason: ServicePolicyDenialReason };
  deny.allowed = false;
  deny.reason = "permission_denied";
  return objectFreeze(deny) as ServicePolicyDecision;
}

/**
 * Narrow a candidate to the canonical readOnly policy shape.
 * Returns `true` only when the candidate is the exact policy
 * object produced by `createReadOnlyServicePolicy` (frozen, null
 * prototype, profile `"readOnly"`, allowlist equal to the closed
 * four).  Any deviation is a hostile or stale policy and is
 * rejected by `authorizeServiceMethod` with a `permission_denied`
 * decision.
 */
function isReadOnlyPolicy(value: unknown): value is ServicePolicy {
  try {
    if (value === null || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (!objectIsFrozen(record) || objectGetPrototypeOf(record) !== null) return false;
    if (reflectOwnKeys(record).length !== 2) return false;
    const profile = record.profile;
    if (profile !== "readOnly") return false;
    const allowed = record.allowedMethods;
    if (
      !arrayIsArray(allowed) ||
      !objectIsFrozen(allowed) ||
      objectGetPrototypeOf(allowed) !== null
    ) {
      return false;
    }
    if (allowed.length !== READ_ONLY_ALLOWED_METHODS.length) return false;
    for (let index = 0; index < allowed.length; index += 1) {
      if (allowed[index] !== READ_ONLY_ALLOWED_METHODS[index]) return false;
    }
    return true;
  } catch {
    return false;
  }
}
