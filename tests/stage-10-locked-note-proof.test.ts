import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  formatLockedNoteProof,
  lockedNoteProofCodeForError,
  runLockedNoteProof,
  type LockedNoteProofRuntime,
} from "../src/operator/locked-note-proof.js";

const path = "General/Bernie Test Locked";

function makeRuntime(result: {
  readonly read: "vault_locked" | "ok" | "not_found" | "permission_denied" | "service_unavailable";
  readonly update:
    | "vault_locked"
    | "ok"
    | "not_found"
    | "permission_denied"
    | "service_unavailable";
  readonly delete:
    | "vault_locked"
    | "ok"
    | "not_found"
    | "permission_denied"
    | "service_unavailable";
}): LockedNoteProofRuntime {
  return {
    lockedNoteProof: async (requestedPath) => ({
      kind: "locked_note_proof",
      pathBytes: Buffer.byteLength(requestedPath, "utf8"),
      ...result,
    }),
  };
}

describe("locked-note proof", () => {
  it("returns vault_locked for read, update, and delete", async () => {
    const result = await runLockedNoteProof(
      path,
      makeRuntime({ read: "vault_locked", update: "vault_locked", delete: "vault_locked" }),
    );
    expect(result).toEqual({
      pathBytes: Buffer.byteLength(path, "utf8"),
      read: "vault_locked",
      update: "vault_locked",
      delete: "vault_locked",
    });
    expect(formatLockedNoteProof(result)).not.toContain("note-locked");
    expect(formatLockedNoteProof(result)).not.toContain("General/");
    expect(Object.keys(result)).toEqual(["pathBytes", "read", "update", "delete"]);
  });

  it("preserves the categorical nonlocked control", async () => {
    const result = await runLockedNoteProof(
      path,
      makeRuntime({ read: "ok", update: "ok", delete: "ok" }),
    );
    expect(result.read).toBe("ok");
    expect(result.update).toBe("ok");
    expect(result.delete).toBe("ok");
  });

  it("normalizes malformed and oversized paths to closed categories", async () => {
    let calls = 0;
    const runtime: LockedNoteProofRuntime = {
      lockedNoteProof: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    };
    expect((await runLockedNoteProof("../escape", runtime)).read).toBe("service_unavailable");
    expect((await runLockedNoteProof("x".repeat(513), runtime)).delete).toBe("service_unavailable");
    expect(calls).toBe(1);
  });

  it("rejects a malformed daemon result and redacts its details", async () => {
    const runtime: LockedNoteProofRuntime = {
      lockedNoteProof: async () =>
        ({
          kind: "wrong",
          pathBytes: 1,
          read: "vault_locked",
          update: "vault_locked",
          delete: "vault_locked",
          id: "note-secret",
          body: "private body",
        }) as never,
    };
    const result = await runLockedNoteProof(path, runtime);
    expect(result.read).toBe("service_unavailable");
    expect(formatLockedNoteProof(result)).not.toContain("note-secret");
    expect(formatLockedNoteProof(result)).not.toContain("private body");
  });
});

describe("locked-note proof error mapping", () => {
  it("keeps a categorical refusal distinguishable from a service failure", () => {
    // The socket facade used to collapse every code except `not_found` into
    // `service_unavailable`.  That made a proven lock refusal unprovable: the
    // acceptance criterion is a categorical `vault_locked`, and a facade that
    // reports a generic failure for a working lock cannot demonstrate it.
    expect(lockedNoteProofCodeForError("vault_locked")).toBe("vault_locked");
    expect(lockedNoteProofCodeForError("not_found")).toBe("not_found");
    expect(lockedNoteProofCodeForError("permission_denied")).toBe("permission_denied");
  });

  it("still reports an unknown or transport-level code as unavailable", () => {
    expect(lockedNoteProofCodeForError("service_unavailable")).toBe("service_unavailable");
    expect(lockedNoteProofCodeForError("sync_failed")).toBe("service_unavailable");
    expect(lockedNoteProofCodeForError("invalid_request")).toBe("service_unavailable");
  });
});

import { vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLockedNoteProof,
  createProductionServiceRuntime,
  type ServiceRuntime,
} from "../src/service/service-runtime.js";
import {
  ExactNotePathError,
  type ExactNotePathErrorCode,
} from "../src/service/exact-note-path-resolver.js";
import { handleRpcRequest, type RpcHandlerRuntimeLike } from "../src/service/rpc-handler.js";
import { createCustomServicePolicy } from "../src/service/service-policy.js";
import { createSystemdCredentialKeyStore } from "../src/keystore/systemd-credential-keystore.js";
import {
  markRealCoreModule,
  type NotesnookRealCoreModule,
} from "../src/core/notesnook-core-adapter.js";
import { NotesnookReadOnlyProjectionError } from "../src/core/notesnook-readonly-projection.js";
import { NotesnookWriteContractError } from "../src/core/notesnook-write-contract.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";

const PROOF_PATH = "General/Canary";
const REVISION = "rev_0123456789abcdef0123456789abcdef";
const ALL = ["notes.get", "notes.update", "notes.delete"];
const locked = () => {
  throw new NotesnookWriteContractError("vault_locked");
};

function deps(lock: "locked" | "unlocked" | Error, over: Record<string, unknown> = {}) {
  return {
    resolveNotePath: vi.fn(async () => ({
      id: "note-1",
      expectedRevision: REVISION,
      pinned: false,
    })),
    readNoteLockState: vi.fn(async () => {
      if (lock instanceof Error) throw lock;
      return lock;
    }),
    updateNote: vi.fn(async () => locked()),
    deleteNote: vi.fn(async () => locked()),
    ...over,
  };
}
const proofRequest = (): RpcRequest =>
  ({ id: "p-1", method: "notes.locked_note_proof", params: { path: PROOF_PATH } }) as RpcRequest;
function rpcRuntime(
  lockedNoteProof: unknown,
  extra: Record<string, unknown> = {},
): RpcHandlerRuntimeLike {
  return {
    search: async () => [],
    status: async () => ({ lastSynced: 0, hasUnsyncedChanges: false }),
    listNotebooks: async () => [],
    noteMetadata: async () => undefined,
    resolveNotePath: vi.fn(async () => ({ id: "note-1", expectedRevision: REVISION })),
    updateNote: vi.fn(),
    deleteNote: vi.fn(),
    appendNote: vi.fn(),
    createNote: vi.fn(),
    lockedNoteProof,
    ...extra,
  } as unknown as RpcHandlerRuntimeLike;
}
function expectZeroRuntimeCalls(rt: RpcHandlerRuntimeLike, proof: ReturnType<typeof vi.fn>) {
  const r = rt as unknown as Record<string, ReturnType<typeof vi.fn>>;
  expect(proof).toHaveBeenCalledTimes(0);
  for (const k of ["updateNote", "deleteNote", "appendNote", "createNote"])
    expect(r[k]).toHaveBeenCalledTimes(0);
}

describe("D4-2 — the proof never mutates an unlocked note", () => {
  it("unlocked target: permission_denied for update/delete, zero mutator calls", async () => {
    const d = deps("unlocked");
    const r = await createLockedNoteProof(d)(PROOF_PATH);
    expect(r).toEqual({
      kind: "locked_note_proof",
      pathBytes: Buffer.byteLength(PROOF_PATH),
      read: "ok",
      update: "permission_denied",
      delete: "permission_denied",
    });
    expect(d.updateNote).toHaveBeenCalledTimes(0);
    expect(d.deleteNote).toHaveBeenCalledTimes(0);
  });
  it("locked target: vault_locked x3, probes use a mismatched well-formed revision", async () => {
    const d = deps("locked");
    const r = await createLockedNoteProof(d)(PROOF_PATH);
    expect([r.read, r.update, r.delete]).toEqual(["vault_locked", "vault_locked", "vault_locked"]);
    for (const spy of [d.updateNote, d.deleteNote] as unknown as Array<{
      mock: { calls: Array<[{ expectedRevision: string }]> };
    }>) {
      expect(spy).toHaveBeenCalledTimes(1);
      const rev = spy.mock.calls[0]![0].expectedRevision;
      expect(rev).toMatch(/^rev_[0-9a-f]{32}$/);
      expect(rev).not.toBe(REVISION);
    }
  });
  it("locked but update probe resolves: delete probe is never attempted", async () => {
    const d = deps("locked", { updateNote: vi.fn(async () => ({})) });
    const r = await createLockedNoteProof(d)(PROOF_PATH);
    expect(r.update).toBe("ok");
    expect(r.delete).toBe("service_unavailable");
    expect(d.deleteNote).toHaveBeenCalledTimes(0);
  });
  it("locked, update rejects stale: update service_unavailable, no delete", async () => {
    const d = deps("locked", {
      updateNote: vi.fn(async () => {
        throw new NotesnookWriteContractError("stale_revision");
      }),
    });
    const r = await createLockedNoteProof(d)(PROOF_PATH);
    expect(r.update).toBe("service_unavailable");
    expect(d.deleteNote).toHaveBeenCalledTimes(0);
  });
  it("lock probe failure: service_unavailable x3, zero mutator calls", async () => {
    const d = deps(new Error("boom"));
    const r = await createLockedNoteProof(d)(PROOF_PATH);
    expect([r.read, r.update, r.delete]).toEqual([
      "service_unavailable",
      "service_unavailable",
      "service_unavailable",
    ]);
    expect(d.updateNote).toHaveBeenCalledTimes(0);
    expect(d.deleteNote).toHaveBeenCalledTimes(0);
  });
  it("malformed resolution revision on a locked note: no probes", async () => {
    const d = deps("locked", {
      resolveNotePath: vi.fn(async () => ({ id: "note-1", expectedRevision: "bad" })),
    });
    const r = await createLockedNoteProof(d)(PROOF_PATH);
    expect([r.update, r.delete]).toEqual(["service_unavailable", "service_unavailable"]);
    expect(d.updateNote).toHaveBeenCalledTimes(0);
    expect(d.deleteNote).toHaveBeenCalledTimes(0);
  });
  it("result is closed: exact keys, no id, revision, or path text", async () => {
    const r = await createLockedNoteProof(deps("unlocked"))(PROOF_PATH);
    expect(Object.keys(r)).toEqual(["kind", "pathBytes", "read", "update", "delete"]);
    const json = JSON.stringify(r);
    for (const s of ["note-1", REVISION, "General", "Canary"]) expect(json).not.toContain(s);
  });
});

describe("D4-2 — rpc-handler branches", () => {
  it("no evaluator: permission_denied, zero runtime calls (proof is never allowlistable)", async () => {
    const proof = vi.fn();
    const rt = rpcRuntime(proof);
    const res = await handleRpcRequest(proofRequest(), rt, createCustomServicePolicy(ALL));
    expect(res).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expectZeroRuntimeCalls(rt, proof);
    expect(
      (rt as unknown as { resolveNotePath: ReturnType<typeof vi.fn> }).resolveNotePath,
    ).toHaveBeenCalledTimes(0);
  });
  it("evaluator present, delete denied by settings: permission_denied, zero runtime calls", async () => {
    const proof = vi.fn();
    const rt = rpcRuntime(proof);
    const policy = createCustomServicePolicy(ALL, (op) => ({ allowed: op !== "delete" }));
    const res = await handleRpcRequest(proofRequest(), rt, policy);
    expect(res).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expectZeroRuntimeCalls(rt, proof);
  });
  it("evaluator present, notes.delete not allowlisted: permission_denied, zero runtime calls", async () => {
    const proof = vi.fn();
    const rt = rpcRuntime(proof);
    const policy = createCustomServicePolicy(["notes.get", "notes.update"], () => ({
      allowed: true,
    }));
    const res = await handleRpcRequest(proofRequest(), rt, policy);
    expect(res).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expectZeroRuntimeCalls(rt, proof);
  });
  it("evaluator allows all, unlocked note: permission_denied for update/delete, zero mutations", async () => {
    const d = deps("unlocked");
    const rt = rpcRuntime(createLockedNoteProof(d));
    const res = await handleRpcRequest(
      proofRequest(),
      rt,
      createCustomServicePolicy(ALL, () => ({ allowed: true })),
    );
    expect(res).toMatchObject({
      ok: true,
      result: {
        kind: "locked_note_proof",
        read: "ok",
        update: "permission_denied",
        delete: "permission_denied",
      },
    });
    expect(d.updateNote).toHaveBeenCalledTimes(0);
    expect(d.deleteNote).toHaveBeenCalledTimes(0);
  });
  it("evaluator allows all, locked note: vault_locked x3", async () => {
    const d = deps("locked");
    const rt = rpcRuntime(createLockedNoteProof(d));
    const res = await handleRpcRequest(
      proofRequest(),
      rt,
      createCustomServicePolicy(ALL, () => ({ allowed: true })),
    );
    expect(res).toMatchObject({
      ok: true,
      result: { read: "vault_locked", update: "vault_locked", delete: "vault_locked" },
    });
  });
});

describe("D4-2 — unresolved exact path", () => {
  it("not_found x3 and no lock read or mutation when the resolver rejects not_found", async () => {
    const d = deps("unlocked", {
      resolveNotePath: vi.fn(async () => {
        throw new ExactNotePathError("not_found");
      }),
    });
    const r = await createLockedNoteProof(d)(PROOF_PATH);
    expect(r).toEqual({
      kind: "locked_note_proof",
      pathBytes: Buffer.byteLength(PROOF_PATH),
      read: "not_found",
      update: "not_found",
      delete: "not_found",
    });
    expect(d.readNoteLockState).toHaveBeenCalledTimes(0);
    expect(d.updateNote).toHaveBeenCalledTimes(0);
    expect(d.deleteNote).toHaveBeenCalledTimes(0);
  });
});

describe("D4-4 — every exact-path error code maps to a closed proof result", () => {
  // A Record keyed by ExactNotePathErrorCode makes the table exhaustive at
  // compile time: adding a resolver code without deciding its proof mapping
  // fails the typecheck instead of silently falling through to a generic case.
  const expectations: Readonly<
    Record<ExactNotePathErrorCode, "not_found" | "service_unavailable">
  > = {
    invalid_path: "service_unavailable",
    not_found: "not_found",
    ambiguous: "service_unavailable",
    source_unavailable: "service_unavailable",
  };

  it.each(
    Object.entries(expectations) as Array<
      [ExactNotePathErrorCode, "not_found" | "service_unavailable"]
    >,
  )(
    "%s maps to %s for read, update, and delete with zero mutator calls",
    async (code, expected) => {
      const d = deps("unlocked", {
        resolveNotePath: vi.fn(async () => {
          throw new ExactNotePathError(code);
        }),
      });
      const r = await createLockedNoteProof(d)(PROOF_PATH);
      expect(r).toEqual({
        kind: "locked_note_proof",
        pathBytes: Buffer.byteLength(PROOF_PATH),
        read: expected,
        update: expected,
        delete: expected,
      });
      expect(d.readNoteLockState).toHaveBeenCalledTimes(0);
      expect(d.updateNote).toHaveBeenCalledTimes(0);
      expect(d.deleteNote).toHaveBeenCalledTimes(0);
    },
  );
});

describe("D4-2 — vault-locked read refusal branch", () => {
  it("treats a projection-owned vault_locked read error as a locked target and probes with a mismatched revision", async () => {
    // A locked record is refused on the READ path by the projection, which
    // throws its own `vault_locked` error.  The proof must recognise that
    // class (not just an adapter error), otherwise a working lock is reported
    // as `service_unavailable` and the acceptance criterion is unprovable.
    const refusal = new NotesnookReadOnlyProjectionError("vault_locked");
    const d = deps(refusal);
    const r = await createLockedNoteProof(d)(PROOF_PATH);
    expect([r.read, r.update, r.delete]).toEqual(["vault_locked", "vault_locked", "vault_locked"]);
    expect(d.readNoteLockState).toHaveBeenCalledTimes(1);
    for (const spy of [d.updateNote, d.deleteNote] as unknown as Array<{
      mock: { calls: Array<[{ expectedRevision: string }]> };
    }>) {
      expect(spy).toHaveBeenCalledTimes(1);
      const rev = spy.mock.calls[0]![0].expectedRevision;
      expect(rev).toMatch(/^rev_[0-9a-f]{32}$/);
      expect(rev).not.toBe(REVISION);
    }
  });

  it("still reports a non-vault read error as service_unavailable x3 (generic control)", async () => {
    const d = deps(new NotesnookReadOnlyProjectionError("note lock state is unavailable"));
    const r = await createLockedNoteProof(d)(PROOF_PATH);
    expect([r.read, r.update, r.delete]).toEqual([
      "service_unavailable",
      "service_unavailable",
      "service_unavailable",
    ]);
    expect(d.updateNote).toHaveBeenCalledTimes(0);
    expect(d.deleteNote).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// D4-2 — production runtime wiring
//
// The proof tests above exercise the extracted factory directly.  These cover
// the *wiring* the daemon actually uses: `createProductionServiceRuntime` must
// expose `lockedNoteProof` built from the projection-owned lock reader and the
// bounded `updateNote` / `deleteNote` capabilities, never the raw collection
// mutators.  The fake real-core module keeps this fully offline — no auth, no
// network, no live Notesnook state.
// ---------------------------------------------------------------------------

type WiringCalls = {
  readonly note: string[];
  readonly contentFind: string[];
  readonly update: string[];
  readonly delete: string[];
};

function createWiringFakeDatabase(locked: boolean): {
  database: Record<string, unknown>;
  calls: WiringCalls;
} {
  const calls: WiringCalls = { note: [], contentFind: [], update: [], delete: [] };
  const note = {
    id: "note-1",
    title: "Canary",
    notebookId: "general-id",
    pinned: false,
    favorite: false,
    conflicted: false,
    locked: false,
    dateEdited: 1_700_000_000_000,
  };
  const content = locked
    ? { id: "content-1", noteId: "note-1", type: "tiptap", data: "<p>canary</p>", locked: true }
    : undefined;
  const tags = new Map<string, { id: string; title: string }>();
  const database: Record<string, unknown> = {
    setup: () => undefined,
    host: () => undefined,
    init: async () => undefined,
    user: {
      authenticateEmail: async () => undefined,
      authenticateMultiFactorCode: async () => undefined,
      authenticatePassword: async () => undefined,
      _login: async () => undefined,
      getUser: async () => undefined,
      logout: async () => undefined,
    },
    tokenManager: {
      getToken: async () => undefined,
      _refreshToken: async () => undefined,
    },
    kv: () => ({
      read: async () => undefined,
      write: async () => undefined,
      delete: async () => undefined,
    }),
    syncer: { start: async () => true },
    lastSynced: async () => 0,
    hasUnsyncedChanges: async () => false,
    notes: {
      note: async (id: string) => {
        calls.note.push(id);
        return id === "note-1" ? { ...note } : undefined;
      },
      add: async () => "note-created",
      addToNotebook: async () => undefined,
      removeFromNotebook: async () => undefined,
      moveToTrash: async (...ids: string[]) => {
        calls.delete.push(...ids);
      },
      collection: {
        update: async (ids: readonly string[]) => {
          calls.update.push(...ids);
        },
      },
    },
    content: {
      add: async () => "content-created",
      findByNoteId: async (noteId: string) => {
        calls.contentFind.push(noteId);
        return noteId === "note-1" && content !== undefined ? { ...content } : undefined;
      },
      updateByNoteId: async () => undefined,
    },
    notebooks: {
      all: { ids: async () => ["general-id"] },
      notebook: async (id: string) =>
        id === "general-id" ? { id, title: "General", dateEdited: 1 } : undefined,
      breadcrumbs: async (id: string) => (id === "general-id" ? [{ id, title: "General" }] : []),
      notes: async (id: string) => (id === "general-id" ? ["note-1"] : []),
      exists: async (id: string) => id === "general-id",
    },
    tags: {
      tag: async (id: string) => tags.get(id),
      add: async ({ title }: { title: string }) => {
        const id = `tag-${tags.size + 1}`;
        tags.set(id, { id, title });
        return id;
      },
    },
    relations: {
      add: async () => undefined,
      unlink: async () => undefined,
      from: (reference: { id: string; type: string }) => ({
        get: async () => [],
        has: async (noteId: string) =>
          reference.type === "notebook" && reference.id === "general-id" && noteId === "note-1",
      }),
    },
    lookup: {
      notes: async (title: string) => ({ ids: async () => (title === "Canary" ? ["note-1"] : []) }),
      notebooks: async () => ({ ids: async () => [] }),
    },
  };
  return { database, calls };
}

async function withWiredProductionRuntime(
  locked: boolean,
  body: (runtime: ServiceRuntime, calls: WiringCalls) => Promise<void>,
): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-locked-proof-wiring-"));
  const credentialsDir = mkdtempSync(join(tmpdir(), "nookbridge-locked-proof-creds-"));
  writeFileSync(join(credentialsDir, "nookbridge-db-key"), "locked-proof-wiring-key", {
    mode: 0o600,
  });
  const { database, calls } = createWiringFakeDatabase(locked);
  const ctor = vi.fn(function FakeDatabaseCtor() {
    return database;
  });
  const injectedModule = markRealCoreModule({
    Database: ctor as unknown as NotesnookRealCoreModule["Database"],
  });
  const keys = createSystemdCredentialKeyStore({ credentialsDirectory: credentialsDir });
  let runtime: ServiceRuntime | undefined;
  try {
    runtime = await createProductionServiceRuntime({ stateDir, keys, injectedModule });
    await body(runtime, calls);
  } finally {
    if (runtime) await runtime.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(credentialsDir, { recursive: true, force: true });
  }
}

const WIRING_PATH = "General/Canary";

describe("D4-2 — production runtime wiring", () => {
  it("exposes lockedNoteProof wired to the lock reader and bounded mutators (unlocked control)", async () => {
    await withWiredProductionRuntime(false, async (runtime, calls) => {
      expect(typeof runtime.lockedNoteProof).toBe("function");
      const result = await runtime.lockedNoteProof!(WIRING_PATH);
      expect(result).toEqual({
        kind: "locked_note_proof",
        pathBytes: Buffer.byteLength(WIRING_PATH, "utf8"),
        read: "ok",
        update: "permission_denied",
        delete: "permission_denied",
      });
      expect(calls.update).toEqual([]);
      expect(calls.delete).toEqual([]);
    });
  });

  it("reads the vault lock through the projection and probes both wired mutators for a locked note", async () => {
    await withWiredProductionRuntime(true, async (runtime, calls) => {
      const result = await runtime.lockedNoteProof!(WIRING_PATH);
      expect([result.read, result.update, result.delete]).toEqual([
        "vault_locked",
        "vault_locked",
        "vault_locked",
      ]);
      // The bounded write capability refuses the locked note before any
      // collection mutator runs, so neither mutator applied a change.
      expect(calls.update).toEqual([]);
      expect(calls.delete).toEqual([]);
    });
  });
});
