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

  it("refuses a read for a client-group-only peer and admits it for an operator", async () => {
    // nookbridge-clients is not an operator-admitted group, so a peer holding
    // only that group is refused.  This is not an MCP boundary: the MCP server
    // runs as the operator CLI's identity and is still admitted (SR-9).  The
    // operator control with the very same request is admitted, so the refusal
    // is attributable to group membership alone.
    const authorize = createOperatorAuthorizer(deps());
    const read = request("notes.get-view", { id: "h_one" });
    await expect(authorize("notes.get-view", CLIENT, read)).resolves.toEqual({
      allowed: false,
      reason: "permission_denied",
    });
    await expect(authorize("notes.get-view", OPERATOR, read)).resolves.toMatchObject({
      allowed: true,
      method: "notes.get-view",
    });
  });

  it("denies a mutation for a client peer", async () => {
    // Review finding: the two groups were decoration - the evaluator admitted
    // either for every method, so membership of the read-only group was enough
    // to call apply-edit.  Mutation is the operator capability.
    //
    // Every request carries a resolvable target and the deps supply a notebook
    // policy, so the target gates pass and the refusal is attributable to the
    // missing operator membership alone.  The operator control with the very
    // same requests is admitted.
    const operationHandle = `op_${"c".repeat(64)}`;
    const resolveNotebookPath = vi.fn((notebookId: string) =>
      notebookId === "nb_public" ? "Public" : undefined,
    );
    const evaluateNotebookPolicy = vi.fn(() => true);
    const authorize = createOperatorAuthorizer(
      deps({
        resolveOperationNoteId: async () => "note_one",
        resolveNotebookPath,
        evaluateNotebookPolicy,
      }),
    );
    const requests = [
      ["notes.apply-edit", { id: "h_one" }],
      ["notes.apply-undo", { operationHandle }],
      ["notes.create", { notebookId: "nb_public", title: "Probe" }],
    ] as const;
    for (const [method, params] of requests) {
      await expect(authorize(method, OPERATOR, request(method, params))).resolves.toMatchObject({
        allowed: true,
        method,
      });
      await expect(authorize(method, CLIENT, request(method, params))).resolves.toEqual({
        allowed: false,
        reason: "permission_denied",
      });
    }
    // The create policy was evaluated against the resolved notebook path, never
    // against an empty one.
    expect(resolveNotebookPath).toHaveBeenCalledWith("nb_public");
    expect(evaluateNotebookPolicy).toHaveBeenCalledWith("create", "Public");
    expect(evaluateNotebookPolicy).not.toHaveBeenCalledWith("create", "");
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

  it("denies target-addressed mutations whose target does not resolve for the peer", async () => {
    const readNoteLockState = vi.fn(async () => "unlocked" as const);
    const authorize = createOperatorAuthorizer(deps({ readNoteLockState }));
    const denied = { allowed: false, reason: "permission_denied" };
    for (const method of ["notes.apply-edit", "notes.apply-undo"] as const) {
      // Unknown / foreign handle, empty id, non-string id, and no target at all.
      for (const params of [{ id: "h_other_peer" }, { id: "" }, { id: 7 }, {}]) {
        await expect(authorize(method, OPERATOR, request(method, params))).resolves.toEqual(denied);
      }
    }
    expect(readNoteLockState).not.toHaveBeenCalled();
  });

  it("scopes handle resolution to the calling peer", async () => {
    const OWNER: OperatorPeer = OPERATOR;
    const OTHER: OperatorPeer = { ...OPERATOR, uid: 4242 };
    const authorize = createOperatorAuthorizer(
      deps({
        resolveHandle: (handle: string, peer?: OperatorPeer) =>
          handle === "h_one" && peer?.uid === OWNER.uid ? "note_one" : undefined,
      }),
    );
    const edit = request("notes.apply-edit", { id: "h_one" });
    await expect(authorize("notes.apply-edit", OWNER, edit)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(authorize("notes.apply-edit", OTHER, edit)).resolves.toEqual({
      allowed: false,
      reason: "permission_denied",
    });
  });

  it("denies apply-undo for an operation handle the peer cannot resolve", async () => {
    const operationHandle = `op_${"a".repeat(64)}`;
    const undo = request("notes.apply-undo", { operationHandle });
    const resolveOperationNoteId = vi.fn(async (_handle: string, peer?: OperatorPeer) =>
      peer?.uid === OPERATOR.uid ? "note_one" : undefined,
    );
    const authorize = createOperatorAuthorizer(deps({ resolveOperationNoteId }));
    await expect(authorize("notes.apply-undo", OPERATOR, undo)).resolves.toMatchObject({
      allowed: true,
      method: "notes.apply-undo",
    });
    await expect(authorize("notes.apply-undo", { ...OPERATOR, uid: 4242 }, undo)).resolves.toEqual({
      allowed: false,
      reason: "permission_denied",
    });
  });

  it("does not consult the operation resolver for malformed operation handles", async () => {
    // The resolver would admit anything it is asked about, so a denial can only
    // come from the published handle shape being checked before the lookup.
    const resolveOperationNoteId = vi.fn(async () => "note_one");
    const authorize = createOperatorAuthorizer(deps({ resolveOperationNoteId }));
    const malformed = [
      "op_abc",
      `op_${"A".repeat(64)}`,
      `op_${"a".repeat(63)}`,
      `op_${"a".repeat(65)}`,
      `xx_${"a".repeat(64)}`,
      `op_${"g".repeat(64)}`,
      "",
    ];
    for (const operationHandle of malformed) {
      await expect(
        authorize("notes.apply-undo", OPERATOR, request("notes.apply-undo", { operationHandle })),
      ).resolves.toEqual({ allowed: false, reason: "permission_denied" });
    }
    expect(resolveOperationNoteId).not.toHaveBeenCalled();
  });

  it("falls back from an empty id to a valid operation handle, scoped to the peer", async () => {
    const operationHandle = `op_${"b".repeat(64)}`;
    const undo = request("notes.apply-undo", { id: "", operationHandle });
    const resolveOperationNoteId = vi.fn(async (_handle: string, peer?: OperatorPeer) =>
      peer?.uid === OPERATOR.uid ? "note_one" : undefined,
    );
    const authorize = createOperatorAuthorizer(deps({ resolveOperationNoteId }));
    await expect(authorize("notes.apply-undo", OPERATOR, undo)).resolves.toMatchObject({
      allowed: true,
      method: "notes.apply-undo",
    });
    await expect(authorize("notes.apply-undo", { ...OPERATOR, uid: 4242 }, undo)).resolves.toEqual({
      allowed: false,
      reason: "permission_denied",
    });
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

describe("D2-1 — operator target reads fail closed", () => {
  const denied = { allowed: false, reason: "permission_denied" };

  it.each(["notes.get-view", "notes.edit-preimage"] as const)(
    "%s with no target is denied",
    async (m) => {
      const authorize = createOperatorAuthorizer(deps());
      await expect(authorize(m, OPERATOR, request(m))).resolves.toMatchObject(denied);
    },
  );

  it.each(["notes.get-view", "notes.edit-preimage"] as const)(
    "%s with a forged handle is denied without a path lookup",
    async (m) => {
      const readNoteNotebookPath = vi.fn(async () => "Public");
      const authorize = createOperatorAuthorizer(
        deps({ resolveHandle: () => undefined, readNoteNotebookPath }),
      );
      await expect(authorize(m, OPERATOR, request(m, { id: "h_forged" }))).resolves.toMatchObject(
        denied,
      );
      expect(readNoteNotebookPath).toHaveBeenCalledTimes(0);
    },
  );

  it.each(["notes.get-view", "notes.edit-preimage"] as const)(
    "%s on a root-level note is denied without a policy evaluation",
    async (m) => {
      const evaluateNotebookPolicy = vi.fn(() => true);
      const authorize = createOperatorAuthorizer(
        deps({ readNoteNotebookPath: vi.fn(async () => undefined), evaluateNotebookPolicy }),
      );
      await expect(authorize(m, OPERATOR, request(m, { id: "h_one" }))).resolves.toMatchObject(
        denied,
      );
      expect(evaluateNotebookPolicy).toHaveBeenCalledTimes(0);
    },
  );

  it.each(["notes.get-view", "notes.edit-preimage"] as const)(
    "%s with no path source is denied",
    async (m) => {
      const authorize = createOperatorAuthorizer(deps({ readNoteNotebookPath: undefined }));
      await expect(authorize(m, OPERATOR, request(m, { id: "h_one" }))).resolves.toMatchObject(
        denied,
      );
    },
  );

  it.each(["notes.get-view", "notes.edit-preimage"] as const)(
    "%s with no policy source is denied",
    async (m) => {
      const authorize = createOperatorAuthorizer(deps({ evaluateNotebookPolicy: undefined }));
      await expect(authorize(m, OPERATOR, request(m, { id: "h_one" }))).resolves.toMatchObject(
        denied,
      );
    },
  );

  it.each(["notes.get-view", "notes.edit-preimage"] as const)(
    "%s resolves to a denial when the path lookup throws",
    async (m) => {
      const authorize = createOperatorAuthorizer(
        deps({
          readNoteNotebookPath: async () => {
            throw new Error("boom");
          },
        }),
      );
      await expect(authorize(m, OPERATOR, request(m, { id: "h_one" }))).resolves.toMatchObject(
        denied,
      );
    },
  );

  it.each(["notes.get-view", "notes.edit-preimage"] as const)(
    "%s is denied when the notebook policy refuses read",
    async (m) => {
      const evaluateNotebookPolicy = vi.fn(() => false);
      const authorize = createOperatorAuthorizer(
        deps({ readNoteNotebookPath: async () => "Private", evaluateNotebookPolicy }),
      );
      await expect(authorize(m, OPERATOR, request(m, { id: "h_one" }))).resolves.toMatchObject(
        denied,
      );
      expect(evaluateNotebookPolicy).toHaveBeenCalledWith("read", "Private");
    },
  );

  it.each(["notes.get-view", "notes.edit-preimage"] as const)(
    "%s is admitted when the target resolves and policy allows read",
    async (m) => {
      const authorize = createOperatorAuthorizer(
        deps({ readNoteNotebookPath: async () => "Public", evaluateNotebookPolicy: () => true }),
      );
      await expect(authorize(m, OPERATOR, request(m, { id: "h_one" }))).resolves.toMatchObject({
        allowed: true,
        method: m,
      });
    },
  );

  it("leaves untargeted reads allowed", async () => {
    const authorize = createOperatorAuthorizer(deps());
    await expect(
      authorize("notes.operation-list", OPERATOR, request("notes.operation-list")),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      authorize("notes.browse", OPERATOR, request("notes.browse", {})),
    ).resolves.toMatchObject({ allowed: true });
  });
});
