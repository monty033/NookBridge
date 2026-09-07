/**
 * Stage 7 Slice 1/3 — service-side permission authorization contract.
 *
 * This suite exercises the small closed policy contract introduced for
 * Stage 7 Slice 1 and Slice 3.  It is intentionally focused on the *policy seam*
 * itself, not on parser or handler integration.  Integration is
 * verified separately by re-running the existing Stage 5 RPC handler
 * suite, which must continue to pass unchanged.
 *
 * The contract pinned here:
 *
 *   1. The supported permission profiles are the literals
 *      `"readOnly"`, `"readWriteNoDelete"`, and `"custom"`.
 *   2. The four current read methods — `notes.search`,
 *      `notes.status`, `notes.list_notebooks`, `notes.get` — are the
 *      only methods the `readOnly` policy admits.  Each of them
 *      returns `{ allowed: true, method }` from
 *      `authorizeServiceMethod`.
 *   3. Any other method name — including side-effecting methods
 *      (`notes.create`, `notes.update`, `notes.delete`,
 *      `notes.append`) and anything that does not appear in the
 *      readOnly allowlist — is denied categorically.  The denial
 *      result is `{ allowed: false, reason: "permission_denied" }`
 *      and never echoes the offending method name into the error
 *      message.
 *   4. The policy object is frozen, the allowlist tuple is frozen,
 *      and the decision record is frozen so a hostile caller cannot
 *      mutate the seam after construction.
 *   5. The decision record is the only thing that crosses the policy
 *      boundary; the decision reason is a closed categorical
 *      vocabulary, not a free-form string.
 *
 * The policy is intentionally a *closed* tuple: any future widening
 * requires a later Stage 7 amendment and an explicit decision record.
 */

import { describe, expect, it } from "vitest";

import {
  SERVICE_POLICY_PROFILES,
  authorizeServiceMethod,
  createReadOnlyServicePolicy,
  createReadWriteNoDeleteServicePolicy,
  isServicePolicyProfile,
  type ServicePolicy,
  type ServicePolicyDecision,
} from "../src/service/service-policy.js";

// ---------------------------------------------------------------------------
// Closed profile vocabulary.
// ---------------------------------------------------------------------------

describe("service policy — closed profile vocabulary", () => {
  it("exposes exactly the three supported profiles in the published profile list", () => {
    expect(Array.from(SERVICE_POLICY_PROFILES)).toEqual([
      "readOnly",
      "readWriteNoDelete",
      "custom",
    ]);
  });

  it("accepts the literal 'readOnly' as a supported profile", () => {
    expect(isServicePolicyProfile("readOnly")).toBe(true);
  });

  it("rejects every other profile string as not a supported profile", () => {
    expect(isServicePolicyProfile("readWriteNoDelete")).toBe(true);
    expect(isServicePolicyProfile("custom")).toBe(true);
    expect(isServicePolicyProfile("")).toBe(false);
    expect(isServicePolicyProfile("readonly")).toBe(false);
    expect(isServicePolicyProfile("READONLY")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Factory contract.
// ---------------------------------------------------------------------------

describe("service policy — readOnly factory contract", () => {
  it("returns a frozen policy with the closed readOnly profile identifier", () => {
    const policy: ServicePolicy = createReadOnlyServicePolicy();
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.profile).toBe("readOnly");
  });

  it("publishes the exact four read methods in the published order", () => {
    const policy = createReadOnlyServicePolicy();
    expect(policy.allowedMethods).toEqual([
      "notes.search",
      "notes.status",
      "notes.list_notebooks",
      "notes.get",
    ]);
  });

  it("freezes the allowlist tuple so a hostile caller cannot widen it", () => {
    const policy = createReadOnlyServicePolicy();
    expect(Object.isFrozen(policy.allowedMethods)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Authorization decisions.
// ---------------------------------------------------------------------------

describe("service policy — readOnly allows the four published read methods", () => {
  it("allows notes.search", () => {
    const decision: ServicePolicyDecision = authorizeServiceMethod(
      createReadOnlyServicePolicy(),
      "notes.search",
    );
    expect(decision).toEqual({ allowed: true, method: "notes.search" });
  });

  it("allows notes.status", () => {
    const decision = authorizeServiceMethod(createReadOnlyServicePolicy(), "notes.status");
    expect(decision).toEqual({ allowed: true, method: "notes.status" });
  });

  it("allows notes.list_notebooks", () => {
    const decision = authorizeServiceMethod(createReadOnlyServicePolicy(), "notes.list_notebooks");
    expect(decision).toEqual({ allowed: true, method: "notes.list_notebooks" });
  });

  it("allows notes.get", () => {
    const decision = authorizeServiceMethod(createReadOnlyServicePolicy(), "notes.get");
    expect(decision).toEqual({ allowed: true, method: "notes.get" });
  });
});

describe("service policy — readOnly denies everything else categorically", () => {
  it("denies a hostile side-effecting method with permission_denied", () => {
    const decision = authorizeServiceMethod(createReadOnlyServicePolicy(), "notes.create");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("permission_denied");
    }
  });

  it("denies notes.update under readOnly", () => {
    const decision = authorizeServiceMethod(createReadOnlyServicePolicy(), "notes.update");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("permission_denied");
    }
  });

  it("denies notes.append under readOnly", () => {
    const decision = authorizeServiceMethod(createReadOnlyServicePolicy(), "notes.append");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("permission_denied");
    }
  });

  it("denies notes.delete under readOnly even though delete is not implemented", () => {
    const decision = authorizeServiceMethod(createReadOnlyServicePolicy(), "notes.delete");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("permission_denied");
    }
  });

  it("denies an arbitrary unknown method with permission_denied", () => {
    const decision = authorizeServiceMethod(createReadOnlyServicePolicy(), "notes.lol");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("permission_denied");
    }
  });

  it("denies an empty method string with permission_denied", () => {
    const decision = authorizeServiceMethod(createReadOnlyServicePolicy(), "");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("permission_denied");
    }
  });

  it("never echoes the offending method name in the denial reason", () => {
    const decision = authorizeServiceMethod(
      createReadOnlyServicePolicy(),
      "notes.create" as unknown as "notes.search",
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      // The denial reason is a closed categorical token, not a free-form
      // string that could echo the hostile method.
      expect(decision.reason).toBe("permission_denied");
      expect(typeof decision.reason).toBe("string");
      expect(decision.reason).not.toContain("create");
    }
  });
});

// ---------------------------------------------------------------------------
// Decision record invariants.
// ---------------------------------------------------------------------------

describe("service policy — decision record invariants", () => {
  it("freezes the allow decision record", () => {
    const decision = authorizeServiceMethod(createReadOnlyServicePolicy(), "notes.search");
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("freezes the deny decision record", () => {
    const decision = authorizeServiceMethod(createReadOnlyServicePolicy(), "notes.create");
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("uses a null prototype on the decision record so an inherited getter cannot smuggle data", () => {
    const allow = authorizeServiceMethod(createReadOnlyServicePolicy(), "notes.search");
    const deny = authorizeServiceMethod(createReadOnlyServicePolicy(), "notes.create");
    expect(Object.getPrototypeOf(allow)).toBeNull();
    expect(Object.getPrototypeOf(deny)).toBeNull();
  });

  it("fails closed instead of throwing when a hostile policy proxy traps inspection", () => {
    const hostilePolicy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("POLICY_PROXY_CANARY");
        },
      },
    ) as ServicePolicy;

    expect(() => authorizeServiceMethod(hostilePolicy, "notes.search")).not.toThrow();
    expect(authorizeServiceMethod(hostilePolicy, "notes.search")).toEqual({
      allowed: false,
      reason: "permission_denied",
    });
  });
});

// ---------------------------------------------------------------------------
// Outbound sync admission — explicit side-effecting method.
// ---------------------------------------------------------------------------

describe("service policy — outbound sync admission", () => {
  it("admits notes.sync only under readWriteNoDelete", () => {
    const policy = createReadWriteNoDeleteServicePolicy();
    expect(policy.allowedMethods).toContain("notes.sync");
    expect(authorizeServiceMethod(policy, "notes.sync")).toEqual({
      allowed: true,
      method: "notes.sync",
    });
  });

  it("keeps notes.sync denied under readOnly", () => {
    expect(authorizeServiceMethod(createReadOnlyServicePolicy(), "notes.sync")).toEqual({
      allowed: false,
      reason: "permission_denied",
    });
  });
});
