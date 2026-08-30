/**
 * Stage 4 — explicit remote executor and operator sync command.
 *
 * All tests are offline. The live executor receives only an upstream-shaped
 * syncer fake; the command tests use the same narrow runtime seams as the CLI.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDevelopmentFileKeyStore } from "../src/keystore/file-keystore.js";
import { createPersistentStorage } from "../src/storage/persistent-storage.js";
import {
  PersistentSyncMetadataStateStore,
  SYNC_COORDINATOR_STATE_KEY,
} from "../src/core/notesnook-sync-state-store.js";
import {
  createLiveRemoteSyncCapability,
  createLiveRemoteSyncExecutor,
} from "../src/core/notesnook-live-remote-sync.js";
import { SyncCoordinator, type SyncLocalCommit } from "../src/core/notesnook-sync-coordinator.js";
import { isNotesnookWriteContractError } from "../src/core/notesnook-write-contract.js";
import {
  formatWriteCommandResult,
  parseWriteCommand,
  runWriteCommand,
  type NotesnookLiveWriteCapability,
  type NotesnookLiveWriteRuntime,
} from "../src/core/notesnook-write-admin.js";
import type { NotesnookLocalWriteResult } from "../src/core/notesnook-write-composition.js";

const NOTE_ID = "remote-executor-test-note";

function localCapability(onWrite?: () => void): NotesnookLiveWriteCapability {
  const result = (operation: "create" | "append" | "update") =>
    Promise.resolve({
      operation,
      id: NOTE_ID,
      localCommitted: true as const,
      remoteSynced: false as const,
      pendingSync: true as const,
    } as unknown as NotesnookLocalWriteResult);
  return {
    createNote: async () => {
      onWrite?.();
      return result("create");
    },
    appendNote: async () => {
      onWrite?.();
      return result("append");
    },
    updateNote: async () => {
      onWrite?.();
      return result("update");
    },
    pendingSnapshot: () => ({ pending: [] }),
  };
}

function commit(): SyncLocalCommit {
  return {
    operation: "create",
    id: NOTE_ID,
    localCommitted: true,
    remoteSynced: false,
    pendingSync: true,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isNotesnookWriteContractError(error)) return error.code;
  }
  throw new Error("expected categorical failure");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function persistentStateStore(): {
  stateDir: string;
  storage: ReturnType<typeof createPersistentStorage>;
  store: PersistentSyncMetadataStateStore;
} {
  const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-stage4-remote-"));
  const keyPath = join(stateDir, "db.key");
  writeFileSync(keyPath, "stage-4-remote-executor-test-key", { mode: 0o600 });
  const keys = createDevelopmentFileKeyStore({ keyPath });
  const storage = createPersistentStorage({ stateDir, keys });
  return { stateDir, storage, store: new PersistentSyncMetadataStateStore(storage) };
}

describe("Stage 4 live remote executor", () => {
  it("binds syncer.start and supplies exactly full without caller options", async () => {
    const calls: unknown[] = [];
    const syncer = {
      start(this: object, options: unknown) {
        calls.push({ thisValue: this, options });
        return Promise.resolve(true);
      },
    };
    const executor = createLiveRemoteSyncExecutor({ syncer }, () => undefined);

    await expect(executor({ pending: [] })).resolves.toEqual({ status: "confirmed" });
    expect(calls).toEqual([{ thisValue: syncer, options: { type: "full" } }]);
  });

  it("maps false and throws without leaking upstream details", async () => {
    const falseExecutor = createLiveRemoteSyncExecutor(
      {
        syncer: { start: () => Promise.resolve(false) },
      },
      () => undefined,
    );
    await expect(falseExecutor({ pending: [] })).resolves.toEqual({ status: "failed" });

    const throwExecutor = createLiveRemoteSyncExecutor(
      {
        syncer: {
          start: () => {
            throw new Error("SECRET-UPSTREAM-CANARY");
          },
        },
      },
      () => undefined,
    );
    await expect(throwExecutor({ pending: [] })).resolves.toEqual({ status: "retry" });
  });

  it("rejects hostile syncer getters categorically", () => {
    const database = {};
    Object.defineProperty(database, "syncer", {
      get() {
        throw new Error("SECRET-SYNCER-CANARY");
      },
    });
    expect(codeOf(() => createLiveRemoteSyncExecutor(database, () => undefined))).toBe(
      "invalid_input",
    );
  });

  it("does not invoke the syncer after lifecycle closure", async () => {
    let open = true;
    let calls = 0;
    const executor = createLiveRemoteSyncExecutor(
      {
        syncer: {
          start: () => {
            calls++;
            return Promise.resolve(true);
          },
        },
      },
      () => {
        if (!open) throw new Error("closed");
      },
    );
    open = false;
    await expect(executor({ pending: [] })).resolves.toEqual({ status: "retry" });
    expect(calls).toBe(0);
  });

  it("normalizes hostile rejected values and forged result fields", async () => {
    const hostileRejection = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("SECRET-PROXY-CANARY");
        },
      },
    );
    const hostileCapability = createLiveRemoteSyncCapability(
      () => Promise.reject(hostileRejection),
      () => undefined,
    );
    await expect(hostileCapability.requestSync()).rejects.toMatchObject({ code: "sync_failed" });

    const forged = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(forged, {
      status: { value: "synced", enumerable: true },
      localCommitted: { value: true, enumerable: true },
      remoteSynced: { value: true, enumerable: true },
      pendingSync: { value: false, enumerable: true },
      attempts: { value: 1, enumerable: true },
      startedAt: { value: 1, enumerable: true },
      secretBody: { value: "SECRET-BODY-CANARY", enumerable: true },
    });
    const forgedCapability = createLiveRemoteSyncCapability(
      () => Promise.resolve(forged as never),
      () => undefined,
    );
    const normalized = await forgedCapability.requestSync();
    expect(normalized).toEqual({
      status: "synced",
      localCommitted: true,
      remoteSynced: true,
      pendingSync: false,
      attempts: 1,
      startedAt: 1,
    });
    expect(normalized).not.toHaveProperty("secretBody");
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it("checks lifecycle before invoking the coordinator capability", async () => {
    let open = true;
    let calls = 0;
    const capability = createLiveRemoteSyncCapability(
      async () => {
        calls++;
        return {
          status: "synced",
          localCommitted: true,
          remoteSynced: true,
          pendingSync: false,
          attempts: 1,
          startedAt: 1,
        };
      },
      () => {
        if (!open) throw new Error("closed");
      },
    );
    open = false;
    await expect(capability.requestSync()).rejects.toMatchObject({ code: "sync_failed" });
    expect(calls).toBe(0);
  });
  it("normalizes a hostile cleanup getter", async () => {
    const runtime = new Proxy(
      { capability: localCapability() },
      {
        get(target, property, receiver) {
          if (property === "cleanup") throw new Error("SECRET-CLEANUP-CANARY");
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const result = await runWriteCommand({
      argv: ["create", "--title", "safe-title"],
      env: { NOOKBRIDGE_ENABLE_LIVE_SYNC: "1" },
      createWriteRuntime: () => runtime as unknown as NotesnookLiveWriteRuntime,
    });
    expect(result).toEqual({
      kind: "error",
      exitCode: 3,
      message: "nookctl write: local write teardown failed",
    });
    expect(formatWriteCommandResult(result)).not.toContain("SECRET-CLEANUP-CANARY");
  });

  it("round-trips through encrypted PersistentStorage and recovers after reopen", () => {
    const fixture = persistentStateStore();
    const state = { pending: [{ operation: "create" as const, noteId: NOTE_ID, sequence: 1 }] };
    try {
      fixture.store.save(state);
      expect(fixture.store.load()).toEqual(state);
      fixture.storage.close();

      const keyPath = join(fixture.stateDir, "db.key");
      const keys = createDevelopmentFileKeyStore({ keyPath });
      const reopened = createPersistentStorage({ stateDir: fixture.stateDir, keys });
      try {
        const recovered = new PersistentSyncMetadataStateStore(reopened);
        expect(recovered.load()).toEqual(state);
        expect(reopened.readSync<string>(SYNC_COORDINATOR_STATE_KEY)).toContain("noteId");
      } finally {
        reopened.close();
      }
    } finally {
      try {
        fixture.storage.close();
      } catch {
        // already closed
      }
      rmSync(fixture.stateDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed persisted JSON", () => {
    const values = new Map<string, unknown>([[SYNC_COORDINATOR_STATE_KEY, "{malformed"]]);
    const store = new PersistentSyncMetadataStateStore({
      readSync: <T>(key: string) => values.get(key) as T | undefined,
      writeSync: <T>(key: string, value: T) => values.set(key, value),
    });
    expect(() => store.load()).toThrow("invalid persisted sync metadata");
  });

  it("accepts only canonical metadata and normalizes hostile storage failures", () => {
    const values = new Map<string, unknown>();
    const store = new PersistentSyncMetadataStateStore({
      readSync: <T>(key: string) => values.get(key) as T | undefined,
      writeSync: <T>(key: string, value: T) => values.set(key, value),
    });
    expect(() => store.save({ pending: [], secretBody: "SECRET-BODY-CANARY" } as never)).toThrow(
      "failed to persist sync metadata",
    );
    expect(values.has(SYNC_COORDINATOR_STATE_KEY)).toBe(false);

    const hostileStorage = new Proxy(
      {},
      {
        get() {
          throw new Error("SECRET-STORAGE-CANARY");
        },
      },
    );
    expect(() => new PersistentSyncMetadataStateStore(hostileStorage as never)).toThrow(
      "invalid sync metadata storage",
    );
  });
});

describe("Stage 4 shared coordinator and write sync command", () => {
  it("keeps local pending metadata until an explicit sync and coalesces concurrent calls", async () => {
    const gate = deferred<true>();
    let calls = 0;
    const syncer = {
      start: () => {
        calls++;
        return gate.promise;
      },
    };
    const coordinator = new SyncCoordinator({
      executor: createLiveRemoteSyncExecutor({ syncer }, () => undefined),
    });
    coordinator.recordLocalCommit(commit());
    expect(coordinator.snapshot().pending).toHaveLength(1);

    const capability = createLiveRemoteSyncCapability(
      coordinator.requestSync.bind(coordinator),
      () => undefined,
    );
    const first = capability.requestSync();
    const second = capability.requestSync();
    expect(calls).toBe(1);

    gate.resolve(true);
    await expect(first).resolves.toMatchObject({ status: "synced", pendingSync: false });
    await expect(second).resolves.toMatchObject({ status: "synced", pendingSync: false });
    expect(coordinator.snapshot()).toEqual({ pending: [] });
  });

  it("preserves pending state across coordinator restart", async () => {
    let stored: unknown;
    const stateStore = {
      load: () => stored,
      save: (state: unknown) => {
        stored = state;
      },
    };
    const first = new SyncCoordinator({
      stateStore,
      executor: async () => ({ status: "failed" as const }),
    });
    first.recordLocalCommit(commit());

    let calls = 0;
    const second = new SyncCoordinator({
      stateStore,
      executor: async () => {
        calls++;
        return { status: "confirmed" as const };
      },
    });
    expect(second.snapshot().pending).toHaveLength(1);
    await expect(second.requestSync()).resolves.toMatchObject({ status: "synced" });
    expect(calls).toBe(1);
  });

  it("parses sync without accepting IDs, bodies, flags, or credential carriers", () => {
    expect(parseWriteCommand(["sync"], {})).toMatchObject({
      kind: "parsed",
      command: { kind: "sync", subcommand: "sync" },
    });
    expect(parseWriteCommand(["sync", "--force"], {})).toMatchObject({ kind: "error" });
    expect(parseWriteCommand(["sync", "--note-id", NOTE_ID], {})).toMatchObject({ kind: "error" });
    expect(parseWriteCommand(["sync"], { NOOKBRIDGE_TOKEN: "CANARY" })).toMatchObject({
      kind: "error",
    });
  });

  it("gates sync before runtime construction and invokes only remoteSync", async () => {
    let constructed = 0;
    let synced = 0;
    let writes = 0;
    let cleaned = 0;
    const runtime = (): NotesnookLiveWriteRuntime => ({
      capability: localCapability(() => writes++),
      remoteSync: {
        requestSync: async () => {
          synced++;
          return {
            status: "synced",
            localCommitted: true,
            remoteSynced: true,
            pendingSync: false,
            attempts: 1,
            startedAt: 1,
          };
        },
      },
      cleanup: () => {
        cleaned++;
      },
    });

    await expect(
      runWriteCommand({
        argv: ["sync"],
        env: {},
        createWriteRuntime: () => {
          constructed++;
          return runtime();
        },
      }),
    ).resolves.toMatchObject({ kind: "error", exitCode: 2 });
    expect(constructed).toBe(0);

    const result = await runWriteCommand({
      argv: ["sync"],
      env: { NOOKBRIDGE_ENABLE_LIVE_SYNC: "1" },
      createWriteRuntime: () => {
        constructed++;
        return runtime();
      },
    });
    expect(result).toMatchObject({ kind: "sync-report", report: { status: "synced" } });
    expect(constructed).toBe(1);
    expect(synced).toBe(1);
    expect(writes).toBe(0);
    expect(cleaned).toBe(1);
    expect(formatWriteCommandResult(result)).not.toContain(NOTE_ID);
  });

  it("keeps local create no-auto-sync and reports remote pending", async () => {
    let syncCalls = 0;
    const result = await runWriteCommand({
      argv: ["create", "--title", "safe-title"],
      env: { NOOKBRIDGE_ENABLE_LIVE_SYNC: "1" },
      createWriteRuntime: () => ({
        capability: localCapability(),
        remoteSync: {
          requestSync: async () => {
            syncCalls++;
            return {
              status: "synced",
              localCommitted: true,
              remoteSynced: true,
              pendingSync: false,
              attempts: 1,
              startedAt: 1,
            };
          },
        },
      }),
    });
    expect(result).toMatchObject({
      kind: "report",
      report: { remoteSynced: false, pendingSync: true },
    });
    expect(syncCalls).toBe(0);
  });
});
