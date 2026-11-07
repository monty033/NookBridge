/**
 * Synthetic daemon harness shared by the EA reproduction tests.
 *
 * Moved verbatim out of `tests/ea-1-write-gate-reproduction.test.ts` so EA-2
 * drives the same production runtime: `createProductionServiceRuntime` over a
 * fake `@notesnook/core` module, so the REAL live factory, shared
 * `SyncCoordinator`, local-write composition, write adapter and service
 * runtime wrappers run. Only the Notesnook database is a synthetic in-memory
 * fake; every title and body is invented. Seeds may carry a body and a lock.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vi } from "vitest";

import { releaseLock } from "../../src/config/lock.js";
import {
  markRealCoreModule,
  type NotesnookRealCoreModule,
} from "../../src/core/notesnook-core-adapter.js";
import { createSystemdCredentialKeyStore } from "../../src/keystore/systemd-credential-keystore.js";
import {
  createProductionServiceRuntime,
  type ServiceRuntime,
} from "../../src/service/service-runtime.js";

export type FakeNote = {
  id: string;
  title: string;
  contentId?: string;
  pinned: boolean;
  favorite: boolean;
  conflicted: boolean;
  locked: boolean;
  dateEdited: number;
};

export type FakeContent = { id: string; noteId: string; type: "tiptap"; data: string };

export type FakeCore = {
  readonly module: NotesnookRealCoreModule;
  readonly notes: Map<string, FakeNote>;
  readonly state: { unsynced: boolean; fullRuns: number };
};

/**
 * A synthetic Notesnook database exposing the read surface the live factory
 * probes and the write collections the composition consumes.
 */
export type SeedNote = {
  readonly id?: string;
  readonly title?: string;
  readonly data: string;
  readonly locked?: boolean;
};

export function createFakeCore(seedNotes: number | readonly SeedNote[]): FakeCore {
  const notes = new Map<string, FakeNote>();
  const content = new Map<string, FakeContent>();
  const state = { unsynced: false, fullRuns: 0 };
  let nextId = 1;
  const mint = (prefix: string): string => `${prefix}-${nextId++}`;

  const seeds: readonly SeedNote[] =
    typeof seedNotes === "number"
      ? Array.from({ length: seedNotes }, () => ({ data: "<p>synthetic body</p>" }))
      : seedNotes;
  seeds.forEach((seed, index) => {
    const id = seed.id ?? `seed-${index}`;
    notes.set(id, {
      id,
      title: seed.title ?? `Synthetic seed ${index}`,
      contentId: `seed-content-${index}`,
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: seed.locked ?? false,
      dateEdited: 100,
    });
    content.set(id, {
      id: `seed-content-${index}`,
      noteId: id,
      type: "tiptap",
      data: seed.data,
    });
  });

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
        all: { ids: async () => [...notes.keys()] },
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

export type Harness = { readonly runtime: ServiceRuntime; readonly core: FakeCore };

const cleanups: Array<() => Promise<void> | void> = [];

/** Register with `afterEach` in every test file that starts a synthetic daemon. */
export async function cleanupSyntheticDaemons(): Promise<void> {
  while (cleanups.length > 0) await cleanups.pop()?.();
}

export async function startDaemon(seedNotes: number | readonly SeedNote[]): Promise<Harness> {
  const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-ea-state-"));
  writeFileSync(join(stateDir, "db.key"), "ea-synthetic-development-key", { mode: 0o600 });
  const credentialsDir = mkdtempSync(join(tmpdir(), "nookbridge-ea-creds-"));
  writeFileSync(join(credentialsDir, "nookbridge-db-key"), "ea-synthetic-runtime-key", {
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
