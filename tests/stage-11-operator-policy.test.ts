/**
 * T04 — operator-only transport and authorization boundary.
 *
 * This suite pins the operator policy seam that lives BELOW the MCP
 * settings evaluator and routes the canonical operator RPC vocabulary
 * (`notes.get-view`, `notes.edit-preimage`, `notes.apply-edit`,
 * `notes.apply-undo`, `notes.create`, `notes.operation-status`,
 * `notes.operation-list`) through a distinct evaluator that enforces
 * operator identity, notebook policy, and lock-state hooks.
 *
 * The seam is the second half of the authorization boundary; the
 * first half (the canonical operator vocabulary, request/response
 * shapes, and method-only routing) is exercised by
 * `tests/stage-11-rpc-protocol-operator-vocabulary.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { OPERATOR_METHODS } from "../src/service/operator-methods.js";
import {
  createOperatorPolicy,
  authorizeOperatorMethod,
  isOperatorMethod,
  type OperatorAuthorizationContext,
  type OperatorPolicyDecision,
  type OperatorPolicyEvaluator,
  type OperatorPolicyProfile,
} from "../src/service/operator-policy.js";

describe("operator policy denial vocabulary", () => {
  it("echoes the categorical lock reason the evaluator returns", () => {
    // Finding 7: the seam could only ever say `permission_denied`, so a locked
    // target was indistinguishable from a permission problem.  The evaluator's
    // categorical reason now crosses the seam unchanged.
    const policy = createOperatorPolicy(() => ({ allowed: false, reason: "vault_locked" }));
    expect(authorizeOperatorMethod(policy, "notes.apply-edit")).toMatchObject({
      allowed: false,
      reason: "vault_locked",
    });
  });

  it("collapses a reason outside the closed vocabulary", () => {
    // Guard: an evaluator must not be able to forward arbitrary text as the
    // operator-facing code.
    const policy = createOperatorPolicy(
      () => ({ allowed: false, reason: "teapot" }) as unknown as OperatorPolicyDecision,
    );
    expect(authorizeOperatorMethod(policy, "notes.apply-edit")).toMatchObject({
      allowed: false,
      reason: "permission_denied",
    });
  });
});

function makeContext(
  overrides: Partial<OperatorAuthorizationContext> = {},
): OperatorAuthorizationContext {
  return {
    operatorUid: 1000,
    operatorGid: 1000,
    operatorGroupMembership: ["nookbridge-clients"],
    notebookPolicy: { notebookPath: "Projects", allow: true },
    noteLockState: { id: "note-1", locked: false },
    ...overrides,
  };
}

describe("operator policy — closed method vocabulary", () => {
  it("exposes exactly the canonical T00 operator RPC vocabulary", () => {
    expect(Array.from(OPERATOR_METHODS)).toEqual([
      "notes.get-view",
      "notes.edit-preimage",
      "notes.apply-edit",
      "notes.apply-undo",
      "notes.create",
      "notes.operation-status",
      "notes.operation-list",
      "notes.browse",
      "notes.search-operator",
    ]);
  });

  it("rejects alias method names that are NOT part of the canonical vocabulary", () => {
    expect(isOperatorMethod("notes.edit")).toBe(false);
    expect(isOperatorMethod("notes.undo")).toBe(false);
    expect(isOperatorMethod("notes.predict-next-revision")).toBe(false);
    expect(isOperatorMethod("notes.snapshot")).toBe(false);
  });

  it("rejects every existing non-operator RpcMethod", () => {
    expect(isOperatorMethod("notes.search")).toBe(false);
    expect(isOperatorMethod("notes.status")).toBe(false);
    expect(isOperatorMethod("notes.list_notebooks")).toBe(false);
    expect(isOperatorMethod("notes.get")).toBe(false);
    expect(isOperatorMethod("notes.update")).toBe(false);
    expect(isOperatorMethod("notes.append")).toBe(false);
    expect(isOperatorMethod("notes.delete")).toBe(false);
    expect(isOperatorMethod("notes.locked_note_proof")).toBe(false);
    expect(isOperatorMethod("notes.path_diagnostic")).toBe(false);
    expect(isOperatorMethod("notes.sync")).toBe(false);
  });

  it("rejects empty / non-string candidates", () => {
    expect(isOperatorMethod("")).toBe(false);
    expect(isOperatorMethod(undefined)).toBe(false);
    expect(isOperatorMethod(null)).toBe(false);
    expect(isOperatorMethod(42)).toBe(false);
  });
});

describe("operator policy — profile vocabulary", () => {
  it("exposes exactly the closed operator profile literal", () => {
    const profile: OperatorPolicyProfile = "operator";
    expect(profile).toBe("operator");
  });
});

describe("operator policy — authorization decisions", () => {
  it("admits an operator method when the evaluator returns allowed=true", () => {
    const evaluator: OperatorPolicyEvaluator = (method, ctx) => ({
      allowed: true,
      method,
      ...(ctx.notebookPolicy?.notebookPath !== undefined
        ? { notebookPath: ctx.notebookPolicy.notebookPath }
        : {}),
    });
    const policy = createOperatorPolicy(evaluator);
    const decision = authorizeOperatorMethod(policy, "notes.get-view", makeContext());
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.method).toBe("notes.get-view");
      expect(decision.notebookPath).toBe("Projects");
    }
  });

  it("denies an operator method categorically when the evaluator returns allowed=false", () => {
    const evaluator: OperatorPolicyEvaluator = (): OperatorPolicyDecision => ({
      allowed: false,
      reason: "permission_denied",
    });
    const policy = createOperatorPolicy(evaluator);
    const decision = authorizeOperatorMethod(policy, "notes.apply-edit", makeContext());
    expect(decision).toEqual({ allowed: false, reason: "permission_denied" });
  });

  it("denies every alias method name categorically (it is not in the vocabulary)", () => {
    const evaluator: OperatorPolicyEvaluator = (method): OperatorPolicyDecision => ({
      allowed: true,
      method,
    });
    const policy = createOperatorPolicy(evaluator);
    expect(authorizeOperatorMethod(policy, "notes.edit", makeContext())).toEqual({
      allowed: false,
      reason: "permission_denied",
    });
    expect(authorizeOperatorMethod(policy, "notes.undo", makeContext())).toEqual({
      allowed: false,
      reason: "permission_denied",
    });
    expect(authorizeOperatorMethod(policy, "notes.predict-next-revision", makeContext())).toEqual({
      allowed: false,
      reason: "permission_denied",
    });
    expect(authorizeOperatorMethod(policy, "notes.snapshot", makeContext())).toEqual({
      allowed: false,
      reason: "permission_denied",
    });
  });

  it("denies non-string and empty-string method names categorically", () => {
    const evaluator: OperatorPolicyEvaluator = (method): OperatorPolicyDecision => ({
      allowed: true,
      method,
    });
    const policy = createOperatorPolicy(evaluator);
    expect(authorizeOperatorMethod(policy, "", makeContext())).toEqual({
      allowed: false,
      reason: "permission_denied",
    });
    // Force non-string through unknown cast for the test.
    expect(authorizeOperatorMethod(policy, undefined as unknown as string, makeContext())).toEqual({
      allowed: false,
      reason: "permission_denied",
    });
  });

  it("never echoes the offending method name into the denial reason", () => {
    const evaluator: OperatorPolicyEvaluator = (): OperatorPolicyDecision => ({
      allowed: false,
      reason: "permission_denied",
    });
    const policy = createOperatorPolicy(evaluator);
    const decision: OperatorPolicyDecision = authorizeOperatorMethod(
      policy,
      "notes.apply-edit",
      makeContext(),
    );
    expect(decision).toEqual({ allowed: false, reason: "permission_denied" });
    if (!decision.allowed) {
      expect(decision.reason).not.toContain("apply-edit");
      expect(decision.reason).not.toContain("notes");
    }
  });

  it("forwards notebook policy and lock state to the evaluator", () => {
    const calls: Array<{ method: string; ctx: OperatorAuthorizationContext }> = [];
    const evaluator: OperatorPolicyEvaluator = (method, ctx) => {
      calls.push({ method, ctx });
      return { allowed: true, method };
    };
    const policy = createOperatorPolicy(evaluator);
    const ctx = makeContext({
      noteLockState: { id: "locked-note", locked: true },
      notebookPolicy: { notebookPath: "Secrets", allow: false },
    });
    authorizeOperatorMethod(policy, "notes.apply-edit", ctx);
    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe("notes.apply-edit");
    expect(calls[0]?.ctx.noteLockState?.locked).toBe(true);
    expect(calls[0]?.ctx.notebookPolicy?.allow).toBe(false);
  });

  it("denies when the evaluator throws (closed categorical denial)", () => {
    const evaluator: OperatorPolicyEvaluator = () => {
      throw new Error("hostile evaluator");
    };
    const policy = createOperatorPolicy(evaluator);
    expect(authorizeOperatorMethod(policy, "notes.create", makeContext())).toEqual({
      allowed: false,
      reason: "permission_denied",
    });
  });

  it("denies when no evaluator is attached (no allowlist-only admit path)", () => {
    const policy = createOperatorPolicy(undefined);
    expect(authorizeOperatorMethod(policy, "notes.get-view", makeContext())).toEqual({
      allowed: false,
      reason: "permission_denied",
    });
  });

  it("rejects when the policy itself is structurally invalid", () => {
    // Proxy / non-object policy is denied categorically.
    const hostile = { profile: "operator" } as unknown as Parameters<
      typeof authorizeOperatorMethod
    >[0];
    const result = authorizeOperatorMethod(hostile, "notes.get-view", makeContext());
    expect(result).toEqual({ allowed: false, reason: "permission_denied" });
  });
});
