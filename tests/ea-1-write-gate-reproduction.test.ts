/**
 * EA-1 — reproduction of the reported "writes refused while
 * `hasUnsyncedChanges` is true, accepted again after an explicit sync" gate.
 *
 * The level under test is the daemon's own: `createProductionServiceRuntime`
 * over a fake `@notesnook/core` module, so the REAL live factory, shared
 * `SyncCoordinator`, local-write composition, write adapter and service
 * runtime wrappers run, and every call is driven through `handleRpcRequest`
 * with a write-capable policy. Only the Notesnook database is a synthetic
 * in-memory fake; every title and body below is invented.
 *
 * The fake reports `hasUnsyncedChanges: true` from the first local write
 * until its syncer completes a `full` run, as the live database does, so the
 * reported symptom can be set up exactly: a daemon that says it has unsynced
 * changes. The tests then separate the two candidate mechanisms:
 *
 *   - a gate tied to `hasUnsyncedChanges`: refuted by the control cases,
 *     which write successfully while the status is `true`;
 *   - a bounded capacity on pending change markers: reproduced by filling the
 *     queue to its published bound (`MAX_PENDING_MARKERS`,
 *     src/core/notesnook-sync-coordinator.ts:23) and showing the next create
 *     and update are refused until an explicit sync drains it. The refusal is
 *     raised by `checkMutationCapacity`
 *     (src/core/notesnook-write-composition.ts:1394-1407).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { releaseLock } from "../src/config/lock.js";
import {
  markRealCoreModule,
  type NotesnookRealCoreModule,
} from "../src/core/notesnook-core-adapter.js";
import { MAX_PENDING_MARKERS } from "../src/core/notesnook-sync-coordinator.js";
import { createRevisionToken } from "../src/core/notesnook-write-contract.js";
import { createSystemdCredentialKeyStore } from "../src/keystore/systemd-credential-keystore.js";
import { handleRpcRequest } from "../src/service/rpc-handler.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import {
  createProductionServiceRuntime,
  type ServiceRuntime,
} from "../src/service/service-runtime.js";

/** The coordinator's own pending-marker bound, so drift in the source fails here. */
const QUEUE_CAPACITY = MAX_PENDING_MARKERS;

type FakeNote = {
  id: string;
  title: string;
  contentId?: string;
  pinned: boolean;
  favorite: boolean;
  conflicted: boolean;
  locked: boolean;
  dateEdited: number;
};

type FakeContent = { id: string; noteId: string; type: "tiptap"; data: string };

type FakeCore = {
  readonly module: NotesnookRealCoreModule;
  readonly notes: Map<string, FakeNote>;
  readonly state: { unsynced: boolean; fullRuns: number };
};

/**
 * A synthetic Notesnook database exposing the read surface the live factory
 * probes and the write collections the composition consumes.
 */
function createFakeCore(seedNotes: number): FakeCore {
  const notes = new Map<string, FakeNote>();
  const content = new Map<string, FakeContent>();
  const state = { unsynced: false, fullRuns: 0 };
  let nextId = 1;
  const mint = (prefix: string): string => `${prefix}-${nextId++}`;

  for (let index = 0; index < seedNotes; index++) {
    const id = `seed-${index}`;
    notes.set(id, {
      id,
      title: `Synthetic seed ${index}`,
      contentId: `seed-content-${index}`,
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 100,
    });
    content.set(id, {
      id: `seed-content-${index}`,
      noteId: id,
      type: "tiptap",
      data: "<p>synthetic body</p>",
    });
  }

  const emptyIds = { ids: async () => [] as string[] };
  const ctor = vi.fn(function FakeDatabaseCtor() {
    return {
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
      tokenManager: { getToken: async () => undefined, _refreshToken: async () => undefined },
      kv: () => ({
        read: async () => undefined,
        write: async () => undefined,
        delete: async () => undefined,
      }),
      syncer: {
        start: async (request: { type?: string }) => {
          if (request.type === "full") {
            state.fullRuns += 1;
            state.unsynced = false;
          }
          return true;
        },
      },
      notebooks: {
        all: emptyIds,
        breadcrumbs: async () => [],
        notebook: async () => undefined,
        exists: async () => false,
        notes: async () => [] as string[],
      },
      notes: {
        note: async (id: string) => {
          const found = notes.get(id);
          return found === undefined ? undefined : { ...found };
        },
        add: async (item: { title: string; content?: { type: "tiptap"; data: string } }) => {
          const id = mint("note");
          const contentId = mint("content");
          notes.set(id, {
            id,
            title: item.title,
            contentId,
            pinned: false,
            favorite: false,
            conflicted: false,
            locked: false,
            dateEdited: 1_000,
          });
          content.set(id, {
            id: contentId,
            noteId: id,
            type: "tiptap",
            data: item.content?.data ?? "",
          });
          state.unsynced = true;
          return id;
        },
        addToNotebook: async () => undefined,
        removeFromNotebook: async () => undefined,
        collection: {
          update: async (ids: readonly string[], partial: Record<string, unknown>) => {
            for (const id of ids) {
              const note = notes.get(id);
              if (note === undefined) continue;
              if (typeof partial.title === "string") note.title = partial.title;
              note.dateEdited += 1;
            }
            state.unsynced = true;
          },
        },
      },
      content: {
        add: async (partial: Record<string, unknown>) => {
          const id = mint("content");
          const noteId = partial.noteId as string;
          content.set(noteId, {
            id,
            noteId,
            type: "tiptap",
            data: (partial.data as string) ?? "",
          });
          state.unsynced = true;
          return id;
        },
        findByNoteId: async (noteId: string) => {
          const found = content.get(noteId);
          return found === undefined ? undefined : { ...found };
        },
        updateByNoteId: async (partial: Record<string, unknown>, ...ids: string[]) => {
          for (const noteId of ids) {
            const existing = content.get(noteId);
            if (existing !== undefined && typeof partial.data === "string") {
              existing.data = partial.data;
            }
          }
          state.unsynced = true;
        },
      },
      tags: {
        tag: async () => undefined,
        add: async () => mint("tag"),
      },
      relations: {
        add: async () => undefined,
        unlink: async () => undefined,
        from: () => ({ get: async () => [] as unknown[] }),
      },
      lookup: { notes: async () => emptyIds, notebooks: async () => emptyIds },
      lastSynced: async () => 0,
      hasUnsyncedChanges: async () => state.unsynced,
    };
  });
  return {
    module: markRealCoreModule({
      Database: ctor as unknown as NotesnookRealCoreModule["Database"],
    }),
    notes,
    state,
  };
}

type Harness = { readonly runtime: ServiceRuntime; readonly core: FakeCore };

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startDaemon(seedNotes: number): Promise<Harness> {
  const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-ea1-state-"));
  writeFileSync(join(stateDir, "db.key"), "ea-1-synthetic-development-key", { mode: 0o600 });
  const credentialsDir = mkdtempSync(join(tmpdir(), "nookbridge-ea1-creds-"));
  writeFileSync(join(credentialsDir, "nookbridge-db-key"), "ea-1-synthetic-runtime-key", {
    mode: 0o600,
  });
  const core = createFakeCore(seedNotes);
  const runtime = await createProductionServiceRuntime({
    stateDir,
    keys: createSystemdCredentialKeyStore({ credentialsDirectory: credentialsDir }),
    injectedModule: core.module,
  });
  cleanups.push(async () => {
    await runtime.cleanup();
    releaseLock(stateDir);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(credentialsDir, { recursive: true, force: true });
  });
  return { runtime, core };
}

const policy = createReadWriteNoDeleteServicePolicy();

async function rpcCreate(runtime: ServiceRuntime, n: number) {
  const request = {
    id: `create-${n}`,
    method: "notes.create",
    params: { title: `Synthetic note ${n}`, content: "synthetic body" },
  } as RpcRequest;
  return handleRpcRequest(request, runtime, policy);
}

async function rpcUpdate(runtime: ServiceRuntime, noteId: string, dateEdited: number, n: number) {
  const request = {
    id: `update-${n}`,
    method: "notes.update",
    params: {
      id: noteId,
      expectedRevision: createRevisionToken({ id: noteId, dateEdited }),
      patch: { title: `Synthetic retitle ${n}` },
    },
  } as RpcRequest;
  return handleRpcRequest(request, runtime, policy);
}

async function rpcStatus(runtime: ServiceRuntime) {
  const response = await handleRpcRequest(
    { id: "status", method: "notes.status", params: {} } as RpcRequest,
    runtime,
    policy,
  );
  if (!response.ok) throw new Error("status refused");
  return response.result as { hasUnsyncedChanges: boolean };
}

describe("EA-1 write gate reproduction (daemon level)", () => {
  it("control: writes succeed while the daemon reports hasUnsyncedChanges true", async () => {
    const { runtime, core } = await startDaemon(2);

    expect((await rpcCreate(runtime, 0)).ok).toBe(true);
    expect(core.state.unsynced).toBe(true);
    expect((await rpcStatus(runtime)).hasUnsyncedChanges).toBe(true);

    // The reported symptom needs `hasUnsyncedChanges: true`; it is true here,
    // so a gate tied to that flag would already refuse these.
    expect((await rpcCreate(runtime, 1)).ok).toBe(true);
    const update = await rpcUpdate(runtime, "seed-0", 100, 0);
    expect(update.ok, JSON.stringify(update)).toBe(true);
    expect((await rpcStatus(runtime)).hasUnsyncedChanges).toBe(true);
  });

  it("a full pending queue refuses create and update as sync_required, mutating nothing, until an explicit sync", async () => {
    const { runtime, core } = await startDaemon(2);

    for (let n = 0; n < QUEUE_CAPACITY; n++) {
      const created = await rpcCreate(runtime, n);
      expect(created.ok, `create ${n}`).toBe(true);
    }
    expect((await rpcStatus(runtime)).hasUnsyncedChanges).toBe(true);

    // Reported symptom, both halves, with the queue at its bound. Before the
    // taxonomy split the same refusal surfaced as `service_unavailable` on
    // create and `invalid_request` on update; it is one condition and now
    // carries one code.
    const refusedCreate = await rpcCreate(runtime, QUEUE_CAPACITY);
    expect(refusedCreate).toMatchObject({ ok: false, error: { code: "sync_required" } });
    const refusedUpdate = await rpcUpdate(runtime, "seed-1", 100, QUEUE_CAPACITY);
    expect(refusedUpdate).toMatchObject({ ok: false, error: { code: "sync_required" } });
    // Refusals mutate nothing.
    expect(core.notes.get("seed-1")?.title).toBe("Synthetic seed 1");
    expect(core.notes.size).toBe(2 + QUEUE_CAPACITY);

    // An explicit sync drains the queue; the identical calls then succeed.
    const sync = await runtime.requestSync?.();
    expect(sync).toMatchObject({ status: "synced", pendingSync: false });
    expect(core.state.fullRuns).toBe(1);
    expect((await rpcStatus(runtime)).hasUnsyncedChanges).toBe(false);

    expect((await rpcCreate(runtime, QUEUE_CAPACITY)).ok).toBe(true);
    const retried = await rpcUpdate(runtime, "seed-1", 100, QUEUE_CAPACITY);
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
  });

  it("one slot below the bound still accepts writes with hasUnsyncedChanges true", async () => {
    const { runtime } = await startDaemon(2);

    for (let n = 0; n < QUEUE_CAPACITY - 1; n++) {
      expect((await rpcCreate(runtime, n)).ok, `create ${n}`).toBe(true);
    }
    expect((await rpcStatus(runtime)).hasUnsyncedChanges).toBe(true);
    expect((await rpcCreate(runtime, QUEUE_CAPACITY - 1)).ok).toBe(true);
  });
});
