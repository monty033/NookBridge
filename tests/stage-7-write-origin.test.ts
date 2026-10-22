/**
 * S7a-5 — the real write origin reaches the pending markers.
 *
 * Covers the wiring above the composition: the production service runtime
 * builds an MCP composition and a separate operator composition over ONE
 * coordinator, nookd hands the operator write source only the operator
 * variants, and the daemon-facing runtime never carries them.
 *
 * Fully offline: a fake real-core database, a temp state directory and a temp
 * credentials directory, as in the D4-2 production-wiring test. No network, no
 * live Notesnook state, no real daemon state directory.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOperatorWriteSource,
  startNookd,
  type NookdStartupFactories,
  type NookdStartupRuntime,
} from "../src/nookd.js";
import {
  createProductionServiceRuntime,
  type ServiceRuntime,
} from "../src/service/service-runtime.js";
import type { LoadServiceConfigResult, ServiceConfig } from "../src/config/service-config.js";
import { createSystemdCredentialKeyStore } from "../src/keystore/systemd-credential-keystore.js";
import type { SecureKeyStore } from "../src/keystore/keystore.js";
import {
  markRealCoreModule,
  type NotesnookRealCoreModule,
} from "../src/core/notesnook-core-adapter.js";
import { PersistentSyncMetadataStateStore } from "../src/core/notesnook-sync-state-store.js";
import type { SyncCoordinatorState } from "../src/core/notesnook-sync-coordinator.js";
import { createRevisionToken } from "../src/core/notesnook-write-contract.js";
import type { NookdServerHandle, StartNookdServerOptions } from "../src/service/nookd-server.js";

const EXISTING_NOTE_ID = "0123456789abcdef0123456789abcdef";
const CREATED_NOTE_ID = "fedcba9876543210fedcba9876543210";
const EXISTING_DATE_EDITED = 1_700_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Fake real-core database (the D4-2 pattern), extended with a tiny note store
// so `notes.add` really creates a note the write chain can read back.
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
    syncer: { start: syncStart },
    lastSynced: async () => 0,
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
  /** Every state the shared coordinator persisted, oldest first. */
  readonly saves: SyncCoordinatorState[];
}

async function withProductionRuntime(body: (harness: Harness) => Promise<void>): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-write-origin-"));
  const credentialsDir = mkdtempSync(join(tmpdir(), "nookbridge-write-origin-creds-"));
  writeFileSync(join(credentialsDir, "nookbridge-db-key"), "write-origin-wiring-key", {
    mode: 0o600,
  });
  // The coordinator persists every marker change through this store, so the
  // saved states are an honest view of the one shared coordinator.
  const saves: SyncCoordinatorState[] = [];
  const realSave = PersistentSyncMetadataStateStore.prototype.save;
  vi.spyOn(PersistentSyncMetadataStateStore.prototype, "save").mockImplementation(function (
    this: PersistentSyncMetadataStateStore,
    state: SyncCoordinatorState,
  ) {
    saves.push(state);
    return realSave.call(this, state);
  });
  const syncStart = vi.fn(async () => true);
  const database = createFakeDatabase(syncStart);
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
    await body({ runtime, syncStart, saves });
  } finally {
    if (runtime) await runtime.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(credentialsDir, { recursive: true, force: true });
  }
}

type OperatorVariants = {
  readonly operatorCreateNote?: ServiceRuntimeOperatorCreate;
  readonly operatorUpdateNote?: ServiceRuntimeOperatorUpdate;
};
type ServiceRuntimeOperatorCreate = (command: {
  title: string;
  content: string;
}) => Promise<unknown>;
type ServiceRuntimeOperatorUpdate = (command: {
  id: string;
  expectedRevision: ReturnType<typeof createRevisionToken>;
  patch: { title: string };
}) => Promise<unknown>;

/** The runtime's operator variants, which are not part of the public type. */
function operatorVariants(runtime: ServiceRuntime): OperatorVariants {
  return runtime as unknown as OperatorVariants;
}

const existingRevision = () =>
  createRevisionToken({ id: EXISTING_NOTE_ID, dateEdited: EXISTING_DATE_EDITED });

function originsOf(state: SyncCoordinatorState | undefined): Array<[string, string, unknown]> {
  return Array.from(state?.pending ?? [], (marker) => [
    marker.operation,
    marker.noteId,
    (marker as { origin?: unknown }).origin,
  ]);
}

// ---------------------------------------------------------------------------
// 11 — one shared coordinator, two compositions, two origins.
// ---------------------------------------------------------------------------

describe("S7a-5 — production runtime tags each write path with its own origin", () => {
  it("11. runtime.createNote is mcp and runtime.operatorUpdateNote is operator, in one snapshot", async () => {
    await withProductionRuntime(async ({ runtime, saves }) => {
      expect(typeof runtime.createNote).toBe("function");
      expect(typeof operatorVariants(runtime).operatorUpdateNote).toBe("function");

      await runtime.createNote!({ title: "From MCP", content: "body" });
      await operatorVariants(runtime).operatorUpdateNote!({
        id: EXISTING_NOTE_ID,
        expectedRevision: existingRevision(),
        patch: { title: "Renamed by operator" },
      });

      const final = saves[saves.length - 1];
      expect(originsOf(final)).toEqual(
        expect.arrayContaining([
          ["create", CREATED_NOTE_ID, "mcp"],
          ["update", EXISTING_NOTE_ID, "operator"],
        ]),
      );
      expect(final?.pending).toHaveLength(2);
    });
  });

  it("11b. runtime.operatorCreateNote is write-ahead and ends as an operator marker", async () => {
    await withProductionRuntime(async ({ runtime, saves }) => {
      await operatorVariants(runtime).operatorCreateNote!({ title: "From operator", content: "b" });

      // The first thing persisted for the create is the reserved placeholder.
      const first = saves[0];
      expect(originsOf(first)).toEqual([
        ["create", expect.stringMatching(/^nb-pending-create-/), "operator"],
      ]);
      // It was then replaced by the real note's marker, still operator.
      expect(originsOf(saves[saves.length - 1])).toEqual([["create", CREATED_NOTE_ID, "operator"]]);
    });
  });

  it("11c. a later mcp write cannot downgrade the operator marker for the same note", async () => {
    await withProductionRuntime(async ({ runtime, saves }) => {
      await operatorVariants(runtime).operatorUpdateNote!({
        id: EXISTING_NOTE_ID,
        expectedRevision: existingRevision(),
        patch: { title: "Renamed by operator" },
      });
      await runtime.updateNote!({
        id: EXISTING_NOTE_ID,
        expectedRevision: createRevisionToken({
          id: EXISTING_NOTE_ID,
          dateEdited: EXISTING_DATE_EDITED,
        }),
        patch: { title: "Renamed by mcp" },
      });

      const origins = originsOf(saves[saves.length - 1]).map(([, , origin]) => origin);
      expect(origins).not.toContain("mcp");
      expect(origins).toContain("operator");
    });
  });

  it("14. interim lock: with an operator marker present, requestSync still reaches the executor", async () => {
    await withProductionRuntime(async ({ runtime, saves, syncStart }) => {
      await operatorVariants(runtime).operatorUpdateNote!({
        id: EXISTING_NOTE_ID,
        expectedRevision: existingRevision(),
        patch: { title: "Renamed by operator" },
      });
      expect(originsOf(saves[saves.length - 1]).map(([, , origin]) => origin)).toContain(
        "operator",
      );
      expect(syncStart).not.toHaveBeenCalled();

      // No refusal before S7a-4: this assertion must keep passing until that
      // step deliberately replaces it.
      await runtime.requestSync!();
      expect(syncStart).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 12 — the daemon-facing runtime never carries the operator variants.
// ---------------------------------------------------------------------------

const CONFIG_PATH = "/etc/nookbridge/service.json";
const CONFIG: ServiceConfig = Object.freeze({
  stateDir: "/var/lib/nookbridge",
  socketPath: "/run/nookbridge/nookbridge.sock",
  socketGroup: "nookbridge-clients",
  backend: "systemd-credential",
  credentialName: "nookbridge-db-key",
  settingsBackend: "nix",
  readPolicy: Object.freeze(["notes.search", "notes.get"] as const),
});
const SETTINGS_TEXT = JSON.stringify({
  version: 1,
  defaults: { read: true, edit: true, create: false, delete: false },
  overrides: [],
});
const productionKeys: SecureKeyStore = Object.freeze({
  backend: "systemd-credential",
  productionSafe: true,
  getDatabaseKey: () => "opaque-test-key",
});

describe("S7a-5 — startNookdServer never receives the operator variants", () => {
  it("12. the runtime handed to the server has no operatorCreateNote / operatorUpdateNote", async () => {
    vi.stubEnv("CREDENTIALS_DIRECTORY", "/run/credentials/nookbridge.service");
    // No `readOnly` on purpose: the operator write runtime (and with it the
    // durable operation store under the canonical state directory) is only
    // built when a read source exists, so this fixture touches no state.
    const runtime = Object.freeze({
      search: vi.fn(async () => []),
      cleanup: vi.fn(async () => undefined),
      listNotebooksForSettings: vi.fn(async () => []),
      createNote: vi.fn(async () => ({})),
      updateNote: vi.fn(async () => ({})),
      operatorCreateNote: vi.fn(async () => ({})),
      operatorUpdateNote: vi.fn(async () => ({})),
    }) as unknown as NookdStartupRuntime;
    const factories: NookdStartupFactories = {
      loadConfig: vi.fn((_: string): LoadServiceConfigResult => ({ ok: true, config: CONFIG })),
      createKeyStore: vi.fn(() => productionKeys),
      createRuntime: vi.fn(async () => runtime),
      readSettingsFile: vi.fn(() => SETTINGS_TEXT),
      startServer: vi.fn(
        async (_options: StartNookdServerOptions): Promise<NookdServerHandle> => ({
          socketPath: CONFIG.socketPath,
          shutdown: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
        }),
      ),
    };

    const handle = await startNookd({ configPath: CONFIG_PATH, factories });
    try {
      const options = vi.mocked(factories.startServer).mock.calls[0]?.[0];
      const serverRuntime = options?.runtime as unknown as Record<string, unknown>;
      expect(serverRuntime).toBeDefined();
      // Control: the MCP variants do reach the server, so the absence below is
      // meaningful rather than the result of a broken fixture.
      expect(serverRuntime).toHaveProperty("createNote");
      expect(serverRuntime).toHaveProperty("updateNote");
      expect(serverRuntime).not.toHaveProperty("operatorCreateNote");
      expect(serverRuntime).not.toHaveProperty("operatorUpdateNote");
      expect(Reflect.ownKeys(serverRuntime).map(String).join(",")).not.toContain("operator");
    } finally {
      await handle.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// 13 — the operator write source consumes only the operator variants.
// ---------------------------------------------------------------------------

describe("S7a-5 — createOperatorWriteSource", () => {
  const REVISION = "rev_0123456789abcdef0123456789abcdef";
  const content = { type: "html" as const, data: "<p>x</p>" };

  function readOnlyStub() {
    return {
      noteMetadata: vi.fn(async () => ({
        id: EXISTING_NOTE_ID,
        title: "t",
        revision: "rev-after",
      })),
      readOperatorNoteContent: vi.fn(async () => content),
    } as never;
  }

  it("13. update goes through operatorUpdateNote, never updateNote; create through operatorCreateNote", async () => {
    const operatorCreateNote = vi.fn(async () => ({ id: CREATED_NOTE_ID }));
    const operatorUpdateNote = vi.fn(async () => ({ operation: "update" }));
    const mcpCreateNote = vi.fn(async () => ({ id: "mcp" }));
    const mcpUpdateNote = vi.fn(async () => ({ operation: "update" }));
    const readOnly = readOnlyStub();

    const source = createOperatorWriteSource({
      operatorCreateNote: operatorCreateNote as never,
      operatorUpdateNote: operatorUpdateNote as never,
      readOnly,
      // Extra MCP variants must be neither required nor consulted.
      createNote: mcpCreateNote,
      updateNote: mcpUpdateNote,
    } as never);
    expect(source).toBeDefined();

    const updated = await source!.update({
      noteId: EXISTING_NOTE_ID,
      expectedRevision: REVISION,
      content,
    });
    expect(updated).toEqual({ kind: "updated", revision: "rev-after" });
    expect(operatorUpdateNote).toHaveBeenCalledTimes(1);
    expect(operatorUpdateNote).toHaveBeenCalledWith(
      expect.objectContaining({ id: EXISTING_NOTE_ID, patch: { storedContent: content } }),
    );
    expect(mcpUpdateNote).not.toHaveBeenCalled();

    await source!.create!({ title: "t", content: "c" });
    expect(operatorCreateNote).toHaveBeenCalledTimes(1);
    expect(operatorCreateNote).toHaveBeenCalledWith({ title: "t", content: "c" });
    expect(mcpCreateNote).not.toHaveBeenCalled();
  });

  it("13b. update maps the adapter's categorical codes exactly as before", async () => {
    const outcomes: ReadonlyArray<readonly [string, string]> = [
      ["stale_revision", "conflict"],
      ["conflict", "conflict"],
      ["vault_locked", "locked"],
      ["sync_failed", "error"],
    ];
    for (const [code, kind] of outcomes) {
      const source = createOperatorWriteSource({
        operatorCreateNote: vi.fn() as never,
        operatorUpdateNote: vi.fn(async () => {
          throw Object.assign(new Error("x"), { code });
        }) as never,
        readOnly: readOnlyStub(),
      });
      expect(
        await source!.update({ noteId: EXISTING_NOTE_ID, expectedRevision: REVISION, content }),
      ).toEqual({ kind });
    }
  });

  it("13c. with the operator variants absent the source is unavailable, even if MCP variants exist", () => {
    const mcpCreateNote = vi.fn();
    const mcpUpdateNote = vi.fn();
    const readOnly = readOnlyStub();
    const operatorCreateNote = vi.fn();
    const operatorUpdateNote = vi.fn();

    expect(
      createOperatorWriteSource({
        readOnly,
        createNote: mcpCreateNote,
        updateNote: mcpUpdateNote,
      } as never),
    ).toBeUndefined();
    // Either variant missing is enough to make operator writes unavailable.
    expect(
      createOperatorWriteSource({
        operatorCreateNote: operatorCreateNote as never,
        readOnly,
        createNote: mcpCreateNote,
        updateNote: mcpUpdateNote,
      } as never),
    ).toBeUndefined();
    expect(
      createOperatorWriteSource({
        operatorUpdateNote: operatorUpdateNote as never,
        readOnly,
        createNote: mcpCreateNote,
        updateNote: mcpUpdateNote,
      } as never),
    ).toBeUndefined();
    // Without a read source nothing can be observed or verified either.
    expect(
      createOperatorWriteSource({
        operatorCreateNote: operatorCreateNote as never,
        operatorUpdateNote: operatorUpdateNote as never,
        readOnly: undefined,
      }),
    ).toBeUndefined();
    expect(mcpCreateNote).not.toHaveBeenCalled();
    expect(mcpUpdateNote).not.toHaveBeenCalled();
  });
});
