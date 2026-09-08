/**
 * Stage 10 Task 6 — route RPC method authorization through the settings
 * evaluator.
 *
 * The service policy seam is extended so a policy can be constructed
 * with an optional evaluator closure (returned by
 * `createSettingsEvaluator`).  When an evaluator is present, every
 * `authorizeServiceMethod` call additionally consults the evaluator
 * with the method's mapped `SettingsOperation` and the caller's
 * resolved `notebookPath` / `noteTitle`.  The original allowlist
 * gate is never weakened: the evaluator is added ON TOP of it, never
 * in place of it.
 *
 * The contract pinned in this suite:
 *
 *   1. `methodToSettingsOperation` returns the closed map for every
 *      published RpcMethod and `undefined` for any other input
 *      string (including side-effecting-but-unknown strings,
 *      empty strings, and non-strings).
 *   2. `authorizeServiceMethod(policy, method)` still works with no
 *      third argument when the policy has no evaluator.  This is
 *      backward-compatible with every Stage 7 call site.
 *   3. When the policy has an evaluator AND the allowlist admits the
 *      method, the evaluator's decision is consulted: a denied
 *      decision short-circuits to `{ allowed: false, reason:
 *      "permission_denied" }` regardless of the allowlist admit.
 *   4. The allowlist gate still applies on top of the evaluator:
 *      a method that is NOT in the allowlist is denied
 *      categorically with `permission_denied`, even when the
 *      evaluator would otherwise allow it.  `notes.delete` remains
 *      structurally absent.
 *   5. The denial reason is the closed categorical
 *      `"permission_denied"` token.  `matchedBy.pattern` and
 *      `overrideIndex` from the evaluator's decision are NEVER
 *      echoed into the reason.
 *   6. The optional `settingsContext` argument is forwarded to the
 *      evaluator as `{ notebookPath, noteTitle }`.  When
 *      `settingsContext` is undefined, the evaluator is still
 *      consulted but with an empty ctx (both fields undefined),
 *      and the evaluator returns the default decision.  The
 *      authorization call does not throw.
 *
 * No I/O, no Notesnook imports, no daemon imports.  Every
 * assertion runs against the pure `service-policy.ts` module.
 */

import { describe, expect, it } from "vitest";

import {
  authorizeServiceMethod,
  createCustomServicePolicy,
  createReadOnlyServicePolicy,
  createReadWriteNoDeleteServicePolicy,
  methodToSettingsOperation,
  type ServicePolicy,
  type ServicePolicyDecision,
} from "../src/service/service-policy.js";
import type { SettingsOperation } from "../src/settings/settings-types.js";
import type { SettingsDecision } from "../src/settings/settings-evaluator.js";

// ---------------------------------------------------------------------------
// Synthetic evaluator fixtures.
// ---------------------------------------------------------------------------

/**
 * Build a stub evaluator closure.  The closure records every call
 * so the test can assert which (op, ctx) tuples the policy
 * forwarded, and returns a programmable decision.
 *
 * The closure surface mirrors `createSettingsEvaluator`'s return
 * type but is NOT the same factory — it is a small, dependency-free
 * stand-in.  The policy module never calls `compileGlob`, so a
 * pure closure is sufficient to exercise the policy-evaluator
 * wiring.
 */
type EvaluatorCall = { op: SettingsOperation; ctx: { notebookPath?: string; noteTitle?: string } };

const makeStubEvaluator = (
  decision: SettingsDecision,
): {
  readonly calls: ReadonlyArray<EvaluatorCall>;
  readonly evaluator: (
    op: SettingsOperation,
    ctx: { notebookPath?: string; noteTitle?: string },
  ) => SettingsDecision;
} => {
  const calls: EvaluatorCall[] = [];
  const evaluator = (
    op: SettingsOperation,
    ctx: { notebookPath?: string; noteTitle?: string },
  ): SettingsDecision => {
    calls.push({ op, ctx });
    return decision;
  };
  return { calls, evaluator };
};

/**
 * Build a policy with the readWriteNoDelete profile plus an
 * injected evaluator.  The factory's third argument is optional,
 * so this exercises the evaluator wiring on the canonical
 * readWriteNoDelete shape.
 */
const makePolicyWithEvaluator = (
  evaluator: (
    op: SettingsOperation,
    ctx: { notebookPath?: string; noteTitle?: string },
  ) => SettingsDecision,
): ServicePolicy => {
  // The factory currently does not accept an evaluator — this is
  // the Stage 10 Task 6 wiring change.  We assemble the policy
  // shape directly via `createReadWriteNoDeleteServicePolicy` and
  // add the evaluator through a structural augmentation that the
  // test file casts to `ServicePolicy`.  Once the factory accepts
  // the third argument, this helper should be migrated.
  const policy = createReadWriteNoDeleteServicePolicy();
  // The policy is frozen; we use Object.assign to project a new
  // policy object that the policy module's evaluator-aware
  // authorization will read.  The new object is itself frozen
  // and null-prototype to match the closed policy contract.
  const augmented = Object.assign(Object.create(null), policy, { evaluator });
  Object.freeze(augmented);
  return augmented as unknown as ServicePolicy;
};

// ---------------------------------------------------------------------------
// methodToSettingsOperation — closed map.
// ---------------------------------------------------------------------------

describe("service policy — methodToSettingsOperation returns the closed map", () => {
  it("maps the four read methods to read", () => {
    expect(methodToSettingsOperation("notes.search")).toBe("read");
    expect(methodToSettingsOperation("notes.status")).toBe("read");
    expect(methodToSettingsOperation("notes.list_notebooks")).toBe("read");
    expect(methodToSettingsOperation("notes.get")).toBe("read");
  });

  it("maps notes.create to create", () => {
    expect(methodToSettingsOperation("notes.create")).toBe("create");
  });

  it("maps notes.append and notes.update to edit", () => {
    expect(methodToSettingsOperation("notes.append")).toBe("edit");
    expect(methodToSettingsOperation("notes.update")).toBe("edit");
  });

  it("maps notes.sync to read", () => {
    expect(methodToSettingsOperation("notes.sync")).toBe("read");
  });

  it("returns undefined for notes.delete", () => {
    expect(methodToSettingsOperation("notes.delete")).toBeUndefined();
  });

  it("returns undefined for any other unknown method string", () => {
    expect(methodToSettingsOperation("notes.lol")).toBeUndefined();
    expect(methodToSettingsOperation("")).toBeUndefined();
    expect(methodToSettingsOperation("notes")).toBeUndefined();
    expect(methodToSettingsOperation("Notes.Search")).toBeUndefined();
    expect(methodToSettingsOperation("NOTES.SEARCH")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — no evaluator.
// ---------------------------------------------------------------------------

describe("service policy — authorizeServiceMethod without an evaluator", () => {
  it("works without a third argument on a policy that has no evaluator", () => {
    const policy = createReadOnlyServicePolicy();
    const decision: ServicePolicyDecision = authorizeServiceMethod(policy, "notes.search");
    expect(decision).toEqual({ allowed: true, method: "notes.search" });
  });

  it("denies an unknown method with permission_denied when no evaluator is configured", () => {
    const policy = createReadOnlyServicePolicy();
    const decision = authorizeServiceMethod(policy, "notes.create");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("permission_denied");
    }
  });

  it("admits notes.sync on readWriteNoDelete without an evaluator", () => {
    const policy = createReadWriteNoDeleteServicePolicy();
    expect(authorizeServiceMethod(policy, "notes.sync")).toEqual({
      allowed: true,
      method: "notes.sync",
    });
  });
});

// ---------------------------------------------------------------------------
// Evaluator wiring — allowed decision.
// ---------------------------------------------------------------------------

describe("service policy — evaluator with an allowed decision", () => {
  it("forwards (op, ctx) to the evaluator and allows when the allowlist also admits", () => {
    const { calls, evaluator } = makeStubEvaluator({ allowed: true });
    const policy = makePolicyWithEvaluator(evaluator);
    const decision = authorizeServiceMethod(policy, "notes.search", {
      notebookPath: "Personal",
      noteTitle: "Hello",
    });
    expect(decision).toEqual({ allowed: true, method: "notes.search" });
    expect(calls).toEqual([{ op: "read", ctx: { notebookPath: "Personal", noteTitle: "Hello" } }]);
  });

  it("maps notes.create to create when forwarding to the evaluator", () => {
    const { calls, evaluator } = makeStubEvaluator({ allowed: true });
    const policy = makePolicyWithEvaluator(evaluator);
    authorizeServiceMethod(policy, "notes.create", { notebookPath: "Personal" });
    expect(calls).toEqual([{ op: "create", ctx: { notebookPath: "Personal" } }]);
  });

  it("maps notes.append and notes.update to edit when forwarding to the evaluator", () => {
    const { calls, evaluator } = makeStubEvaluator({ allowed: true });
    const policy = makePolicyWithEvaluator(evaluator);
    authorizeServiceMethod(policy, "notes.append", {
      notebookPath: "Personal",
      noteTitle: "Hello",
    });
    authorizeServiceMethod(policy, "notes.update", {
      notebookPath: "Personal",
      noteTitle: "Hello",
    });
    expect(calls).toEqual([
      { op: "edit", ctx: { notebookPath: "Personal", noteTitle: "Hello" } },
      { op: "edit", ctx: { notebookPath: "Personal", noteTitle: "Hello" } },
    ]);
  });

  it("maps notes.sync to read when forwarding to the evaluator", () => {
    const { calls, evaluator } = makeStubEvaluator({ allowed: true });
    const policy = makePolicyWithEvaluator(evaluator);
    authorizeServiceMethod(policy, "notes.sync");
    expect(calls).toEqual([{ op: "read", ctx: {} }]);
  });

  it("forwards an empty ctx when settingsContext is undefined", () => {
    const { calls, evaluator } = makeStubEvaluator({ allowed: true });
    const policy = makePolicyWithEvaluator(evaluator);
    authorizeServiceMethod(policy, "notes.search");
    expect(calls).toEqual([{ op: "read", ctx: {} }]);
  });
});

// ---------------------------------------------------------------------------
// Evaluator wiring — denied decision short-circuits the allowlist.
// ---------------------------------------------------------------------------

describe("service policy — evaluator with a denied decision", () => {
  it("denies with permission_denied when the evaluator denies an allowlisted method", () => {
    const { evaluator } = makeStubEvaluator({ allowed: false });
    const policy = makePolicyWithEvaluator(evaluator);
    const decision = authorizeServiceMethod(policy, "notes.search", {
      notebookPath: "Personal",
    });
    expect(decision).toEqual({ allowed: false, reason: "permission_denied" });
  });

  it("denies notes.create when the evaluator denies, even though create is in the allowlist", () => {
    const { evaluator } = makeStubEvaluator({ allowed: false });
    const policy = makePolicyWithEvaluator(evaluator);
    const decision = authorizeServiceMethod(policy, "notes.create", {
      notebookPath: "Personal",
    });
    expect(decision).toEqual({ allowed: false, reason: "permission_denied" });
  });

  it("denies notes.delete when the evaluator denies — delete remains structurally absent", () => {
    const { evaluator } = makeStubEvaluator({ allowed: false });
    // Even with a custom allowlist that would contain
    // `notes.delete`, the policy seam must NEVER admit the method:
    // the allowlist gate runs BEFORE the evaluator.  We use a
    // custom policy whose allowlist is empty (delete is dropped
    // before construction) and a stub evaluator that would
    // otherwise allow everything.
    const policy = createCustomServicePolicy(["notes.delete"]);
    const augmented = Object.assign(Object.create(null), policy, { evaluator });
    Object.freeze(augmented);
    const decision = authorizeServiceMethod(augmented as unknown as ServicePolicy, "notes.delete");
    expect(decision).toEqual({ allowed: false, reason: "permission_denied" });
  });
});

// ---------------------------------------------------------------------------
// Reason never echoes matchedBy pattern or overrideIndex.
// ---------------------------------------------------------------------------

describe("service policy — denial reason never echoes evaluator internals", () => {
  it("never echoes matchedBy.pattern into the denial reason", () => {
    const evaluator = (
      _op: SettingsOperation,
      _ctx: { notebookPath?: string; noteTitle?: string },
    ): SettingsDecision => ({
      allowed: false,
      matchedBy: { overrideIndex: 7, pattern: "Personal/Secret/Confidential" },
    });
    const policy = makePolicyWithEvaluator(evaluator);
    const decision = authorizeServiceMethod(policy, "notes.search", {
      notebookPath: "Personal",
      noteTitle: "Hello",
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("permission_denied");
      // The reason is the closed categorical token.  It must not
      // echo the pattern string, the override index, the method
      // name, or any notebook id.
      expect(decision.reason).not.toContain("Personal");
      expect(decision.reason).not.toContain("Secret");
      expect(decision.reason).not.toContain("Confidential");
      expect(decision.reason).not.toContain("7");
      expect(decision.reason).not.toContain("overrideIndex");
      expect(decision.reason).not.toContain("matchedBy");
      expect(decision.reason).not.toContain("search");
    }
  });

  it("the decision record carries no matchedBy field on denial", () => {
    const evaluator = (
      _op: SettingsOperation,
      _ctx: { notebookPath?: string; noteTitle?: string },
    ): SettingsDecision => ({
      allowed: false,
      matchedBy: { overrideIndex: 0, pattern: "*" },
    });
    const policy = makePolicyWithEvaluator(evaluator);
    const decision = authorizeServiceMethod(policy, "notes.get", {
      notebookPath: "Personal",
    });
    expect(decision).toEqual({ allowed: false, reason: "permission_denied" });
    // No matchedBy leaks past the policy boundary.
    expect(Object.prototype.hasOwnProperty.call(decision, "matchedBy")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Allowlist gate runs before the evaluator.
// ---------------------------------------------------------------------------

describe("service policy — allowlist gate precedes the evaluator", () => {
  it("denies notes.create under readOnly before the evaluator is consulted", () => {
    const { calls, evaluator } = makeStubEvaluator({ allowed: true });
    const policy = Object.assign(Object.create(null), createReadOnlyServicePolicy(), {
      evaluator,
    });
    Object.freeze(policy);
    const decision = authorizeServiceMethod(policy as unknown as ServicePolicy, "notes.create", {
      notebookPath: "Personal",
    });
    expect(decision).toEqual({ allowed: false, reason: "permission_denied" });
    // The evaluator must NEVER have been called — the allowlist
    // gate short-circuited before the policy consulted the
    // evaluator.
    expect(calls).toEqual([]);
  });

  it("does not allow notes.delete even when the evaluator would allow it", () => {
    const { evaluator } = makeStubEvaluator({ allowed: true });
    // Use a custom policy with `notes.delete` dropped before
    // construction.  The evaluator is irrelevant — the method
    // never reaches it.
    const policy = createCustomServicePolicy(["notes.delete"]);
    const augmented = Object.assign(Object.create(null), policy, { evaluator });
    Object.freeze(augmented);
    const decision = authorizeServiceMethod(augmented as unknown as ServicePolicy, "notes.delete");
    expect(decision).toEqual({ allowed: false, reason: "permission_denied" });
  });
});

// ---------------------------------------------------------------------------
// No-context calls — backward compatibility for status / list_notebooks.
// ---------------------------------------------------------------------------

describe("service policy — no-context calls do not throw", () => {
  it("admits notes.status with no context when the evaluator allows by default", () => {
    const { calls, evaluator } = makeStubEvaluator({ allowed: true });
    const policy = makePolicyWithEvaluator(evaluator);
    const decision = authorizeServiceMethod(policy, "notes.status");
    expect(decision).toEqual({ allowed: true, method: "notes.status" });
    expect(calls).toEqual([{ op: "read", ctx: {} }]);
  });

  it("admits notes.list_notebooks with no context when the evaluator allows by default", () => {
    const { calls, evaluator } = makeStubEvaluator({ allowed: true });
    const policy = makePolicyWithEvaluator(evaluator);
    const decision = authorizeServiceMethod(policy, "notes.list_notebooks");
    expect(decision).toEqual({ allowed: true, method: "notes.list_notebooks" });
    expect(calls).toEqual([{ op: "read", ctx: {} }]);
  });

  it("does not throw when the evaluator denies a no-context call", () => {
    const { evaluator } = makeStubEvaluator({ allowed: false });
    const policy = makePolicyWithEvaluator(evaluator);
    expect(() => authorizeServiceMethod(policy, "notes.status")).not.toThrow();
    expect(authorizeServiceMethod(policy, "notes.status")).toEqual({
      allowed: false,
      reason: "permission_denied",
    });
  });
});
