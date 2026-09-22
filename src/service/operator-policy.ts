/**
 * T04 — operator authorization policy seam.
 *
 * The canonical operator RPC vocabulary
 * (`notes.get-view`, `notes.edit-preimage`, `notes.apply-edit`,
 * `notes.apply-undo`, `notes.create`, `notes.operation-status`,
 * `notes.operation-list`) is **not** evaluated by the MCP socket's
 * settings evaluator.  Operator methods are routed here, to a
 * distinct policy evaluator that enforces three things:
 *
 *   (a) operator identity — the caller's uid / gid / supplementary
 *       groups are forwarded as context so a per-host evaluator can
 *       decide whether the operator is a member of the operator
 *       group.  The operator-server transport performs the
 *       peer-credential check at the socket layer; this seam is
 *       the application-layer complement that consults the same
 *       identity evidence plus notebook-policy / lock-state hooks.
 *
 *   (b) notebook policy — the active notebook's allow / deny
 *       decision (e.g. notebook-scoped `Settings` records) is
 *       forwarded to the evaluator so the seam can deny a
 *       per-notebook edit without ever exposing the notebook id or
 *       title in the denial reason.
 *
 *   (c) lock-state hooks — locked notes reject `notes.apply-edit`,
 *       `notes.apply-undo`, and `notes.create` with categorical
 *       `permission_denied` (the canonical `locked` rejection lives
 *       upstream; the operator seam is the second line of defence).
 *
 * The seam is intentionally tiny and pure:
 *
 *   - No filesystem, no socket, no daemon, no Notesnook, no parser,
 *     no JSON.  Every export is a pure function of its arguments
 *     and the frozen module-level state.
 *   - Closed: the supported profile vocabulary is exactly one
 *     literal — `"operator"`.  The closed method vocabulary lives
 *     in `./operator-methods.ts`; this module imports it and never
 *     widens it.
 *   - Categorical: the only denial reason is the closed
 *     `"permission_denied"` token.  The reason never echoes the
 *     offending method name, the operator's uid/gid/groups, the
 *     notebook id, the notebook path, or the note id.
 *   - Frozen: every returned decision is frozen on a null prototype
 *     so a hostile caller cannot widen or mutate the decision.
 *   - Defence-in-depth only: this policy does NOT replace the
 *     parser's `invalid_request` rejection of unknown methods on
 *     the wire.  The parser is the first line of defence; this seam
 *     is the second line.
 */

import { isOperatorMethod, OPERATOR_METHODS, type OperatorMethod } from "./operator-methods.js";

const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectIsFrozen = Object.isFrozen;
const reflectOwnKeys = Reflect.ownKeys;

// ---------------------------------------------------------------------------
// Closed profile vocabulary.
// ---------------------------------------------------------------------------

/**
 * The closed set of operator policy profiles.  Exactly one literal
 * is supported; any future widening (a separate `operatorReadOnly`
 * or `operatorReadWrite` profile) requires a T04 amendment and an
 * explicit decision record.
 */
export type OperatorPolicyProfile = "operator";

export const OPERATOR_POLICY_PROFILES: ReadonlyArray<OperatorPolicyProfile> = Object.freeze([
  "operator",
] as const);

// ---------------------------------------------------------------------------
// Authorization context.
// ---------------------------------------------------------------------------

/**
 * Per-notebook policy decision forwarded to the evaluator.  The
 * `allow` flag is the source of truth; the `notebookPath` is
 * informational only and never echoes into a denial reason.
 */
export interface OperatorNotebookPolicy {
  readonly notebookPath: string;
  readonly allow: boolean;
}

/**
 * Note lock state forwarded to the evaluator.  The seam is the
 * second line of defence for locked-note protection; the upstream
 * `notes.apply-edit` handler remains the canonical rejector.
 */
export interface OperatorNoteLockState {
  readonly id: string;
  readonly locked: boolean;
}

/**
 * The closed authorization context the seam forwards to the
 * evaluator.  Every field is optional because global operation
 * requests (`notes.operation-list`) do not have a resolved note
 * or notebook yet; the seam still forwards the operator identity
 * so the evaluator can refuse a global operation to a peer who
 * has been temporarily de-scoped.
 */
export interface OperatorAuthorizationContext {
  readonly operatorUid?: number;
  readonly operatorGid?: number;
  readonly operatorGroupMembership?: ReadonlyArray<string>;
  readonly notebookPolicy?: OperatorNotebookPolicy;
  readonly noteLockState?: OperatorNoteLockState;
}

// ---------------------------------------------------------------------------
// Decision types.
// ---------------------------------------------------------------------------

export type OperatorPolicyDenialReason = "permission_denied" | "vault_locked";

/**
 * The categorical success decision the seam emits on admit.
 * `notebookPath` is the only contextual echo; the operator uid /
 * gid / groups are intentionally not surfaced.
 */
export interface OperatorPolicyAdmitDecision {
  readonly allowed: true;
  readonly method: OperatorMethod;
  readonly notebookPath?: string;
}

/**
 * The categorical denial decision.  Only the closed reason token
 * crosses the seam; the offending method name, the operator
 * identity, the notebook id, and the note id are intentionally
 * absent.
 */
export interface OperatorPolicyDenyDecision {
  readonly allowed: false;
  readonly reason: OperatorPolicyDenialReason;
}

export type OperatorPolicyDecision = OperatorPolicyAdmitDecision | OperatorPolicyDenyDecision;

// ---------------------------------------------------------------------------
// Evaluator seam.
// ---------------------------------------------------------------------------

/**
 * The signature the operator seam forwards to.  The evaluator
 * receives the canonical operator method and the closed
 * authorization context; the return value is a closed categorical
 * decision.  Any thrown error collapses to a categorical denial
 * (the seam never echoes the throw).
 */
export type OperatorPolicyEvaluator = (
  method: OperatorMethod,
  context: OperatorAuthorizationContext,
) => OperatorPolicyDecision;

// ---------------------------------------------------------------------------
// Policy type.
// ---------------------------------------------------------------------------

/**
 * The closed operator policy.  `profile` is the literal
 * `"operator"`; `evaluator` is the application-layer gate that
 * enforces identity, notebook policy, and lock-state hooks.  The
 * object is frozen on a null prototype so a hostile caller cannot
 * widen the surface or replace the evaluator after construction.
 */
export interface OperatorPolicy {
  readonly profile: OperatorPolicyProfile;
  readonly evaluator?: OperatorPolicyEvaluator;
}

// ---------------------------------------------------------------------------
// Factories.
// ---------------------------------------------------------------------------

/**
 * Build the canonical operator policy.  When no evaluator is
 * supplied, the seam denies every method categorically — the
 * operator endpoint must NEVER admit a request without an explicit
 * operator-side evaluator; this is the closed default.
 */
export function createOperatorPolicy(evaluator?: OperatorPolicyEvaluator): OperatorPolicy {
  const policy = objectCreate(null) as {
    profile: OperatorPolicyProfile;
    evaluator?: OperatorPolicyEvaluator;
  };
  policy.profile = "operator";
  if (evaluator !== undefined) policy.evaluator = evaluator;
  return objectFreeze(policy) as OperatorPolicy;
}

// ---------------------------------------------------------------------------
// Authorization entry point.
// ---------------------------------------------------------------------------

/**
 * Authorize a candidate operator method against a closed
 * {@link OperatorPolicy}.  The candidate is consumed as a `string`
 * (not the parsed `OperatorMethod` union) so the seam is a safe
 * place to experiment with arbitrary hostile method names in tests.
 *
 * Decision rules:
 *
 *   1. If the policy is structurally invalid (Proxy trap, polluted
 *      prototype, profile literal other than `"operator"`), the
 *      decision is `{ allowed: false, reason: "permission_denied" }`.
 *   2. If `method` is not one of the canonical operator literals
 *      (per {@link isOperatorMethod}), the decision is a categorical
 *      denial.  Aliases (`notes.edit`, `notes.undo`,
 *      `notes.predict-next-revision`, `notes.snapshot`) and any
 *      unknown / empty / non-string candidate are denied here.
 *   3. If no evaluator is attached, the decision is a categorical
 *      denial (no allowlist-only admit path; the operator seam is
 *      evaluator-gated by design).
 *   4. If the evaluator returns a categorical denial, the seam
 *      echoes the categorical denial verbatim.
 *   5. If the evaluator throws, the seam returns a categorical
 *      denial (the throw is never echoed into the decision).
 *   6. Otherwise, the seam returns the admit decision verbatim
 *      with the canonical operator method and the (optional)
 *      notebook path forwarded.
 *
 * The returned decision is frozen on a null prototype so a hostile
 * downstream consumer cannot mutate the result.
 */
export function authorizeOperatorMethod(
  policy: OperatorPolicy,
  method: string,
  context: OperatorAuthorizationContext = {},
): OperatorPolicyDecision {
  // Defensive: a hostile caller could pass a non-policy object.
  // Re-validate the policy's closed shape through captured
  // intrinsics so a Proxy / inherited-getter trap cannot smuggle a
  // widened policy past the boundary.
  const evaluator = inspectOperatorPolicy(policy);
  if (evaluator === null) return denyOperatorPolicyDecision();

  // Defence in depth: even a hostile evaluator that tries to admit
  // a non-operator method cannot slip past — the seam rejects
  // every method outside the canonical vocabulary before the
  // evaluator is consulted.
  if (typeof method !== "string" || !isOperatorMethod(method)) {
    return denyOperatorPolicyDecision();
  }

  // The canonical operator vocabulary is bound to a separate
  // evaluator; there is no allowlist-only admit path.
  const fn = evaluator;
  if (fn === undefined) return denyOperatorPolicyDecision();

  let decision: OperatorPolicyDecision;
  try {
    decision = fn(method, context);
  } catch {
    return denyOperatorPolicyDecision();
  }
  if (decision === null || typeof decision !== "object") {
    return denyOperatorPolicyDecision();
  }
  const record = decision as unknown as Record<string, unknown>;
  if (record.allowed === true) {
    const returnedMethod = record.method;
    if (typeof returnedMethod !== "string" || !isOperatorMethod(returnedMethod)) {
      return denyOperatorPolicyDecision();
    }
    const notebookPath =
      typeof record.notebookPath === "string" && record.notebookPath.length > 0
        ? (record.notebookPath as string)
        : undefined;
    const admit = objectCreate(null) as {
      allowed: true;
      method: OperatorMethod;
      notebookPath?: string;
    };
    admit.allowed = true;
    admit.method = returnedMethod;
    if (notebookPath !== undefined) admit.notebookPath = notebookPath;
    return objectFreeze(admit) as OperatorPolicyAdmitDecision;
  }
  // Only the closed denial vocabulary may cross the seam: an evaluator that
  // returns an unrecognised reason gets the default rather than forwarding
  // arbitrary text to the operator.
  const rawReason = record.reason;
  const reason: OperatorPolicyDenialReason =
    rawReason === "vault_locked" || rawReason === "permission_denied"
      ? rawReason
      : "permission_denied";
  return denyOperatorPolicyDecision(reason);
}

function denyOperatorPolicyDecision(
  reason: OperatorPolicyDenialReason = "permission_denied",
): OperatorPolicyDenyDecision {
  const deny: OperatorPolicyDenyDecision = { allowed: false, reason };
  return objectFreeze(deny) as OperatorPolicyDenyDecision;
}

/**
 * Inspect a candidate `OperatorPolicy`.  Returns the bound
 * evaluator when the candidate is a structurally-valid closed
 * policy, otherwise `null`.
 *
 * The inspector accepts only the literal `"operator"` profile and
 * rejects anything else.  The closed set of policy keys is the
 * pair `("profile", "evaluator?")` — any other shape (extra keys,
 * missing profile, inherited prototype) is denied.
 */
function inspectOperatorPolicy(value: unknown): OperatorPolicyEvaluator | undefined | null {
  try {
    if (value === null || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (!objectIsFrozen(record) || objectGetPrototypeOf(record) !== null) return null;
    const keys = reflectOwnKeys(record);
    if (keys.length !== 1 && keys.length !== 2) return null;
    const profile = record.profile;
    if (profile !== "operator") return null;
    if (keys.length === 2) {
      const keyTwo = keys[1];
      if (typeof keyTwo !== "string" || keyTwo !== "evaluator") return null;
      const evaluatorDescriptor = Object.getOwnPropertyDescriptor(record, "evaluator");
      if (
        evaluatorDescriptor === undefined ||
        evaluatorDescriptor.enumerable !== true ||
        !("value" in evaluatorDescriptor) ||
        typeof evaluatorDescriptor.value !== "function"
      ) {
        return null;
      }
      return evaluatorDescriptor.value as OperatorPolicyEvaluator;
    }
    return undefined;
  } catch {
    return null;
  }
}

/**
 * Re-export the canonical operator vocabulary and the membership
 * predicate so callers that already import from `operator-policy`
 * do not need a second import line.
 */
export { OPERATOR_METHODS, isOperatorMethod };
