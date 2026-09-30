/**
 * Stage 4 follow-up — startup reconciliation wiring.
 *
 * A local mutation can succeed while its sync-intent marker fails to be
 * durably recorded (a crash in the window between the two, or a persistence
 * I/O failure). `SyncCoordinator.reconcilePendingFromSnapshot` closes this at
 * the pure-function level; these tests prove it is actually WIRED into
 * `createNotesnookLiveCoreFactory`'s startup path — not merely a resolver
 * that would pass its own unit tests if the call site were removed.
 */

import { describe, expect, it } from "vitest";

import { createNotesnookLiveCoreFactory, type NotesnookRealCoreModule } from "../src/index.js";
import type { NotesnookReconciliationFailure } from "../src/core/notesnook-live-factory.js";
import {
  markRealCoreModule,
  type NotesnookSQLiteDialect,
} from "../src/core/notesnook-core-adapter.js";
import type { SyncCoordinatorState } from "../src/core/notesnook-sync-coordinator.js";

const NOTE_ORPHAN = "orphan-note-0000000000000001";
const NOTE_KNOWN = "known-note-00000000000000001";

interface FakeStorageValue {
  read: unknown[];
  write: unknown[];
}

function noopIStorage() {
  const values = new Map<string, unknown>();
  return {
    write: async <T>(key: string, data: T) => {
      values.set(key, data);
    },
    writeMulti: async <T>(entries: [string, T][]) => {
      for (const [key, data] of entries) values.set(key, data);
    },
    readMulti: async <T>(keys: string[]) =>
      keys.map((key) => [key, values.get(key) as T] as [string, T]),
    read: async <T>(key: string) => values.get(key) as T | undefined,
    remove: async (key: string) => {
      values.delete(key);
    },
    removeMulti: async (keys: string[]) => {
      for (const key of keys) values.delete(key);
    },
    clear: async () => {
      values.clear();
    },
    getAllKeys: async () => [...values.keys()],
    encrypt: async () => ({
      format: "base64",
      alg: "xchacha20-poly1305",
      cipher: "",
      iv: "",
      salt: "",
      length: 0,
    }),
    encryptMulti: async () => [],
    decrypt: async () => "",
    decryptMulti: async () => [],
    deriveCryptoKey: async () => undefined,
    hash: async () => "",
    getCryptoKey: async () => undefined,
  };
}

/** Minimal live database: satisfies the write-runtime surface plus notes.all.ids(). */
function buildFakeLiveDatabase(noteIds: readonly string[]): object {
  const kvStorage: FakeStorageValue = { read: [], write: [] };
  return {
    user: {
      authenticateEmail: async () => ({ ok: true }),
      authenticateMultiFactorCode: async () => ({ ok: true }),
      authenticatePassword: async () => undefined,
      _login: async () => undefined,
      getUser: async () => ({ id: "u-1", email: "alice@example.test" }),
      logout: async () => undefined,
    },
    tokenManager: {
      getToken: async () => ({
        access_token: "fake-access",
        refresh_token: "fake-refresh",
        expires_in: 3600,
        scope: "notes",
        t: Date.now(),
      }),
      _refreshToken: async () => undefined,
    },
    kv: () => ({
      read: async (key: string) => {
        kvStorage.read.push(key);
        return undefined;
      },
      write: async (key: string, value: unknown) => {
        kvStorage.write.push({ key, value });
      },
      delete: async () => undefined,
    }),
    notes: {
      all: { ids: async () => [...noteIds] },
      note: async () => null,
      add: async () => "new-note",
      addToNotebook: async () => undefined,
      removeFromNotebook: async () => undefined,
      collection: { update: async () => undefined },
    },
    content: {
      add: async () => "content-1",
      findByNoteId: async () => null,
      updateByNoteId: async () => undefined,
    },
    notebooks: {
      exists: async () => false,
      notes: async () => [],
    },
    tags: {
      tag: async () => undefined,
      add: async () => "tag-1",
    },
    relations: {
      add: async () => undefined,
      unlink: async () => undefined,
      from: () => ({ get: async () => [] }),
    },
    syncer: { start: async () => true },
    lastSynced: async () => 0,
    hasUnsyncedChanges: async () => false,
  };
}

function buildFakeModule(db: object): NotesnookRealCoreModule {
  const ctor = function Ctor(this: Record<string, unknown>) {
    Object.assign(this, db, {
      setup: () => undefined,
      init: async () => undefined,
      host: () => undefined,
    });
  };
  return markRealCoreModule({
    Database: ctor as unknown as NotesnookRealCoreModule["Database"],
  });
}

function noopSqliteOptions() {
  const dialectStub: NotesnookSQLiteDialect = {
    createAdapter: () => undefined,
    createDriver: () => undefined,
    createIntrospector: () => undefined,
    createQueryCompiler: () => undefined,
  };
  const dialectFn = () => dialectStub;
  return {
    dialect: dialectFn as unknown as (
      name: string,
      init?: () => Promise<void>,
    ) => NotesnookSQLiteDialect,
  };
}

function noopFileStorage() {
  const meta = { chunkSize: 0, iv: "", size: 0, salt: "", alg: "", hash: "", hashType: "" };
  return {
    downloadFile: () => ({ execute: async () => true, cancel: async () => undefined }),
    uploadFile: () => ({ execute: async () => true, cancel: async () => undefined }),
    readEncrypted: async () => undefined,
    writeEncryptedBase64: async () => meta,
    deleteFile: async () => true,
    exists: async () => true,
    bulkExists: async () => [],
    getUploadedFileSize: async () => 0,
    clearFileStorage: async () => undefined,
    hashBase64: async () => ({ hash: "", type: "" }),
  };
}

function noopCompressor() {
  return {
    compress: async (data: string) => data,
    decompress: async (data: string) => data,
  };
}

function noopEventSource() {
  function FakeEventSource(this: unknown) {
    Object.defineProperty(this, "close", { value: () => undefined });
  }
  return FakeEventSource;
}

function buildValidSetupOptions() {
  return {
    sqliteOptions: noopSqliteOptions(),
    storage: noopIStorage(),
    fs: noopFileStorage(),
    compressor: noopCompressor(),
    batchSize: 50,
    eventsource: noopEventSource(),
  };
}

/** An in-memory `SyncMetadataStateStore` seeded with a known pending state. */
function seededStateStore(initial: SyncCoordinatorState) {
  let state: SyncCoordinatorState = initial;
  return {
    load: () => state,
    save: (next: SyncCoordinatorState) => {
      state = next;
    },
    current: () => state,
  };
}

describe("Stage 4 follow-up — reconciliation is wired into factory startup", () => {
  it("re-queues an orphaned note id that exists locally but was never recorded as pending", async () => {
    const store = seededStateStore({
      pending: [],
      knownNoteIds: [NOTE_KNOWN],
    });
    const db = buildFakeLiveDatabase([NOTE_KNOWN, NOTE_ORPHAN]);
    const injectedModule = buildFakeModule(db);

    const handle = await createNotesnookLiveCoreFactory({
      injectedModule,
      setup: buildValidSetupOptions(),
      syncStateStore: store,
      onCleanup: () => undefined,
    } as never);

    expect(handle.localWrite).toBeDefined();

    // The orphaned note (present in the live database, absent from both the
    // last known inventory and the pending queue) must now be queued for
    // sync. This assertion is only true if reconciliation actually ran
    // during factory startup — the pure resolver being correct in isolation
    // is not sufficient.
    const persisted = store.current();
    expect(persisted.pending.some((marker) => marker.noteId === NOTE_ORPHAN)).toBe(true);
    expect(persisted.knownNoteIds).toContain(NOTE_ORPHAN);
    expect(persisted.knownNoteIds).toContain(NOTE_KNOWN);
  });

  it("is a no-op when the live inventory already matches the known snapshot", async () => {
    const store = seededStateStore({
      pending: [],
      knownNoteIds: [NOTE_KNOWN],
    });
    const db = buildFakeLiveDatabase([NOTE_KNOWN]);
    const injectedModule = buildFakeModule(db);

    await createNotesnookLiveCoreFactory({
      injectedModule,
      setup: buildValidSetupOptions(),
      syncStateStore: store,
      onCleanup: () => undefined,
    } as never);

    const persisted = store.current();
    expect(persisted.pending).toEqual([]);
    expect(persisted.knownNoteIds).toEqual([NOTE_KNOWN]);
  });

  it("reports a bounded inventory-read failure without blocking startup, even if the diagnostic callback throws", async () => {
    const store = seededStateStore({ pending: [], knownNoteIds: [] });
    const db = buildFakeLiveDatabase([]);
    // Break the notes.all.ids() shape after construction so reconciliation's
    // read throws; startup must still succeed and expose only a closed reason.
    (db as { notes: { all: unknown } }).notes.all = undefined;
    const injectedModule = buildFakeModule(db);
    const reported: NotesnookReconciliationFailure[] = [];

    await expect(
      createNotesnookLiveCoreFactory({
        injectedModule,
        setup: buildValidSetupOptions(),
        syncStateStore: store,
        onCleanup: () => undefined,
        onReconciliationFailure: (reason: NotesnookReconciliationFailure) => reported.push(reason),
      } as never),
    ).resolves.toBeDefined();
    expect(reported).toEqual(["inventory_read_failed"]);

    await expect(
      createNotesnookLiveCoreFactory({
        injectedModule,
        setup: buildValidSetupOptions(),
        syncStateStore: store,
        onCleanup: () => undefined,
        onReconciliationFailure: () => {
          throw new Error("diagnostic callback failure");
        },
      } as never),
    ).resolves.toBeDefined();
  });

  it("reports an inventory-over-limit failure with a closed reason", async () => {
    const reported: NotesnookReconciliationFailure[] = [];
    const tooManyIds = Array.from({ length: 100_001 }, () => NOTE_KNOWN);
    const injectedModule = buildFakeModule(buildFakeLiveDatabase(tooManyIds));

    await expect(
      createNotesnookLiveCoreFactory({
        injectedModule,
        setup: buildValidSetupOptions(),
        syncStateStore: seededStateStore({ pending: [], knownNoteIds: [] }),
        onCleanup: () => undefined,
        onReconciliationFailure: (reason: NotesnookReconciliationFailure) => reported.push(reason),
      } as never),
    ).resolves.toBeDefined();
    expect(reported).toEqual(["inventory_too_large"]);
  });

  it("reports a bounded state-persistence failure without exposing its raw error", async () => {
    const reported: NotesnookReconciliationFailure[] = [];
    const db = buildFakeLiveDatabase([NOTE_KNOWN, NOTE_ORPHAN]);
    const injectedModule = buildFakeModule(db);
    const syncStateStore = {
      load: () => ({ pending: [], knownNoteIds: [NOTE_KNOWN] }),
      save: () => {
        throw new Error("private storage error detail");
      },
    };

    await expect(
      createNotesnookLiveCoreFactory({
        injectedModule,
        setup: buildValidSetupOptions(),
        syncStateStore,
        onCleanup: () => undefined,
        onReconciliationFailure: (reason: NotesnookReconciliationFailure) => reported.push(reason),
      } as never),
    ).resolves.toBeDefined();
    expect(reported).toEqual(["state_reconciliation_failed"]);
  });
});
