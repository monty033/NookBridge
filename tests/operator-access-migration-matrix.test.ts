/**
 * Migration matrix: with no `operatorAccess` block the authorizer must decide
 * exactly as it did when one group admitted everything.
 *
 * This file deliberately uses only the API that existed before per-principal
 * access: `createOperatorAuthorizer(deps)` with no access policy.  The expected
 * decisions come from an oracle written here from the old rules (one admitted
 * group, `vault_locked` before notebook policy, target gates for mutations and
 * target reads), not from the source under test.  It therefore passes on the
 * pre-change tree and must keep passing after it; a regression in the implicit
 * default shows up as a changed cell.
 */

import { describe, expect, it } from "vitest";

import { createOperatorAuthorizer } from "../src/service/operator-authorizer.js";
import { OPERATOR_TRANSPORT_METHODS } from "../src/service/operator-methods.js";
import type { OperatorPeer } from "../src/service/operator-server.js";

// Today's constants, restated on purpose rather than imported.
const ADMITTED_GROUP = "nookbridge-operators";
const MUTATING = [
  "notes.apply-edit",
  "notes.apply-undo",
  "notes.create",
  "notes.approve-upload",
  "notes.resolve-conflict",
  "notes.abandon-resolve",
];
const TARGET_READS = ["notes.get-view", "notes.edit-preimage", "notes.inspect-conflict"];

const PEERS: Record<string, OperatorPeer> = {
  base: { uid: 1, gid: 2, groups: ["nookbridge-clients", ADMITTED_GROUP] },
  clientsOnly: { uid: 3, gid: 2, groups: ["nookbridge-clients"] },
  neither: { uid: 9, gid: 9, groups: ["users"] },
};

type State = "unlocked" | "locked" | "notebook-denied";
const STATES: State[] = ["unlocked", "locked", "notebook-denied"];

function requestFor(method: string): never {
  if (method === "notes.create") {
    return { id: "r1", method, params: { notebookId: "nb_public", title: "t" } } as never;
  }
  if (MUTATING.includes(method) || TARGET_READS.includes(method)) {
    return { id: "r1", method, params: { id: "h_one" } } as never;
  }
  return { id: "r1", method, params: {} } as never;
}

function depsFor(state: State) {
  return {
    resolveHandle: (handle: string) => (handle === "h_one" ? "note_one" : undefined),
    readNoteLockState: async () =>
      state === "locked" ? ("locked" as const) : ("unlocked" as const),
    readNoteNotebookPath: async () => "Public",
    resolveNotebookPath: (id: string) => (id === "nb_public" ? "Public" : undefined),
    evaluateNotebookPolicy: () => state !== "notebook-denied",
  };
}

/** The pre-change decision, from the old rules alone. */
function oracle(method: string, peer: OperatorPeer, state: State): string {
  if (!peer.groups.includes(ADMITTED_GROUP)) return "deny:permission_denied";
  const mutating = MUTATING.includes(method);
  const hasTarget = (mutating && method !== "notes.create") || TARGET_READS.includes(method);
  if (state === "locked" && mutating && hasTarget) return "deny:vault_locked";
  if (state === "notebook-denied" && (hasTarget || method === "notes.create")) {
    return "deny:permission_denied";
  }
  return `allow:${method}`;
}

async function decide(
  method: (typeof OPERATOR_TRANSPORT_METHODS)[number],
  peer: OperatorPeer,
  state: State,
): Promise<string> {
  const authorize = createOperatorAuthorizer(depsFor(state));
  const decision = await authorize(method, peer, requestFor(method));
  return decision.allowed ? `allow:${decision.method}` : `deny:${decision.reason}`;
}

describe("operator authorizer migration matrix (no operatorAccess block)", () => {
  it("covers the whole operator vocabulary", () => {
    expect(OPERATOR_TRANSPORT_METHODS.length).toBe(15);
  });

  for (const method of OPERATOR_TRANSPORT_METHODS) {
    for (const [peerName, peer] of Object.entries(PEERS)) {
      for (const state of STATES) {
        it(`${method} / ${peerName} / ${state}`, async () => {
          expect(await decide(method, peer, state)).toBe(oracle(method, peer, state));
        });
      }
    }
  }

  it("is not vacuous: allows, permission_denied and vault_locked all occur", async () => {
    const seen = new Set<string>();
    for (const method of OPERATOR_TRANSPORT_METHODS) {
      for (const peer of Object.values(PEERS)) {
        for (const state of STATES) {
          const decision = await decide(method, peer, state);
          seen.add(decision.startsWith("allow:") ? "allow" : decision);
        }
      }
    }
    expect(seen).toEqual(new Set(["allow", "deny:permission_denied", "deny:vault_locked"]));
  });
});
