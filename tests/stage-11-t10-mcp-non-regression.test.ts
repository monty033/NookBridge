/**
 * T10 — MCP and read-only non-regression.
 *
 * The acceptance criterion is: **CLI capabilities cannot be reached
 * through the MCP endpoint or a generic tool.**
 *
 * The important design property of this suite is that it derives the
 * method list from `OPERATOR_METHODS` instead of copying it.  The
 * handler refuses operator methods with a hand-written enumeration, and
 * a hand-written list silently falls out of sync the moment a tenth
 * operator method is added — the new method would be neither admitted
 * nor covered.  Deriving from the frozen vocabulary means a new operator
 * method fails this test until someone deliberately decides whether it
 * is MCP-reachable.
 */

import { describe, expect, it } from "vitest";

import { handleRpcRequest } from "../src/service/rpc-handler.js";
import { OPERATOR_METHODS } from "../src/service/operator-methods.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import type { RpcMethod, RpcRequest } from "../src/service/rpc-protocol.js";

/** The pre-existing MCP write tool also happens to be an operator method. */
const PRE_EXISTING_MCP_METHOD = "notes.create";

/** Operator methods that must never be reachable from the daemon surface. */
const OPERATOR_ONLY = OPERATOR_METHODS.filter(
  (method) => method !== PRE_EXISTING_MCP_METHOD,
) as ReadonlyArray<RpcMethod>;

/**
 * The most permissive profile the daemon can run.  A custom policy is
 * NOT usable here: its allowlist is filtered to the closed custom
 * (write) universe, so it denies every read method and the suite would
 * assert nothing but "a policy denied something".
 */
const permissivePolicy = () => createReadWriteNoDeleteServicePolicy();

const runtime = {
  search: async () => [{ title: "Hit" }],
  status: async () => ({ kind: "status" }),
  listNotebooks: async () => [],
  getNote: async () => undefined,
  createNote: async () => ({ id: "note-1" }),
  appendToNote: async () => ({}),
  updateNote: async () => ({}),
  deleteNote: async () => ({}),
} as never;

const request = (method: RpcMethod, params: Record<string, unknown> = {}): RpcRequest =>
  ({ id: "t10", method, params }) as RpcRequest;

describe("T10 — operator vocabulary is unreachable from the daemon surface", () => {
  /**
   * Positive control.  Without this, a harness that refuses EVERYTHING
   * would make every assertion below pass while proving nothing — which
   * is exactly how this suite was first written and why it is pinned
   * here permanently.
   */
  it("admits a legitimate daemon method through the same harness", async () => {
    const policy = permissivePolicy();
    const envelope = await handleRpcRequest(
      request("notes.search", { query: "x" }),
      runtime,
      policy,
    );
    expect(envelope.ok).toBe(true);
  });
  it.each(OPERATOR_ONLY)("refuses %s even under the most permissive policy", async (method) => {
    // The permissive policy is the point: the refusal must not depend
    // on how the daemon happens to be configured.
    const envelope = await handleRpcRequest(request(method), runtime, permissivePolicy());

    expect(envelope.ok).toBe(false);
    if (envelope.ok) return;
    // Refused with a categorical code from the frozen vocabulary.
    expect(["invalid_request", "permission_denied"]).toContain(envelope.error.code);
    // A refusal must never carry a result payload (note content, ids,
    // handles, revisions) alongside the error.
    expect((envelope as { result?: unknown }).result).toBeUndefined();
  });

  it.each(OPERATOR_ONLY)("refuses %s under the default read-only policy too", async (method) => {
    const envelope = await handleRpcRequest(request(method), runtime);
    expect(envelope.ok).toBe(false);
    if (envelope.ok) return;
    expect(["invalid_request", "permission_denied"]).toContain(envelope.error.code);
  });

  /**
   * The refusals above must be indistinguishable from a request for a
   * method that simply does not exist, so probing cannot reveal that an
   * operator endpoint exists on this host.
   */
  it("answers an operator method exactly as it answers an unknown method", async () => {
    const policy = permissivePolicy();
    const unknown = await handleRpcRequest(
      request("notes.definitely-not-a-method" as RpcMethod),
      runtime,
      policy,
    );
    const operator = await handleRpcRequest(request("notes.get-view"), runtime, policy);

    expect(unknown.ok).toBe(false);
    expect(operator.ok).toBe(false);
    if (unknown.ok || operator.ok) return;
    expect(operator.error.code).toBe(unknown.error.code);
    expect(Object.keys(operator.error).sort()).toEqual(Object.keys(unknown.error).sort());
  });

  /**
   * `notes.get-view` is the operator body-read path.  The MCP contract is
   * body-free, so this is the single most important method to pin.
   */
  it("never returns a note body for the operator view method", async () => {
    const policy = permissivePolicy();
    const envelope = await handleRpcRequest(
      request("notes.get-view", { id: "h_abcdefghijklmnop" }),
      runtime,
      policy,
    );
    expect(envelope.ok).toBe(false);
    expect(JSON.stringify(envelope)).not.toContain("markdown");
    expect(JSON.stringify(envelope)).not.toContain("body");
  });
});
