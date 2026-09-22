import { describe, expect, it, vi } from "vitest";
import {
  OPERATOR_ADMITTED_GROUPS,
  createOperatorAuthorizer,
} from "../src/service/operator-authorizer.js";
import { OPERATOR_MUTATING_METHODS } from "../src/service/operator-authorization-context.js";
import type { OperatorPeer } from "../src/service/operator-server.js";

const CLIENT: OperatorPeer = { uid: 1, gid: 2, groups: ["nookbridge-clients"] };
const OPERATOR: OperatorPeer = {
  uid: 1,
  gid: 2,
  groups: ["nookbridge-clients", "nookbridge-operators"],
};
const STRANGER: OperatorPeer = { uid: 9, gid: 9, groups: ["users"] };

const request = (method: string, params: Record<string, unknown> = {}) =>
  ({ id: "r1", method, params }) as never;

const deps = (overrides: Record<string, unknown> = {}) => ({
  resolveHandle: (handle: string) => (handle === "h_one" ? "note_one" : undefined),
  resolveOperationNoteId: undefined,
  readNoteLockState: async () => "unlocked" as const,
  readNoteNotebookPath: async () => "Public",
  evaluateNotebookPolicy: () => true,
  ...overrides,
});

describe("operator authorizer", () => {
  it("keeps exported authorization vocabularies immutable at runtime", () => {
    expect(() =>
      (OPERATOR_ADMITTED_GROUPS as unknown as string[]).push("nookbridge-operators"),
    ).toThrow();
    expect(() => (OPERATOR_MUTATING_METHODS as unknown as string[]).splice(2, 1)).toThrow();
  });

  it("denies a peer in neither admitted group", async () => {
    const authorize = createOperatorAuthorizer(deps());
    await expect(
      authorize("notes.get-view", STRANGER, request("notes.get-view")),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "permission_denied",
    });
  });

  it("admits a read for a client peer", async () => {
    const authorize = createOperatorAuthorizer(deps());
    await expect(
      authorize("notes.get-view", CLIENT, request("notes.get-view")),
    ).resolves.toMatchObject({
      allowed: true,
      method: "notes.get-view",
    });
  });

  it("denies a mutation for a client peer", async () => {
    // Review finding: the two groups were decoration - the evaluator admitted
    // either for every method, so membership of the read-only group was enough
    // to call apply-edit.  Mutation is the operator capability.
    const authorize = createOperatorAuthorizer(deps());
    for (const method of ["notes.apply-edit", "notes.apply-undo", "notes.create"] as const) {
      await expect(authorize(method, CLIENT, request(method))).resolves.toMatchObject({
        allowed: false,
        reason: "permission_denied",
      });
    }
  });

  it("admits a mutation for an operator peer", async () => {
    const authorize = createOperatorAuthorizer(deps());
    await expect(
      authorize("notes.apply-edit", OPERATOR, request("notes.apply-edit", { id: "h_one" })),
    ).resolves.toMatchObject({ allowed: true, method: "notes.apply-edit" });
  });

  it("fails closed for mutations when notebook policy evidence is unavailable", async () => {
    const authorize = createOperatorAuthorizer(
      deps({
        readNoteNotebookPath: undefined,
        evaluateNotebookPolicy: undefined,
      }),
    );
    await expect(
      authorize("notes.apply-edit", OPERATOR, request("notes.apply-edit", { id: "h_one" })),
    ).resolves.toMatchObject({ allowed: false, reason: "permission_denied" });
  });

  it("refuses a locked target categorically, before the mutation runs", async () => {
    const authorize = createOperatorAuthorizer(
      deps({ readNoteLockState: async () => "locked" as const }),
    );
    await expect(
      authorize("notes.apply-edit", OPERATOR, request("notes.apply-edit", { id: "h_one" })),
    ).resolves.toMatchObject({ allowed: false, reason: "vault_locked" });
  });

  it("admits the same mutation when the target is unlocked", async () => {
    // Negative control: the refusal above must come from the lock, not from the
    // resolvers being wired at all.
    const authorize = createOperatorAuthorizer(
      deps({ readNoteLockState: async () => "unlocked" as const }),
    );
    await expect(
      authorize("notes.apply-edit", OPERATOR, request("notes.apply-edit", { id: "h_one" })),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("denies when the notebook policy refuses the operation", async () => {
    const evaluate = vi.fn(() => false);
    const authorize = createOperatorAuthorizer(
      deps({
        readNoteNotebookPath: async () => "Private/Secrets",
        evaluateNotebookPolicy: evaluate,
      }),
    );
    await expect(
      authorize("notes.apply-edit", OPERATOR, request("notes.apply-edit", { id: "h_one" })),
    ).resolves.toMatchObject({ allowed: false, reason: "permission_denied" });
    expect(evaluate).toHaveBeenCalledWith("edit", "Private/Secrets");
  });

  it("admits when the notebook policy allows it", async () => {
    const authorize = createOperatorAuthorizer(
      deps({
        readNoteNotebookPath: async () => "Public",
        evaluateNotebookPolicy: () => true,
      }),
    );
    await expect(
      authorize("notes.apply-edit", OPERATOR, request("notes.apply-edit", { id: "h_one" })),
    ).resolves.toMatchObject({ allowed: true });
  });
});
