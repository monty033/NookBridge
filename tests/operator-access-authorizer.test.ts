/**
 * Per-principal operator access in the production authorizer: the principal
 * gate runs first and does no target work for an ungranted peer; a grant never
 * overrides a lock or a notebook refusal; and only a base-group grant is told
 * that a note is locked.
 */

import { describe, expect, it, vi } from "vitest";

import { createOperatorAuthorizer } from "../src/service/operator-authorizer.js";
import {
  OPERATOR_BASE_GROUP,
  OPERATOR_FAMILIES,
  OPERATOR_METHOD_FAMILY,
  createDefaultOperatorAccessPolicy,
  createOperatorAccessPolicy,
  type OperatorAccessAuditRecord,
  type OperatorAccessEntry,
  type OperatorFamily,
} from "../src/service/operator-capabilities.js";
import { OPERATOR_TRANSPORT_METHODS } from "../src/service/operator-methods.js";
import type { OperatorPeer } from "../src/service/operator-server.js";

const BASE: OperatorPeer = { uid: 1, gid: 2, groups: ["nookbridge-clients", OPERATOR_BASE_GROUP] };
const CLIENTS_ONLY: OperatorPeer = { uid: 3, gid: 2, groups: ["nookbridge-clients"] };
const NEITHER: OperatorPeer = { uid: 9, gid: 9, groups: ["users"] };
/** A delegated user: not in the base group, matched by uid. */
const DELEGATE: OperatorPeer = { uid: 1001, gid: 1001, groups: ["nookbridge-clients"] };

const GATED_SAMPLE = ["notes.get-view", "notes.apply-edit", "notes.resolve-conflict"] as const;
const OPERATION_HANDLE = `op_${"a".repeat(64)}`;

function requestFor(method: string): never {
  if (method === "notes.create") {
    return { id: "r1", method, params: { notebookId: "nb_public", title: "t" } } as never;
  }
  if (method === "notes.apply-undo") {
    return { id: "r1", method, params: { operationHandle: OPERATION_HANDLE } } as never;
  }
  const targeted = [
    "notes.apply-edit",
    "notes.approve-upload",
    "notes.resolve-conflict",
    "notes.abandon-resolve",
    "notes.get-view",
    "notes.edit-preimage",
    "notes.inspect-conflict",
  ];
  const params = targeted.includes(method) ? { id: "h_one" } : {};
  return { id: "r1", method, params } as never;
}

/** Spy-wrapped dependencies; every dependency that touches a target is counted. */
function spiedDeps(options: { lock?: "locked" | "unlocked"; notebookAllows?: boolean } = {}) {
  const lock = options.lock ?? "unlocked";
  const spies = {
    resolveHandle: vi.fn((handle: string) => (handle === "h_one" ? "note_one" : undefined)),
    resolveOperationNoteId: vi.fn(async () => "note_one" as string | undefined),
    readNoteLockState: vi.fn(async () => lock),
    readNoteNotebookPath: vi.fn(async () => "Public" as string | undefined),
    readNoteNotebookPaths: vi.fn(async () => ["Public"] as readonly string[] | undefined),
    resolveNotebookPath: vi.fn((id: string) => (id === "nb_public" ? "Public" : undefined)),
    evaluateNotebookPolicy: vi.fn(() => options.notebookAllows ?? true),
  };
  return spies;
}

const entry = (
  subject: OperatorAccessEntry["subject"],
  families: OperatorFamily[],
): OperatorAccessEntry => ({ subject, families });

/** A gid no peer above holds, so base entries here match by group name alone. */
const BASE_GID = 5000;
const BASE_ENTRY = entry({ kind: "group", name: OPERATOR_BASE_GROUP, gid: BASE_GID }, [
  ...OPERATOR_FAMILIES,
]);
const asString = (d: { allowed: boolean; reason?: string; method?: string }) =>
  d.allowed ? `allow:${d.method}` : `deny:${d.reason}`;

describe("explicit default equals the implicit default", () => {
  it("decides every method identically for base, clients-only and neither peers", async () => {
    const explicit = createOperatorAccessPolicy([BASE_ENTRY]);
    for (const method of OPERATOR_TRANSPORT_METHODS) {
      for (const peer of [BASE, CLIENTS_ONLY, NEITHER]) {
        for (const lock of ["locked", "unlocked"] as const) {
          const implicit = await createOperatorAuthorizer(spiedDeps({ lock }))(
            method,
            peer,
            requestFor(method),
          );
          const configured = await createOperatorAuthorizer({
            ...spiedDeps({ lock }),
            access: explicit,
          })(method, peer, requestFor(method));
          expect(asString(configured), `${method}`).toBe(asString(implicit));
        }
      }
    }
  });
});

describe("principal gate: zero-work denial", () => {
  /** Peers and policies under which a method is ungranted. */
  const ungranted: Array<[string, OperatorPeer, ReturnType<typeof createOperatorAccessPolicy>]> = [
    ["clients-only under the implicit default", CLIENTS_ONLY, createDefaultOperatorAccessPolicy()],
    ["no group at all", NEITHER, createDefaultOperatorAccessPolicy()],
    [
      "delegate granted discover only",
      DELEGATE,
      createOperatorAccessPolicy([BASE_ENTRY, entry({ kind: "user", uid: 1001 }, ["discover"])]),
    ],
  ];

  for (const [label, peer, access] of ungranted) {
    it(`touches no resolver, lock reader or notebook reader: ${label}`, async () => {
      let denied = 0;
      for (const method of OPERATOR_TRANSPORT_METHODS) {
        const family = OPERATOR_METHOD_FAMILY[method];
        // The delegate legitimately holds discover; those methods are not ungranted.
        if (label.startsWith("delegate") && family === "discover") continue;
        const spies = spiedDeps();
        const decision = await createOperatorAuthorizer({ ...spies, access })(
          method,
          peer,
          requestFor(method),
        );
        expect(decision, method).toEqual({ allowed: false, reason: "permission_denied" });
        for (const [name, spy] of Object.entries(spies)) {
          expect(spy, `${name} called for ${method}`).not.toHaveBeenCalled();
        }
        denied += 1;
      }
      expect(denied).toBeGreaterThan(0);
    });
  }

  it("is not vacuous: a granted peer's same requests do reach the resolvers", async () => {
    // Negative control for the spies above.  With the gate moved after target
    // resolution the ungranted case would show these same calls and fail.
    const spies = spiedDeps();
    const authorize = createOperatorAuthorizer(spies);
    await authorize("notes.apply-edit", BASE, requestFor("notes.apply-edit"));
    expect(spies.resolveHandle).toHaveBeenCalled();
    expect(spies.readNoteLockState).toHaveBeenCalled();
    expect(spies.evaluateNotebookPolicy).toHaveBeenCalled();
  });

  it("refuses a method outside the vocabulary without touching a resolver", async () => {
    const spies = spiedDeps();
    const decision = await createOperatorAuthorizer(spies)(
      "constructor" as never,
      BASE,
      requestFor("notes.apply-edit"),
    );
    expect(decision).toEqual({ allowed: false, reason: "permission_denied" });
    expect(spies.resolveHandle).not.toHaveBeenCalled();
  });

  it("collapses ungranted, unknown handle and notebook-forbidden to one refusal", async () => {
    const access = createOperatorAccessPolicy([
      BASE_ENTRY,
      entry({ kind: "user", uid: 1001 }, ["discover", "write"]),
    ]);
    const ungrantedFamily = await createOperatorAuthorizer({ ...spiedDeps(), access })(
      "notes.resolve-conflict",
      DELEGATE,
      requestFor("notes.resolve-conflict"),
    );
    const unknownHandle = await createOperatorAuthorizer({ ...spiedDeps(), access })(
      "notes.apply-edit",
      DELEGATE,
      { id: "r1", method: "notes.apply-edit", params: { id: "h_unknown" } } as never,
    );
    const forbidden = await createOperatorAuthorizer({
      ...spiedDeps({ notebookAllows: false }),
      access,
    })("notes.apply-edit", DELEGATE, requestFor("notes.apply-edit"));
    expect(ungrantedFamily).toEqual({ allowed: false, reason: "permission_denied" });
    expect(unknownHandle).toEqual(ungrantedFamily);
    expect(forbidden).toEqual(ungrantedFamily);
  });
});

describe("a grant never overrides the target gates", () => {
  const access = createOperatorAccessPolicy([
    BASE_ENTRY,
    entry({ kind: "user", uid: 1001 }, ["discover", "read", "write", "conflict"]),
  ]);

  it("admits a granted delegate on an unlocked, allowed note (control)", async () => {
    for (const method of GATED_SAMPLE) {
      const decision = await createOperatorAuthorizer({ ...spiedDeps(), access })(
        method,
        DELEGATE,
        requestFor(method),
      );
      expect(decision).toMatchObject({ allowed: true, method });
    }
  });

  it("refuses a granted delegate when the notebook policy refuses", async () => {
    for (const method of GATED_SAMPLE) {
      const decision = await createOperatorAuthorizer({
        ...spiedDeps({ notebookAllows: false }),
        access,
      })(method, DELEGATE, requestFor(method));
      expect(decision).toEqual({ allowed: false, reason: "permission_denied" });
    }
  });

  it("refuses a granted delegate whose target does not resolve", async () => {
    const decision = await createOperatorAuthorizer({ ...spiedDeps(), access })(
      "notes.get-view",
      DELEGATE,
      { id: "r1", method: "notes.get-view", params: { id: "h_unknown" } } as never,
    );
    expect(decision).toEqual({ allowed: false, reason: "permission_denied" });
  });
});

describe("locked-note collapse", () => {
  const access = createOperatorAccessPolicy([
    BASE_ENTRY,
    entry({ kind: "user", uid: 1001 }, ["discover", "read", "write", "conflict"]),
  ]);

  const mutating = ["notes.apply-edit", "notes.apply-undo", "notes.resolve-conflict"] as const;
  for (const method of mutating) {
    it(`${method}: a delegate gets permission_denied, a base peer vault_locked`, async () => {
      const locked = (peer: OperatorPeer) =>
        createOperatorAuthorizer({ ...spiedDeps({ lock: "locked" }), access })(
          method,
          peer,
          requestFor(method),
        );
      expect(await locked(DELEGATE)).toEqual({ allowed: false, reason: "permission_denied" });
      expect(await locked(BASE)).toEqual({ allowed: false, reason: "vault_locked" });
    });

    it(`${method}: the delegate is admitted when the note is unlocked (control)`, async () => {
      const decision = await createOperatorAuthorizer({ ...spiedDeps(), access })(
        method,
        DELEGATE,
        requestFor(method),
      );
      expect(decision).toMatchObject({ allowed: true, method });
    });
  }

  it("a base-group peer learns vault_locked only if the base entry grants the family", async () => {
    // The base entry grants read only; write reaches this peer through its user
    // entry, so it is a delegated grant and must not learn the note is locked.
    const narrowBase = createOperatorAccessPolicy([
      entry({ kind: "group", name: OPERATOR_BASE_GROUP, gid: BASE_GID }, ["read"]),
      entry({ kind: "user", uid: 1 }, ["write"]),
    ]);
    const decision = await createOperatorAuthorizer({
      ...spiedDeps({ lock: "locked" }),
      access: narrowBase,
    })("notes.apply-edit", BASE, requestFor("notes.apply-edit"));
    expect(decision).toEqual({ allowed: false, reason: "permission_denied" });
  });

  it("a peer granted through both the base group and a user entry gets vault_locked", async () => {
    const both = createOperatorAccessPolicy([
      entry({ kind: "user", uid: 1 }, ["write"]),
      BASE_ENTRY,
    ]);
    const decision = await createOperatorAuthorizer({
      ...spiedDeps({ lock: "locked" }),
      access: both,
    })("notes.apply-edit", BASE, requestFor("notes.apply-edit"));
    expect(decision).toEqual({ allowed: false, reason: "vault_locked" });
  });

  it("reads never consult lock state, so a delegated read matches the base read", async () => {
    // The brief's wording puts `read` on a locked note in this collapse, but reads
    // have never consulted lock state: a base peer reading a locked note is
    // allowed, not refused with vault_locked.  The delegate must be treated the
    // same, and must not cause a lock read at all.
    const delegateSpies = spiedDeps({ lock: "locked" });
    const delegate = await createOperatorAuthorizer({ ...delegateSpies, access })(
      "notes.get-view",
      DELEGATE,
      requestFor("notes.get-view"),
    );
    const base = await createOperatorAuthorizer({ ...spiedDeps({ lock: "locked" }), access })(
      "notes.get-view",
      BASE,
      requestFor("notes.get-view"),
    );
    expect(asString(delegate)).toBe(asString(base));
    expect(delegateSpies.readNoteLockState).not.toHaveBeenCalled();
  });
});

describe("principal-gate audit", () => {
  const access = createOperatorAccessPolicy([
    BASE_ENTRY,
    entry({ kind: "user", uid: 1001 }, ["discover"]),
  ]);

  it("emits exactly one record per decision: matched index and family, nothing else", async () => {
    const records: OperatorAccessAuditRecord[] = [];
    const authorize = createOperatorAuthorizer({
      ...spiedDeps(),
      access,
      audit: (record) => records.push(record),
    });
    await authorize("notes.apply-edit", BASE, requestFor("notes.apply-edit"));
    await authorize("notes.browse", DELEGATE, requestFor("notes.browse"));
    await authorize("notes.apply-edit", DELEGATE, requestFor("notes.apply-edit"));
    await authorize("notes.get-view", NEITHER, requestFor("notes.get-view"));
    expect(records).toEqual([
      { principalIndex: 0, family: "write" },
      { principalIndex: 1, family: "discover" },
      { principalIndex: null, family: "write" },
      { principalIndex: null, family: "read" },
    ]);
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(["family", "principalIndex"]);
    }
    const text = JSON.stringify(records);
    for (const leaked of ["h_one", "note_one", "Public", OPERATION_HANDLE]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("emits one record even when the target gates then refuse", async () => {
    const records: OperatorAccessAuditRecord[] = [];
    await createOperatorAuthorizer({
      ...spiedDeps({ notebookAllows: false }),
      access,
      audit: (record) => records.push(record),
    })("notes.apply-edit", BASE, requestFor("notes.apply-edit"));
    expect(records).toEqual([{ principalIndex: 0, family: "write" }]);
  });

  it("does not let a failing audit sink change the decision", async () => {
    const authorize = createOperatorAuthorizer({
      ...spiedDeps(),
      access,
      audit: () => {
        throw new Error("sink down");
      },
    });
    await expect(
      authorize("notes.apply-edit", BASE, requestFor("notes.apply-edit")),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      authorize("notes.apply-edit", NEITHER, requestFor("notes.apply-edit")),
    ).resolves.toEqual({ allowed: false, reason: "permission_denied" });
  });
});
