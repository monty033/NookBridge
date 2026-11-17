/**
 * S7a-4 — the upload gate, on the production path.
 *
 * `createProductionServiceRuntime` over a fake real-core database, a temp state
 * directory and a temp credentials directory (the S7a-5 pattern). One shared
 * coordinator holds the markers: an MCP write is tagged `mcp`, an operator
 * write `operator`. An explicit sync reaches `syncer.start` only when its
 * daemon upload policy allows the pending markers (DR-S7a item 5).
 *
 * Fully offline. No network, no live Notesnook state, no real daemon state.
 */

import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bindServiceRuntimeSyncUploadPolicy,
  createProductionServiceRuntime,
  type ServiceRuntime,
} from "../src/service/service-runtime.js";
import { startNookd, type NookdStartupFactories } from "../src/nookd.js";
import { handleRpcRequest } from "../src/service/rpc-handler.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import { RPC_ERROR_MESSAGES, type RpcRequest } from "../src/service/rpc-protocol.js";
import type { LoadServiceConfigResult, ServiceConfig } from "../src/config/service-config.js";
import type { SecureKeyStore } from "../src/keystore/keystore.js";
import type { StartNookdServerOptions } from "../src/service/nookd-server.js";
import { createSystemdCredentialKeyStore } from "../src/keystore/systemd-credential-keystore.js";
import {
  markRealCoreModule,
  type NotesnookRealCoreModule,
} from "../src/core/notesnook-core-adapter.js";
import { createRevisionToken } from "../src/core/notesnook-write-contract.js";

// A completed sync advances this stamp; the write path confirms its pre-write
// pull against it, so a fake that reports success without moving it would
// model a sync that fetched nothing.
let syncCompletionStamp = 0;
let syncCompletes = true;
// Lets a test hold a sync in flight, so a concurrent write is observably queued.
let syncHold: Promise<void> | undefined;
// Event handlers registered against the fixture's event manager.
const handlers = new Map<string, Set<() => void>>();
// Every event name any bridge code has subscribed to on this database.
const subscribedEventNames = new Set<string>();

const EXISTING_NOTE_ID = "0123456789abcdef0123456789abcdef";
const CREATED_NOTE_ID = "fedcba9876543210fedcba9876543210";
const EXISTING_DATE_EDITED = 1_700_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Fake real-core database (as in the S7a-5 wiring test).
// ---------------------------------------------------------------------------

interface FakeNote {
  id: string;
  title: string;
  notebookId?: string;
  pinned: boolean;
  favorite: boolean;
  conflicted: boolean;
  locked: boolean;
  dateEdited: number;
}

function createFakeDatabase(syncStart: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const notes = new Map<string, FakeNote>([
    [
      EXISTING_NOTE_ID,
      {
        id: EXISTING_NOTE_ID,
        title: "Existing",
        notebookId: "general-id",
        pinned: false,
        favorite: false,
        conflicted: false,
        locked: false,
        dateEdited: EXISTING_DATE_EDITED,
      },
    ],
  ]);
  const contents = new Map<string, Record<string, unknown>>();
  const tags = new Map<string, { id: string; title: string }>();
  return {
    setup: () => undefined,
    host: () => undefined,
    init: async () => undefined,
    user: {
      authenticateEmail: async () => undefined,
      authenticateMultiFactorCode: async () => undefined,
      authenticatePassword: async () => undefined,
      _login: async () => undefined,
      // A signed-in account, so the pre-write pull applies to this fixture.
      getUser: async () => ({ id: "test-account" }),
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
    eventManager: {
      // Real core publishes `sync:completed` from Sync.stop, in the same step
      // that stamps `lastSynced`; the fixture mirrors that pairing so a
      // completion cannot be modelled as one signal without the other.
      subscribe: (name: string, handler: () => void) => {
        subscribedEventNames.add(name);
        const set = handlers.get(name) ?? new Set<() => void>();
        set.add(handler);
        handlers.set(name, set);
        return { unsubscribe: () => set.delete(handler) };
      },
    },
    syncer: {
      start: async (request?: { type?: string }) => {
        const result = await syncStart(request);
        // Completion is only modelled when the fixture says a sync completed,
        // so a resolved `true` with nothing fetched stays representable.
        if (result === true && syncCompletes) {
          syncCompletionStamp += 1;
          for (const handler of handlers.get("sync:completed") ?? []) handler();
        }
        return result;
      },
    },
    lastSynced: async () => syncCompletionStamp,
    hasUnsyncedChanges: async () => false,
    notes: {
      note: async (id: string) => {
        const found = notes.get(id);
        return found === undefined ? undefined : { ...found };
      },
      add: async (item: { title: string; content?: Record<string, unknown> }) => {
        notes.set(CREATED_NOTE_ID, {
          id: CREATED_NOTE_ID,
          title: item.title,
          pinned: false,
          favorite: false,
          conflicted: false,
          locked: false,
          dateEdited: EXISTING_DATE_EDITED + 1,
        });
        if (item.content !== undefined) contents.set(CREATED_NOTE_ID, item.content);
        return CREATED_NOTE_ID;
      },
      addToNotebook: async () => undefined,
      removeFromNotebook: async () => undefined,
      moveToTrash: async () => undefined,
      collection: {
        update: async (ids: readonly string[], partial: Record<string, unknown>) => {
          for (const id of ids) {
            const found = notes.get(id);
            if (found !== undefined) notes.set(id, { ...found, ...partial } as FakeNote);
          }
        },
      },
    },
    content: {
      add: async (partial: Record<string, unknown>) => {
        const noteId = String(partial["noteId"] ?? "");
        contents.set(noteId, partial);
        return "content-created";
      },
      findByNoteId: async (noteId: string) => {
        const found = contents.get(noteId);
        if (found !== undefined) return { ...found };
        return noteId === EXISTING_NOTE_ID
          ? {
              id: "content-1",
              noteId,
              type: "tiptap",
              data: "<p>existing</p>",
              locked: false,
            }
          : undefined;
      },
      updateByNoteId: async () => undefined,
    },
    notebooks: {
      all: { ids: async () => ["general-id"] },
      notebook: async (id: string) =>
        id === "general-id" ? { id, title: "General", dateEdited: 1 } : undefined,
      breadcrumbs: async (id: string) => (id === "general-id" ? [{ id, title: "General" }] : []),
      notes: async (id: string) => (id === "general-id" ? [EXISTING_NOTE_ID] : []),
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
      // Incoming links: where a vault lock lives.  These fixtures hold no
      // locked notes, so the probe always answers zero.
      to: () => ({ get: async () => [], count: async () => 0 }),
      add: async () => undefined,
      unlink: async () => undefined,
      from: (reference: { id: string; type: string }) => ({
        get: async () => [],
        has: async (noteId: string) =>
          reference.type === "notebook" &&
          reference.id === "general-id" &&
          noteId === EXISTING_NOTE_ID,
      }),
    },
    lookup: {
      notes: async () => ({ ids: async () => [] }),
      notebooks: async () => ({ ids: async () => [] }),
    },
  };
}

interface Harness {
  readonly runtime: ServiceRuntime;
  readonly syncStart: ReturnType<typeof vi.fn>;
  readonly credentialsDir: string;
}

async function withProductionRuntime(
  body: (harness: Harness) => Promise<void>,
  dirty = false,
): Promise<void> {
  // Cleared before the runtime is built, so a subscription registered during
  // construction is observed as well as one made by the write itself.
  subscribedEventNames.clear();
  const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-sync-gate-"));
  const credentialsDir = mkdtempSync(join(tmpdir(), "nookbridge-sync-gate-creds-"));
  writeFileSync(join(credentialsDir, "nookbridge-db-key"), "sync-gate-wiring-key", {
    mode: 0o600,
  });
  const syncStart = vi.fn(async () => {
    if (syncHold !== undefined) await syncHold;
    return true;
  });
  const database = createFakeDatabase(syncStart);
  // Pinned core defines this method on Database.prototype. The factory must
  // supply its captured read-only projection to the executor's own-data gate.
  delete database.hasUnsyncedChanges;
  Object.setPrototypeOf(database, {
    hasUnsyncedChanges(this: object) {
      expect(this).toBe(database);
      return Promise.resolve(dirty);
    },
  });
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
    await body({ runtime, syncStart, credentialsDir });
  } finally {
    if (runtime) await runtime.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(credentialsDir, { recursive: true, force: true });
  }
}

type OperatorUpdate = (command: {
  id: string;
  expectedRevision: ReturnType<typeof createRevisionToken>;
  patch: { title: string };
}) => Promise<unknown>;

/** The runtime's operator variants, which are not part of the public type. */
function operatorUpdate(runtime: ServiceRuntime): OperatorUpdate {
  return (runtime as unknown as { operatorUpdateNote: OperatorUpdate }).operatorUpdateNote;
}

async function operatorWrite(runtime: ServiceRuntime): Promise<void> {
  await operatorUpdate(runtime)({
    id: EXISTING_NOTE_ID,
    expectedRevision: createRevisionToken({
      id: EXISTING_NOTE_ID,
      dateEdited: EXISTING_DATE_EDITED,
    }),
    patch: { title: "Renamed by operator" },
  });
}

async function rpcSync(runtime: ServiceRuntime) {
  return handleRpcRequest(
    { id: "sync-1", method: "notes.sync", params: {} } as RpcRequest,
    runtime,
    createReadWriteNoDeleteServicePolicy(),
  );
}

/**
 * `syncer.start` calls that upload. Stage 2 adds a pre-write fetch to every
 * local mutation, so a bare call count now includes that pull; these tests are
 * about the upload gate, so they count only the `full` requests.
 */
function uploads(syncStart: ReturnType<typeof vi.fn>): unknown[] {
  // Anything that is not a fetch is an upload: `full` performs a fetch and
  // then a send, and a bare `send` is an upload too. Filtering on `full`
  // alone would let a stray `send` slip past a zero-upload assertion.
  return syncStart.mock.calls.filter(
    (call) => (call[0] as { type?: unknown } | undefined)?.type !== "fetch",
  );
}

it("counts a send as an upload, so a stray send cannot pass a zero-upload check", () => {
  const syncStart = vi.fn(async (_request?: { type?: string }) => true);
  void syncStart({ type: "send" });
  expect(uploads(syncStart)).toHaveLength(1);
  expect(preWriteFetches(syncStart)).toHaveLength(0);
});

/** The Stage 2 pre-write pull, which is a fetch and never an upload. */
function preWriteFetches(syncStart: ReturnType<typeof vi.fn>): unknown[] {
  return syncStart.mock.calls.filter(
    (call) => (call[0] as { type?: unknown } | undefined)?.type === "fetch",
  );
}

describe("S7a-4 — explicit sync is gated on marker origin", () => {
  it("9. an operator write blocks the sync: failed/unapproved_pending, syncer.start never called", async () => {
    await withProductionRuntime(async ({ runtime, syncStart }) => {
      await operatorWrite(runtime);

      const result = await runtime.requestSync!();

      expect(result).toMatchObject({
        status: "failed",
        errorCode: "unapproved_pending",
        pendingSync: true,
        attempts: 1,
      });
      expect(uploads(syncStart)).toHaveLength(0);
      // Positive control: the write path pulled before writing, which is what
      // Stage 2 adds. Without this the count above would also pass if the
      // pre-write pull were never wired.
      expect(preWriteFetches(syncStart)).toHaveLength(1);
    });
  });

  it("9a. refuses the write when the pull resolves without completing", async () => {
    // The live failure in one assertion: the sync call reports success, nothing
    // is fetched, so the completion stamp never moves and the write must be
    // refused rather than applied blind. This drives the production runtime,
    // so it fails if the pre-write pull stops being wired.
    await withProductionRuntime(async ({ runtime }) => {
      syncCompletes = false;
      try {
        await expect(operatorWrite(runtime)).rejects.toMatchObject({ code: "sync_required" });
      } finally {
        syncCompletes = true;
      }
    });
  });

  it("9d. only sync:completed is registered, across construction and the exercised writes", async () => {
    // The exclusivity argument assumes nothing subscribes to core's deferred
    // sync request, which would start a sync outside the per-database lock.
    // A source scan cannot prove that (a subscription can reuse an already
    // captured method), so this observes the bus directly.
    //
    // Scope, stated honestly: construction plus two operator writes. The sync
    // request is deliberately not called here — after a write it is refused as
    // `unapproved_pending` before the remote executor runs, so it would add a
    // route without exercising an accepted sync, and the earlier draft of this
    // test wrongly implied otherwise. Nothing here speaks for a runtime path no
    // test drives, which is why the roadmap claims observation "over the
    // lifecycle it exercises".
    await withProductionRuntime(async ({ runtime }) => {
      await operatorWrite(runtime);
      await operatorWrite(runtime);
      expect([...subscribedEventNames]).toEqual(["sync:completed"]);
    });
  });

  it("9c. a sync already in flight keeps the write's pull queued behind it", async () => {
    // The round-4 overlap: an unrelated sync must not be able to be running
    // while the pre-write pull runs, so its completion cannot satisfy ours.
    // Serialization is what makes that true; this asserts the write waits.
    await withProductionRuntime(async ({ runtime, syncStart }) => {
      let release!: () => void;
      syncHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        const sync = rpcSync(runtime);
        await delay(0);
        const write = operatorWrite(runtime);
        await delay(25);
        // Still only the background sync: the write has not fetched yet.
        expect(preWriteFetches(syncStart)).toHaveLength(0);
        release();
        await sync;
        await write;
        expect(preWriteFetches(syncStart).length).toBeGreaterThan(0);
      } finally {
        syncHold = undefined;
        release();
      }
    });
  });

  it("9b. a refused sync leaves the markers, so a second request is refused too", async () => {
    await withProductionRuntime(async ({ runtime, syncStart }) => {
      await operatorWrite(runtime);
      await runtime.requestSync!();
      const second = await runtime.requestSync!();
      expect(second).toMatchObject({ status: "failed", errorCode: "unapproved_pending" });
      expect(uploads(syncStart)).toHaveLength(0);
    });
  });

  it("9c. a caller-supplied requestSync argument cannot release an unattributed queue", async () => {
    await withProductionRuntime(async ({ runtime, syncStart }) => {
      await operatorWrite(runtime);

      const requestSyncWithExtraArgument = runtime.requestSync as unknown as (
        policy: "allow",
      ) => ReturnType<NonNullable<ServiceRuntime["requestSync"]>>;
      await expect(requestSyncWithExtraArgument("allow")).resolves.toMatchObject({
        status: "failed",
        errorCode: "unapproved_pending",
      });
      expect(uploads(syncStart)).toHaveLength(0);
    });
  });

  it("9c2. the first policy binding wins and a second binding is refused", async () => {
    await withProductionRuntime(async ({ runtime, syncStart }) => {
      await operatorWrite(runtime);

      expect(bindServiceRuntimeSyncUploadPolicy(runtime, "allow")).toBe(true);
      expect(bindServiceRuntimeSyncUploadPolicy(runtime, "attributed")).toBe(false);
      await expect(runtime.requestSync!()).resolves.toMatchObject({
        status: "synced",
        pendingSync: false,
      });
      expect(uploads(syncStart)).toHaveLength(1);
    });
  });

  it("9d. an MCP write does not launder an operator marker on the same note", async () => {
    await withProductionRuntime(async ({ runtime, syncStart }) => {
      await operatorWrite(runtime);
      await runtime.updateNote!({
        id: EXISTING_NOTE_ID,
        expectedRevision: createRevisionToken({
          id: EXISTING_NOTE_ID,
          dateEdited: EXISTING_DATE_EDITED,
        }),
        patch: { title: "Renamed by mcp" },
      });
      await expect(runtime.requestSync!()).resolves.toMatchObject({
        status: "failed",
        errorCode: "unapproved_pending",
      });
      expect(uploads(syncStart)).toHaveLength(0);
    });
  });

  it("10. an MCP-only queue syncs under the default policy with exactly { type: 'full' }", async () => {
    await withProductionRuntime(async ({ runtime, syncStart }) => {
      await runtime.createNote!({ title: "From MCP", content: "body" });

      const result = await runtime.requestSync!();

      expect(result).toMatchObject({ status: "synced", pendingSync: false });
      expect(uploads(syncStart)).toHaveLength(1);
      expect(uploads(syncStart)).toEqual([[{ type: "full" }]]);
    });
  });

  it("11. the RPC handler uses the runtime's bound daemon policy", async () => {
    await withProductionRuntime(async ({ runtime, syncStart }) => {
      await operatorWrite(runtime);
      expect(bindServiceRuntimeSyncUploadPolicy(runtime, "allow")).toBe(true);

      const response = await rpcSync(runtime);

      expect(response.ok).toBe(true);
      expect(uploads(syncStart)).toHaveLength(1);
      expect(uploads(syncStart)).toEqual([[{ type: "full" }]]);
    });
  });

  it("11b. nookd binds loaded settings before exposing requestSync to RPC", async () => {
    await withProductionRuntime(async ({ runtime, syncStart, credentialsDir }) => {
      await operatorWrite(runtime);
      vi.stubEnv("CREDENTIALS_DIRECTORY", credentialsDir);

      const config: ServiceConfig = Object.freeze({
        stateDir: "/var/lib/nookbridge",
        socketPath: "/run/nookbridge/nookbridge.sock",
        socketGroup: "nookbridge-clients",
        backend: "systemd-credential",
        credentialName: "nookbridge-db-key",
        settingsBackend: "nix",
        readPolicy: Object.freeze(["notes.search", "notes.sync"] as const),
      });
      let databaseKeyReads = 0;
      const keys: SecureKeyStore = Object.freeze({
        backend: "systemd-credential",
        productionSafe: true,
        getDatabaseKey: () => {
          databaseKeyReads += 1;
          if (databaseKeyReads > 1) throw new Error("test key unavailable");
          return "daemon-test-key";
        },
      });
      const settingsText = JSON.stringify({
        version: 1,
        upload: "allow",
        defaults: { read: true, edit: false, create: false, delete: false },
        overrides: [],
      });
      let serverRuntime: StartNookdServerOptions["runtime"] | undefined;
      const factories: NookdStartupFactories = {
        loadConfig: vi.fn((): LoadServiceConfigResult => ({ ok: true, config })),
        createKeyStore: vi.fn(() => keys),
        createRuntime: vi.fn(async () => runtime),
        readSettingsFile: vi.fn(() => settingsText),
        startServer: vi.fn(async (options) => {
          serverRuntime = options.runtime;
          return Object.freeze({
            socketPath: config.socketPath,
            shutdown: async () => undefined,
            close: async () => undefined,
          });
        }),
      };

      const handle = await startNookd({ configPath: "/etc/nookbridge/service.json", factories });
      try {
        expect(serverRuntime).not.toHaveProperty("syncUploadPolicy");
        const response = await handleRpcRequest(
          { id: "sync-1", method: "notes.sync", params: {} } as RpcRequest,
          serverRuntime!,
          createReadWriteNoDeleteServicePolicy(),
        );
        expect(response.ok).toBe(true);
        expect(uploads(syncStart)).toHaveLength(1);
        expect(uploads(syncStart)).toEqual([[{ type: "full" }]]);
      } finally {
        await handle.shutdown();
      }
    });
  });

  it("12. over RPC, notes.sync after an operator write is the unapproved_pending envelope", async () => {
    await withProductionRuntime(async ({ runtime, syncStart }) => {
      await operatorWrite(runtime);

      const response = await rpcSync(runtime);

      expect(response).toEqual({
        id: "sync-1",
        ok: false,
        error: {
          code: "unapproved_pending",
          message: RPC_ERROR_MESSAGES.unapproved_pending,
        },
      });
      expect(RPC_ERROR_MESSAGES.unapproved_pending).toBe("Unapproved pending changes");
      // Only the code and the fixed message: no marker detail of any kind.
      expect(Object.keys(response).sort()).toEqual(["error", "id", "ok"]);
      expect(Object.keys((response as { error: object }).error).sort()).toEqual([
        "code",
        "message",
      ]);
      expect(uploads(syncStart)).toHaveLength(0);
    });
  });

  it("13. MCP-only markers with a failing upstream start stay sync_failed", async () => {
    await withProductionRuntime(async ({ runtime, syncStart }) => {
      // Stage 2: the write pulls first, so only the UPLOAD may fail here.
      // A failing fetch would refuse the write itself with sync_required,
      // which is a different behaviour and is pinned in
      // tests/stage-2-fetch-before-write.test.ts.
      syncStart.mockImplementation(async (request: { type?: unknown }) => request?.type !== "full");
      await runtime.createNote!({ title: "From MCP", content: "body" });

      const response = await rpcSync(runtime);

      expect(response.ok).toBe(false);
      if (response.ok === false) {
        expect(response.error.code).toBe("sync_failed");
        expect(response.error.message).toBe(RPC_ERROR_MESSAGES.sync_failed);
      }
      expect(uploads(syncStart)).toHaveLength(1);
    });
  });
});

describe("S7a-4b — runNotesSync maps only the exact errorCode", () => {
  function runtimeReturning(result: unknown): ServiceRuntime {
    return {
      search: async () => [],
      cleanup: async () => undefined,
      requestSync: async () => result,
    } as unknown as ServiceRuntime;
  }

  const failedBase = { status: "failed", pendingSync: true, attempts: 1 } as const;

  it("13. an unknown errorCode on a failed result is sync_failed", async () => {
    const response = await rpcSync(runtimeReturning({ ...failedBase, errorCode: "made_up" }));
    expect(response.ok).toBe(false);
    if (response.ok === false) expect(response.error.code).toBe("sync_failed");
  });

  it("14. a failed result with no errorCode, or a non-string one, is sync_failed", async () => {
    for (const errorCode of [undefined, 7, null, { toString: () => "unapproved_pending" }]) {
      const response = await rpcSync(runtimeReturning({ ...failedBase, errorCode }));
      expect(response.ok).toBe(false);
      if (response.ok === false) expect(response.error.code).toBe("sync_failed");
    }
    const bare = await rpcSync(runtimeReturning({ ...failedBase }));
    if (bare.ok === false) expect(bare.error.code).toBe("sync_failed");
  });

  it("15. an inherited errorCode is ignored", async () => {
    const inherited = Object.assign(Object.create({ errorCode: "unapproved_pending" }), failedBase);
    const response = await rpcSync(runtimeReturning(inherited));
    expect(response.ok).toBe(false);
    if (response.ok === false) expect(response.error.code).toBe("sync_failed");
  });

  it("16. errorCode is ignored on a non-failed status", async () => {
    const response = await rpcSync(
      runtimeReturning({
        status: "synced",
        pendingSync: false,
        attempts: 1,
        errorCode: "unapproved_pending",
      }),
    );
    expect(response.ok).toBe(true);
  });

  it("17. the exact unapproved_pending errorCode maps to its own envelope", async () => {
    const response = await rpcSync(
      runtimeReturning({ ...failedBase, errorCode: "unapproved_pending" }),
    );
    expect(response.ok).toBe(false);
    if (response.ok === false) expect(response.error.code).toBe("unapproved_pending");
  });
});

describe("SR-7 production empty drain uses the read-only status projection", () => {
  it.each([false, true])("checks prototype database status dirty=%s", async (dirty) => {
    await withProductionRuntime(async ({ runtime, syncStart }) => {
      await expect(runtime.requestSync!()).resolves.toMatchObject(
        dirty ? { status: "failed", errorCode: "unapproved_pending" } : { status: "synced" },
      );
      expect(uploads(syncStart)).toHaveLength(dirty ? 0 : 1);
    }, dirty);
  });
});
