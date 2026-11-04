/**
 * An append is two writes (advance the note's `dateEdited`, then replace its
 * content row).  A reader that looks between them would pair a new revision
 * with the old body, or the old revision with a body that is about to change.
 * The shared database lock closes that window: note snapshot reads take it,
 * appends hold it.
 *
 * Everything here runs through the real live factory, the real snapshot slot,
 * the real mutex, the real local-write composition and the real write adapter.
 * Only the Notesnook `Database` is a fake, and it is one object shared by the
 * read and write sides, so a pause inside it is a pause both sides can observe.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNotesnookLiveCoreFactory,
  type IStorage,
  type NotesnookDatabaseSetupOptions,
  type NotesnookFileEncryptionMetadataWithHash,
  type NotesnookLiveCoreHandle,
  type NotesnookRealCoreModule,
} from "../src/index.js";
import {
  markRealCoreModule,
  type NotesnookSQLiteDialect,
} from "../src/core/notesnook-core-adapter.js";
import { peekMutex, withMutex } from "../src/core/notesnook-database-mutex.js";
import type { NotesnookReadOnlyNoteSnapshot } from "../src/core/notesnook-readonly-adapter.js";
import { handleRpcRequest, type RpcHandlerRuntimeLike } from "../src/service/rpc-handler.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import { ExactNotePathError } from "../src/service/exact-note-path-resolver.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";
import { createOperatorDiscoveryRuntime } from "../src/service/operator-discovery-runtime.js";
import { createOperatorWriteSource } from "../src/nookd.js";
import { isVaultLockedRefusal } from "../src/core/notesnook-readonly-projection.js";
import type { ServiceRuntime } from "../src/service/service-runtime.js";
import {
  createRevisionToken,
  type AppendNoteCommand,
  type NotesnookRevisionToken,
} from "../src/core/notesnook-write-contract.js";
import {
  MemoryNotesnookRecoveryJournal,
  type NotesnookRecoveryJournal,
} from "../src/core/notesnook-recovery-journal.js";

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const OLD_BODY = "<p>old body</p>";
const START = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Deferred promises.
// ---------------------------------------------------------------------------

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** True while `promise` has not settled after everything runnable has run. */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await settle();
  return !done;
}

// ---------------------------------------------------------------------------
// Fake Database: one store, read and write surfaces, awaitable hooks.
// ---------------------------------------------------------------------------

interface Hooks {
  /** Runs inside `notes.collection.update`, before the store changes. */
  beforeNoteUpdate?: ((call: number) => Promise<void>) | undefined;
  /** Runs inside `notes.collection.update`, after the store changed. */
  afterNoteUpdate?: ((call: number) => Promise<void>) | undefined;
  /** Runs inside `content.updateByNoteId`, before the store changes. */
  beforeContentUpdate?: (() => Promise<void>) | undefined;
  /** Runs inside `content.findByNoteId`, before it answers. */
  insideContentRead?: ((call: number) => Promise<void>) | undefined;
}

interface World {
  readonly handle: NotesnookLiveCoreHandle;
  readonly database: object;
  readonly hooks: Hooks;
  readonly note: { dateEdited: number };
  readonly content: { data: string; locked: boolean };
  readonly calls: {
    noteReads: number;
    contentReads: number;
    noteUpdates: number[];
    contentUpdates: number;
  };
  readonly journal: NotesnookRecoveryJournal;
}

function memoryStorage(): IStorage {
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
    generateCryptoKey: async () => ({}),
    generatePGPKeyPair: async () => ({ publicKey: "", privateKey: "" }),
    decryptPGPMessage: async () => "",
    validatePGPKeyPair: async () => ({ isValid: true, message: "ok" }),
    generateCryptoKeyFallback: async () => ({}),
    deriveCryptoKeyFallback: async () => undefined,
  };
}

function setupOptions(): NotesnookDatabaseSetupOptions {
  const meta: NotesnookFileEncryptionMetadataWithHash = {
    chunkSize: 0,
    iv: "",
    size: 0,
    salt: "",
    alg: "",
    hash: "",
    hashType: "",
  };
  const dialectStub: NotesnookSQLiteDialect = {
    createAdapter: () => undefined,
    createDriver: () => undefined,
    createIntrospector: () => undefined,
    createQueryCompiler: () => undefined,
  };
  function FakeEventSource(this: unknown) {
    Object.defineProperty(this, "close", { value: () => undefined });
  }
  return {
    sqliteOptions: { dialect: (() => dialectStub) as never },
    storage: memoryStorage(),
    fs: {
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
    },
    compressor: {
      compress: async (data: string) => data,
      decompress: async (data: string) => data,
    },
    batchSize: 50,
    eventsource: FakeEventSource as never,
  };
}

async function createWorld(options: { operator?: boolean } = {}): Promise<World> {
  const note = { dateEdited: START };
  const content = { data: OLD_BODY, locked: false };
  const hooks: Hooks = {};
  const calls = { noteReads: 0, contentReads: 0, noteUpdates: [] as number[], contentUpdates: 0 };
  const journal = new MemoryNotesnookRecoveryJournal();

  const database = {
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
    syncer: { start: async () => true },
    lastSynced: async () => 0,
    hasUnsyncedChanges: async () => false,
    lookup: {
      notes: async () => ({ ids: async () => [] as string[] }),
      notebooks: async () => ({ ids: async () => [] as string[] }),
    },
    notebooks: {
      all: { ids: async () => [] as string[] },
      notebook: async () => undefined,
      exists: async () => false,
      notes: async () => [] as string[],
    },
    notes: {
      all: { ids: async () => [NOTE_ID] },
      note: async (id: string) => {
        calls.noteReads += 1;
        if (id !== NOTE_ID) return undefined;
        return {
          id,
          title: "Title",
          dateEdited: note.dateEdited,
          contentId: "content-1",
          pinned: false,
          favorite: false,
          conflicted: false,
        };
      },
      add: async () => NOTE_ID,
      addToNotebook: async () => undefined,
      removeFromNotebook: async () => undefined,
      collection: {
        update: async (_ids: string[], partial: Record<string, unknown>) => {
          const call = calls.noteUpdates.length + 1;
          calls.noteUpdates.push(call);
          await hooks.beforeNoteUpdate?.(call);
          if (typeof partial.dateEdited === "number") note.dateEdited = partial.dateEdited;
          await hooks.afterNoteUpdate?.(call);
        },
      },
    },
    content: {
      add: async () => "content-1",
      findByNoteId: async (id: string) => {
        calls.contentReads += 1;
        if (id !== NOTE_ID) return undefined;
        await hooks.insideContentRead?.(calls.contentReads);
        return {
          id: "content-1",
          noteId: id,
          type: "tiptap",
          data: content.data,
          locked: content.locked,
        };
      },
      updateByNoteId: async (partial: Record<string, unknown>) => {
        calls.contentUpdates += 1;
        await hooks.beforeContentUpdate?.();
        if (typeof partial.data === "string") content.data = partial.data;
      },
    },
    tags: { tag: async () => undefined, add: async () => "tag-1" },
    relations: {
      add: async () => undefined,
      unlink: async () => undefined,
      from: () => ({ get: async () => [] }),
    },
  };

  const module = markRealCoreModule({
    Database: function Ctor() {
      return database;
    } as unknown as NotesnookRealCoreModule["Database"],
  });
  const handle = await createNotesnookLiveCoreFactory({
    setup: setupOptions(),
    onCleanup: () => undefined,
    injectedModule: module,
    recoveryJournal: journal,
    ...(options.operator === true ? { operatorLocalWrite: true } : {}),
  });
  return { handle, database, hooks, note, content, calls, journal };
}

// ---------------------------------------------------------------------------
// Helpers over the handle.
// ---------------------------------------------------------------------------

function snapshotOf(world: World): Promise<NotesnookReadOnlyNoteSnapshot | undefined> {
  return world.handle.readOnly!.readNoteSnapshot!(NOTE_ID);
}

function tokenAt(dateEdited: number): NotesnookRevisionToken {
  return createRevisionToken({ id: NOTE_ID, dateEdited });
}

function append(world: World, expectedRevision: NotesnookRevisionToken, fragment = "new line") {
  const command: AppendNoteCommand = { id: NOTE_ID, markdownFragment: fragment, expectedRevision };
  return world.handle.localWrite!.appendNote(command);
}

function contentOf(snapshot: NotesnookReadOnlyNoteSnapshot | undefined): string {
  if (snapshot === undefined || !("content" in snapshot)) throw new Error("expected content");
  return snapshot.content.data;
}

const OLD_TOKEN = tokenAt(START);

// ---------------------------------------------------------------------------

describe("append / snapshot-read atomicity", () => {
  it("reads metadata and content as one pair when nothing is writing", async () => {
    const world = await createWorld();
    const snapshot = await snapshotOf(world);
    expect(snapshot?.metadata.revision).toBe(OLD_TOKEN);
    expect(contentOf(snapshot)).toBe(OLD_BODY);
  });

  it("returns undefined for a note that does not exist", async () => {
    const world = await createWorld();
    await expect(world.handle.readOnly!.readNoteSnapshot!("missing")).resolves.toBeUndefined();
  });

  it("keeps a snapshot read pending between the touch and the content write", async () => {
    const world = await createWorld();
    const touched = deferred();
    const release = deferred();
    world.hooks.afterNoteUpdate = async (call) => {
      if (call !== 1) return;
      touched.resolve();
      await release.promise;
    };

    const appending = append(world, OLD_TOKEN);
    await touched.promise;
    // The touch has landed in the store; the content write has not started.
    expect(world.note.dateEdited).toBeGreaterThan(START);
    expect(world.content.data).toBe(OLD_BODY);

    const reading = snapshotOf(world);
    expect(await stillPending(reading)).toBe(true);

    release.resolve();
    await appending;
    const snapshot = await reading;
    expect(snapshot?.metadata.revision).toBe(tokenAt(world.note.dateEdited));
    expect(snapshot?.metadata.revision).not.toBe(OLD_TOKEN);
    expect(contentOf(snapshot)).toContain("new line");
  });

  it("returns exactly the old pair when the content write rejects", async () => {
    const world = await createWorld();
    const failing = deferred();
    world.hooks.beforeContentUpdate = async () => {
      await failing.promise;
    };

    const appending = append(world, OLD_TOKEN);
    const outcome = appending.then(
      () => "resolved",
      () => "rejected",
    );
    await settle();
    const reading = snapshotOf(world);
    expect(await stillPending(reading)).toBe(true);

    failing.reject(new Error("content write failed"));
    expect(await outcome).toBe("rejected");

    const snapshot = await reading;
    expect(snapshot?.metadata.revision).toBe(OLD_TOKEN);
    expect(contentOf(snapshot)).toBe(OLD_BODY);
    // The note is back where it started, timestamp included.
    expect(world.note.dateEdited).toBe(START);
  });

  it("returns (new revision, old body) when the restore also rejects, and records it", async () => {
    const world = await createWorld();
    world.hooks.beforeContentUpdate = async () => {
      throw new Error("content write failed");
    };
    world.hooks.beforeNoteUpdate = async (call) => {
      if (call === 2) throw new Error("restore failed");
    };

    await expect(append(world, OLD_TOKEN)).rejects.toBeDefined();

    const snapshot = await snapshotOf(world);
    expect(snapshot?.metadata.revision).toBe(tokenAt(world.note.dateEdited));
    expect(snapshot?.metadata.revision).not.toBe(OLD_TOKEN);
    expect(contentOf(snapshot)).toBe(OLD_BODY);
    expect(world.journal.snapshot()).toEqual([
      { operation: "append", noteId: NOTE_ID, stage: "append-date" },
    ]);

    // The old token is refused, the one the note now carries is accepted.
    world.hooks.beforeContentUpdate = undefined;
    world.hooks.beforeNoteUpdate = undefined;
    await expect(append(world, OLD_TOKEN)).rejects.toMatchObject({ code: "stale_revision" });
    await expect(append(world, snapshot!.metadata.revision!)).resolves.toMatchObject({
      operation: "append",
    });
  });

  it("holds the append's touch back until a reader inside the content read releases", async () => {
    const world = await createWorld();
    const inside = deferred();
    const release = deferred();
    world.hooks.insideContentRead = async () => {
      inside.resolve();
      await release.promise;
    };

    const reading = snapshotOf(world);
    await inside.promise;
    world.hooks.insideContentRead = undefined;

    const appending = append(world, OLD_TOKEN);
    expect(await stillPending(appending)).toBe(true);
    expect(world.calls.noteUpdates).toEqual([]);

    release.resolve();
    const snapshot = await reading;
    // The reader saw the note whole, before the append.
    expect(snapshot?.metadata.revision).toBe(OLD_TOKEN);
    expect(contentOf(snapshot)).toBe(OLD_BODY);

    await appending;
    expect(world.calls.noteUpdates.length).toBe(1);
  });

  it("refuses a full update built from a pair read during an append, after a later append", async () => {
    // The defect the lock closes: a pair read between the touch and the
    // content write is (new revision, old body).  Used as the base of a full
    // update, it would carry the new token over a body that lacks the append.
    const world = await createWorld();
    const touched = deferred();
    const release = deferred();
    world.hooks.afterNoteUpdate = async (call) => {
      if (call !== 1) return;
      touched.resolve();
      await release.promise;
    };

    const first = append(world, OLD_TOKEN, "first");
    await touched.promise;
    const pair = snapshotOf(world);
    // Held back, not answered with (new revision, old body).
    expect(await stillPending(pair)).toBe(true);
    release.resolve();
    await first;
    const { metadata, content } = (await pair) as Extract<
      NotesnookReadOnlyNoteSnapshot,
      { content: unknown }
    >;
    // Whole pair: the token belongs to a body that already holds "first".
    expect(content.data).toContain("first");

    // A later append moves the note on; the pair's token is now stale.
    await append(world, metadata.revision!, "second");
    await expect(
      world.handle.localWrite!.updateNote({
        id: NOTE_ID,
        expectedRevision: metadata.revision!,
        patch: { content: "replacement built from the stale pair" },
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });
    expect(world.content.data).toContain("second");
  });

  it("does not call the content reader for a locked note and reports it locked", async () => {
    const unlocked = await createWorld();
    await snapshotOf(unlocked);
    // Metadata costs one content read (its lock probe); the reader is the second.
    expect(unlocked.calls.contentReads).toBe(2);

    const world = await createWorld();
    world.content.locked = true;
    const snapshot = await snapshotOf(world);
    expect(snapshot).toMatchObject({ contentRefusal: "locked" });
    expect(snapshot).not.toHaveProperty("content");
    // Only the probe: the reader was never called.
    expect(world.calls.contentReads).toBe(1);
  });

  it("reports a failed content read by category and releases the lock", async () => {
    const world = await createWorld();
    world.hooks.insideContentRead = async (call) => {
      // The first read is metadata's lock probe; the second is the reader.
      if (call === 2) throw new Error("SECRET cause");
    };
    const snapshot = await snapshotOf(world);
    expect(snapshot).toMatchObject({ contentRefusal: "read_failed" });
    expect(JSON.stringify(snapshot)).not.toContain("SECRET");
    expect(peekMutex(world.database)).toEqual({ depth: 0, queued: 0 });
    await expect(withMutex(world.database, "test:after", async () => "free")).resolves.toBe("free");
  });
});

/** The write seam, with the members the append path does not use inert. */
function seamDatabase(overrides: Record<string, unknown>): never {
  const unused = async () => {
    throw new Error("unused by an append");
  };
  return {
    notesAdd: unused,
    notesUpdate: unused,
    contentAdd: unused,
    notebookExists: unused,
    notebookNotes: unused,
    notebookAddNote: unused,
    notebookRemoveNote: unused,
    tagExists: unused,
    tagAdd: unused,
    relationAdd: unused,
    relationRemove: unused,
    relationListForNote: unused,
    ...overrides,
  } as never;
}

describe("restore after a failed content write", () => {
  it("does not put the old timestamp over a note another writer has moved", async () => {
    // A composition built without a `database` does not serialise the call,
    // so another writer can move the note between the touch and the restore.
    const { createNotesnookWriteAdapter } = await import("../src/core/notesnook-write-adapter.js");
    const { DETERMINISTIC_MARKDOWN_CODEC } = await import("../src/core/notesnook-write-codec.js");
    let dateEdited = START;
    const touches: number[] = [];
    const journal = new MemoryNotesnookRecoveryJournal();
    const database = seamDatabase({
      note: async (id: string) => ({
        id,
        title: "Title",
        pinned: false,
        favorite: false,
        conflicted: false,
        locked: false,
        dateEdited,
      }),
      contentFindByNoteId: async (id: string) => ({
        id: "content-1",
        noteId: id,
        type: "html" as const,
        data: OLD_BODY,
      }),
      notesTouch: vi.fn(async (_ids: readonly string[], value: number) => {
        touches.push(value);
        dateEdited = value;
      }),
      contentUpdateByNoteId: vi.fn(async () => {
        // Another writer lands first, then this write fails.
        dateEdited = START + 5_000;
        throw new Error("content write failed");
      }),
    });
    const adapter = createNotesnookWriteAdapter({
      source: database,
      codec: DETERMINISTIC_MARKDOWN_CODEC,
      recoveryJournal: journal,
    });

    await expect(
      adapter.appendNote({ id: NOTE_ID, markdownFragment: "x", expectedRevision: OLD_TOKEN }),
    ).rejects.toBeDefined();

    // Only the touch was written; the restore was withheld, and recorded.
    expect(touches).toHaveLength(1);
    expect(dateEdited).toBe(START + 5_000);
    expect(journal.snapshot()).toEqual([
      { operation: "append", noteId: NOTE_ID, stage: "append-date" },
    ]);
  });

  it("restores when the note still carries the value this call wrote", async () => {
    const { createNotesnookWriteAdapter } = await import("../src/core/notesnook-write-adapter.js");
    const { DETERMINISTIC_MARKDOWN_CODEC } = await import("../src/core/notesnook-write-codec.js");
    let dateEdited = START;
    const touches: number[] = [];
    const database = seamDatabase({
      note: async (id: string) => ({
        id,
        title: "Title",
        pinned: false,
        favorite: false,
        conflicted: false,
        locked: false,
        dateEdited,
      }),
      contentFindByNoteId: async (id: string) => ({
        id: "content-1",
        noteId: id,
        type: "html" as const,
        data: OLD_BODY,
      }),
      notesTouch: vi.fn(async (_ids: readonly string[], value: number) => {
        touches.push(value);
        dateEdited = value;
      }),
      contentUpdateByNoteId: vi.fn(async () => {
        throw new Error("content write failed");
      }),
    });
    const adapter = createNotesnookWriteAdapter({
      source: database,
      codec: DETERMINISTIC_MARKDOWN_CODEC,
    });
    await expect(
      adapter.appendNote({ id: NOTE_ID, markdownFragment: "x", expectedRevision: OLD_TOKEN }),
    ).rejects.toBeDefined();
    expect(touches).toHaveLength(2);
    expect(touches[1]).toBe(START);
    expect(dateEdited).toBe(START);
  });
});

// ---------------------------------------------------------------------------
// notes.get: one snapshot, one decision.
// ---------------------------------------------------------------------------

const HTML = { type: "html" as const, data: "<p>Hello</p>" };
const AUTH_REVISION = tokenAt(START);
const SNAPSHOT_REVISION = tokenAt(START + 1_000);

const getRequest = (params: Record<string, unknown>) =>
  ({ id: "get-1", method: "notes.get", params }) as unknown as RpcRequest;

/** Allow everything except the notebook titled "Secret". */
const denySecret = (_operation: string, context: { notebookPath?: string }) => ({
  allowed: context.notebookPath !== "Secret",
});

function rpcRuntime(
  overrides: {
    authorised?: Record<string, unknown>;
    snapshot?: Record<string, unknown> | undefined;
    noSlot?: boolean;
  } = {},
) {
  const authorised = overrides.authorised ?? {
    id: NOTE_ID,
    title: "Memo",
    revision: AUTH_REVISION,
    notebookId: "open",
  };
  const noteMetadata = vi.fn(async () => authorised);
  const readOperatorNoteContent = vi.fn(async () => HTML);
  const readNoteSnapshot = vi.fn(async () => {
    const snapshot =
      "snapshot" in overrides
        ? overrides.snapshot
        : { metadata: { ...authorised, revision: SNAPSHOT_REVISION }, content: HTML };
    if (snapshot === undefined || snapshot === null || typeof snapshot !== "object") {
      return snapshot;
    }
    const record = snapshot as Record<string, unknown>;
    if (record.notebookPathSnapshot !== undefined) return snapshot;
    const metadata = record.metadata as Record<string, unknown> | undefined;
    if (metadata === undefined) return snapshot;
    const ids = Array.isArray(metadata.notebookIds)
      ? metadata.notebookIds.filter((value): value is string => typeof value === "string")
      : typeof metadata.notebookId === "string"
        ? [metadata.notebookId]
        : [];
    const pathById: Readonly<Record<string, string>> = { open: "Open", secret: "Secret" };
    const notebookPathSnapshot = ids.flatMap((notebookId) => {
      const path = pathById[notebookId];
      return path === undefined ? [] : [{ notebookId, path }];
    });
    return { ...record, notebookPathSnapshot };
  });
  const runtime = {
    search: async () => [],
    noteMetadata,
    listNotebooksForSettings: async () => [
      { id: "open", title: "Open" },
      { id: "secret", title: "Secret" },
    ],
    resolveNotePath: vi.fn(async () => ({ id: NOTE_ID, expectedRevision: AUTH_REVISION })),
    // The old content reader is present on purpose: a handler that reached for
    // it would be reading the body outside the snapshot.
    readOnly: overrides.noSlot
      ? { readOperatorNoteContent }
      : { readNoteSnapshot, readOperatorNoteContent },
  } as unknown as RpcHandlerRuntimeLike;
  return { runtime, noteMetadata, readNoteSnapshot, readOperatorNoteContent };
}

describe("notes.get reads one snapshot", () => {
  it("makes exactly one snapshot call and no direct metadata or content call", async () => {
    // No settings evaluator: nothing reads the note before the handler does.
    const { runtime, noteMetadata, readNoteSnapshot, readOperatorNoteContent } = rpcRuntime();
    const response = await handleRpcRequest(
      getRequest({ id: NOTE_ID }),
      runtime,
      createReadWriteNoDeleteServicePolicy(),
    );
    expect(response).toMatchObject({
      ok: true,
      result: { kind: "note", contentStatus: "ok", note: { revision: SNAPSHOT_REVISION } },
    });
    expect(readNoteSnapshot).toHaveBeenCalledTimes(1);
    expect(readNoteSnapshot).toHaveBeenCalledWith(NOTE_ID);
    expect(noteMetadata).not.toHaveBeenCalled();
    expect(readOperatorNoteContent).not.toHaveBeenCalled();
  });

  it("with authorization, reads the note once to decide and once as the snapshot", async () => {
    const { runtime, noteMetadata, readNoteSnapshot, readOperatorNoteContent } = rpcRuntime();
    const response = await handleRpcRequest(
      getRequest({ id: NOTE_ID }),
      runtime,
      createReadWriteNoDeleteServicePolicy(denySecret as never),
    );
    // The revision reported is the snapshot's, the one that describes the body.
    expect(response).toMatchObject({
      ok: true,
      result: { contentStatus: "ok", note: { revision: SNAPSHOT_REVISION } },
    });
    expect(noteMetadata).toHaveBeenCalledTimes(1);
    expect(readNoteSnapshot).toHaveBeenCalledTimes(1);
    expect(readOperatorNoteContent).not.toHaveBeenCalled();
  });

  it("reports a locked note as locked without a body", async () => {
    const { runtime } = rpcRuntime({
      snapshot: {
        metadata: { id: NOTE_ID, title: "Memo", revision: AUTH_REVISION, locked: true },
        contentRefusal: "locked",
      },
      authorised: { id: NOTE_ID, title: "Memo", revision: AUTH_REVISION, locked: true },
    });
    const response = await handleRpcRequest(
      getRequest({ id: NOTE_ID }),
      runtime,
      createReadWriteNoDeleteServicePolicy(),
    );
    expect(response).toMatchObject({ ok: true, result: { contentStatus: "locked" } });
    expect(JSON.stringify(response)).not.toContain("Hello");
  });

  it("reports read_failed when the snapshot refuses the body", async () => {
    const { runtime } = rpcRuntime({
      snapshot: {
        metadata: { id: NOTE_ID, title: "Memo", revision: AUTH_REVISION },
        contentRefusal: "read_failed",
      },
    });
    const response = await handleRpcRequest(
      getRequest({ id: NOTE_ID }),
      runtime,
      createReadWriteNoDeleteServicePolicy(),
    );
    expect(response).toMatchObject({
      ok: true,
      result: { contentStatus: "unavailable", contentReason: "read_failed" },
    });
  });

  it("reports content unavailable when the runtime has no snapshot slot", async () => {
    const { runtime, readOperatorNoteContent } = rpcRuntime({ noSlot: true });
    const response = await handleRpcRequest(
      getRequest({ id: NOTE_ID }),
      runtime,
      createReadWriteNoDeleteServicePolicy(),
    );
    expect(response).toMatchObject({
      ok: true,
      result: { contentStatus: "unavailable", contentReason: "reader_unavailable" },
    });
    // Never the old two-call fallback.
    expect(readOperatorNoteContent).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain("Hello");
  });

  describe("when what authorization rested on changes before the snapshot", () => {
    const moved: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["notebookId", { notebookId: "secret" }],
      ["notebookIds", { notebookIds: ["open", "secret"] }],
      ["notebookMembershipComplete", { notebookMembershipComplete: false }],
      ["locked", { locked: true }],
    ];

    it.each(moved)("refuses an id-form request when %s changes", async (_name, change) => {
      const base = { id: NOTE_ID, title: "Memo", revision: AUTH_REVISION, notebookId: "open" };
      const { runtime } = rpcRuntime({
        authorised: base,
        snapshot: { metadata: { ...base, ...change }, content: HTML },
      });
      const policy = createReadWriteNoDeleteServicePolicy(denySecret as never);
      const response = await handleRpcRequest(getRequest({ id: NOTE_ID }), runtime, policy);

      // The refusal an authorization failure already gives on this route, with
      // no hint that the note exists and no body.
      const denied = await handleRpcRequest(
        getRequest({ id: NOTE_ID }),
        rpcRuntime({ authorised: { ...base, notebookId: "secret" } }).runtime,
        policy,
      );
      expect(response).toMatchObject({ ok: false, error: { code: "permission_denied" } });
      expect(response).toEqual(denied);
      expect(JSON.stringify(response)).not.toContain("Hello");
    });

    it("refuses with the same code when the note is gone by the time of the snapshot", async () => {
      const { runtime } = rpcRuntime({ snapshot: undefined });
      const response = await handleRpcRequest(
        getRequest({ id: NOTE_ID }),
        runtime,
        createReadWriteNoDeleteServicePolicy(denySecret as never),
      );
      expect(response).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    });

    it("refuses a path-form request as a missing path", async () => {
      const base = { id: NOTE_ID, title: "Memo", revision: AUTH_REVISION, notebookId: "open" };
      const { runtime } = rpcRuntime({
        authorised: base,
        snapshot: { metadata: { ...base, notebookId: "secret" }, content: HTML },
      });
      const policy = createReadWriteNoDeleteServicePolicy(denySecret as never);
      const response = await handleRpcRequest(getRequest({ path: "Open/Memo" }), runtime, policy);

      const missing = await handleRpcRequest(
        getRequest({ path: "Open/Memo" }),
        {
          ...rpcRuntime().runtime,
          resolveNotePath: async () => {
            throw new ExactNotePathError("not_found");
          },
        } as RpcHandlerRuntimeLike,
        policy,
      );
      expect(response).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(response).toEqual(missing);
    });

    it("lets an unchanged basis through even when the revision moved", async () => {
      // A new revision is the normal result of a concurrent write and is not
      // something authorization depends on.
      const { runtime } = rpcRuntime();
      const response = await handleRpcRequest(
        getRequest({ id: NOTE_ID }),
        runtime,
        createReadWriteNoDeleteServicePolicy(denySecret as never),
      );
      expect(response).toMatchObject({ ok: true, result: { contentStatus: "ok" } });
    });
  });
});

// ---------------------------------------------------------------------------
// Operator surfaces.
// ---------------------------------------------------------------------------

const PEER = Object.freeze({ uid: 1001, gid: 100, groups: ["nookbridge-operators"] });
const METADATA = { id: NOTE_ID, title: "Memo", revision: AUTH_REVISION };

function operatorReadOnly(
  snapshot: () => Promise<unknown>,
): ServiceRuntime["readOnly"] & Record<string, ReturnType<typeof vi.fn>> {
  return {
    listNotes: vi.fn(async () => [{ id: NOTE_ID, title: "Memo" }]),
    search: vi.fn(async () => []),
    noteMetadata: vi.fn(async () => METADATA),
    readOperatorNoteContent: vi.fn(async () => HTML),
    readNoteSnapshot: vi.fn(snapshot),
  } as never;
}

describe("operator reads use the snapshot", () => {
  it("the operator view reads one snapshot and neither separate reader", async () => {
    const readOnly = operatorReadOnly(async () => ({ metadata: METADATA, content: HTML }));
    const runtime = createOperatorDiscoveryRuntime(
      { readOnly } as unknown as ServiceRuntime,
      undefined,
      {
        listNotes: async () => [{ id: NOTE_ID, title: "Memo" }],
        searchHits: async () => [],
        filterNotebooks: async (notebooks) => notebooks,
      },
    );
    const page = await runtime.browse({ limit: 1 }, PEER);
    const view = await runtime.view!({ id: page.notes[0]!.handle }, PEER);
    expect(view.revision).toBe(AUTH_REVISION);
    expect(view.markdown).toContain("Hello");
    expect(readOnly.readNoteSnapshot).toHaveBeenCalledTimes(1);
    expect(readOnly.noteMetadata).not.toHaveBeenCalled();
    expect(readOnly.readOperatorNoteContent).not.toHaveBeenCalled();
  });

  it("the operator view refuses a locked note by category", async () => {
    const readOnly = operatorReadOnly(async () => ({
      metadata: METADATA,
      contentRefusal: "locked",
    }));
    const runtime = createOperatorDiscoveryRuntime(
      { readOnly } as unknown as ServiceRuntime,
      undefined,
      {
        listNotes: async () => [{ id: NOTE_ID, title: "Memo" }],
        searchHits: async () => [],
        filterNotebooks: async (notebooks) => notebooks,
      },
    );
    const page = await runtime.browse({ limit: 1 }, PEER);
    await expect(runtime.view!({ id: page.notes[0]!.handle }, PEER)).rejects.toMatchObject({
      code: "vault_locked",
    });
  });

  it("the operator view is unavailable without a snapshot slot", async () => {
    const readOnly = operatorReadOnly(async () => undefined);
    delete (readOnly as Record<string, unknown>).readNoteSnapshot;
    const runtime = createOperatorDiscoveryRuntime(
      { readOnly } as unknown as ServiceRuntime,
      undefined,
      {
        listNotes: async () => [{ id: NOTE_ID, title: "Memo" }],
        searchHits: async () => [],
        filterNotebooks: async (notebooks) => notebooks,
      },
    );
    const page = await runtime.browse({ limit: 1 }, PEER);
    await expect(runtime.view!({ id: page.notes[0]!.handle }, PEER)).rejects.toThrow(
      "content unavailable",
    );
    expect(readOnly.readOperatorNoteContent).not.toHaveBeenCalled();
  });

  it("the operator edit read takes revision and content from one snapshot", async () => {
    const readOnly = operatorReadOnly(async () => ({ metadata: METADATA, content: HTML }));
    const source = createOperatorWriteSource({
      operatorCreateNote: vi.fn(),
      operatorUpdateNote: vi.fn(),
      readOnly,
    } as never)!;
    await expect(source.read(NOTE_ID)).resolves.toEqual({ revision: AUTH_REVISION, content: HTML });
    expect(readOnly.readNoteSnapshot).toHaveBeenCalledTimes(1);
    expect(readOnly.noteMetadata).not.toHaveBeenCalled();
    expect(readOnly.readOperatorNoteContent).not.toHaveBeenCalled();
  });

  it("the operator edit read keeps a lock distinguishable from a failure", async () => {
    const locked = createOperatorWriteSource({
      operatorCreateNote: vi.fn(),
      operatorUpdateNote: vi.fn(),
      readOnly: operatorReadOnly(async () => ({ metadata: METADATA, contentRefusal: "locked" })),
    } as never)!;
    const failed = createOperatorWriteSource({
      operatorCreateNote: vi.fn(),
      operatorUpdateNote: vi.fn(),
      readOnly: operatorReadOnly(async () => ({
        metadata: METADATA,
        contentRefusal: "read_failed",
      })),
    } as never)!;
    const lockedError = await locked.read(NOTE_ID).catch((error: unknown) => error);
    const failedError = await failed.read(NOTE_ID).catch((error: unknown) => error);
    expect(isVaultLockedRefusal(lockedError)).toBe(true);
    expect(isVaultLockedRefusal(failedError)).toBe(false);
    expect(failedError).toBeInstanceOf(Error);
  });
});

describe("operator read, update, read back", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes under fake timers, with no timer waiting on the lock", async () => {
    vi.useFakeTimers();
    const world = await createWorld({ operator: true });
    const source = createOperatorWriteSource({
      operatorCreateNote: vi.fn(),
      operatorUpdateNote: (command: unknown) =>
        world.handle.operatorLocalWrite!.updateNote(command as never),
      readOnly: world.handle.readOnly,
    } as never)!;

    const before = await source.read(NOTE_ID);
    expect(before).toMatchObject({ revision: OLD_TOKEN });
    expect(before?.content.data).toBe(OLD_BODY);

    const result = await source.update({
      noteId: NOTE_ID,
      expectedRevision: before!.revision,
      content: { type: "tiptap", data: "<p>edited</p>" },
    });
    expect(result).toEqual({ kind: "updated", revision: tokenAt(world.note.dateEdited) });
    expect(world.note.dateEdited).toBeGreaterThan(START);

    const after = await source.read(NOTE_ID);
    expect(after?.revision).toBe((result as { revision: string }).revision);
    expect(after?.content.data).toBe("<p>edited</p>");
    expect(peekMutex(world.database)).toEqual({ depth: 0, queued: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
