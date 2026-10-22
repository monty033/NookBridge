/**
 * S7a-4 — the upload gate, on the production path.
 *
 * `createProductionServiceRuntime` over a fake real-core database, a temp state
 * directory and a temp credentials directory (the S7a-5 pattern). One shared
 * coordinator holds the markers: an MCP write is tagged `mcp`, an operator
 * write `operator`. An explicit sync may reach the upstream `syncer.start` only
 * when every pending marker is `mcp` (DR-S7a item 5).
 *
 * Fully offline. No network, no live Notesnook state, no real daemon state.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProductionServiceRuntime,
  type ServiceRuntime,
} from "../src/service/service-runtime.js";
import { handleRpcRequest } from "../src/service/rpc-handler.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";
import { createSystemdCredentialKeyStore } from "../src/keystore/systemd-credential-keystore.js";
import {
  markRealCoreModule,
  type NotesnookRealCoreModule,
} from "../src/core/notesnook-core-adapter.js";
import { createRevisionToken } from "../src/core/notesnook-write-contract.js";

const EXISTING_NOTE_ID = "0123456789abcdef0123456789abcdef";
const CREATED_NOTE_ID = "fedcba9876543210fedcba9876543210";
const EXISTING_DATE_EDITED = 1_700_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
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
}

async function withProductionRuntime(body: (harness: Harness) => Promise<void>): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-sync-gate-"));
  const credentialsDir = mkdtempSync(join(tmpdir(), "nookbridge-sync-gate-creds-"));
  writeFileSync(join(credentialsDir, "nookbridge-db-key"), "sync-gate-wiring-key", {
    mode: 0o600,
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
    await body({ runtime, syncStart });
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
      expect(syncStart).toHaveBeenCalledTimes(0);
    });
  });

  it("9b. a refused sync leaves the markers, so a second request is refused too", async () => {
    await withProductionRuntime(async ({ runtime, syncStart }) => {
      await operatorWrite(runtime);
      await runtime.requestSync!();
      const second = await runtime.requestSync!();
      expect(second).toMatchObject({ status: "failed", errorCode: "unapproved_pending" });
      expect(syncStart).toHaveBeenCalledTimes(0);
    });
  });

  it("9c. an MCP write does not launder an operator marker on the same note", async () => {
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
      expect(syncStart).toHaveBeenCalledTimes(0);
    });
  });

  it("10. an MCP-only queue still syncs, with exactly { type: 'full' }", async () => {
    await withProductionRuntime(async ({ runtime, syncStart }) => {
      await runtime.createNote!({ title: "From MCP", content: "body" });

      const result = await runtime.requestSync!();

      expect(result).toMatchObject({ status: "synced", pendingSync: false });
      expect(syncStart).toHaveBeenCalledTimes(1);
      expect(syncStart).toHaveBeenCalledWith({ type: "full" });
    });
  });

  it("11. over RPC, notes.sync after an operator write is the sync_failed envelope", async () => {
    await withProductionRuntime(async ({ runtime, syncStart }) => {
      await operatorWrite(runtime);

      const response = await handleRpcRequest(
        { id: "sync-1", method: "notes.sync", params: {} } as RpcRequest,
        runtime,
        createReadWriteNoDeleteServicePolicy(),
      );

      expect(response.ok).toBe(false);
      if (response.ok === false) expect(response.error.code).toBe("sync_failed");
      expect(syncStart).toHaveBeenCalledTimes(0);
    });
  });
});
