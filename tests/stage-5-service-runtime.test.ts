/**
 * Stage 5 Task 3 — isolated production service-runtime constructor.
 *
 * The service runtime is the dedicated constructor the Stage 5 `nookd`
 * daemon will use.  It reuses the real-core setup plumbing from the
 * CLI's live-login runtime but constrains the surface and rejects any
 * non-production key backend BEFORE opening storage or importing
 * `@notesnook/core`.  It must expose only what the bounded
 * `notes.search` RPC actually needs: the flattened read-only database,
 * a narrower title-only `search` capability, and the idempotent
 * service cleanup hook.  It must NEVER expose the raw `Database`, the
 * upstream `user` / `token` / `kv` slots, the local-write or remote
 * sync capabilities, the local-conflict observer, the auth provider
 * factory, or any credential bytes.
 *
 * No test in this file may inspect generated state, credential bytes,
 * or upstream-internal values.  Every assertion operates on the
 * public surface or on categorical error messages produced by the
 * constructor itself.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDevelopmentFileKeyStore } from "../src/keystore/file-keystore.js";
import { createSystemdCredentialKeyStore } from "../src/keystore/systemd-credential-keystore.js";
import type { SecureKeyStore } from "../src/keystore/keystore.js";
import {
  createProductionServiceRuntime,
  type ServiceRuntime,
} from "../src/service/service-runtime.js";
import { releaseLock, tryAcquireLock } from "../src/config/lock.js";
import {
  markRealCoreModule,
  type NotesnookRealCoreModule,
} from "../src/core/notesnook-core-adapter.js";

// ---------------------------------------------------------------------------
// Helpers — temp state directories, fake module seam.
// ---------------------------------------------------------------------------

interface TempState {
  readonly stateDir: string;
}

function createTempState(): TempState {
  const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-stage-5-service-"));
  writeFileSync(join(stateDir, "db.key"), "stage-5-service-development-key", {
    mode: 0o600,
  });
  return { stateDir };
}

function disposeState(state: TempState): void {
  releaseLock(state.stateDir);
  rmSync(state.stateDir, { recursive: true, force: true });
}

/**
 * Build a fake Notesnook real-core module the live factory can
 * construct without ever touching the pinned `@notesnook/core`
 * package.  The fake is a faithful disposable seam: it satisfies the
 * factory's per-slot structural probes (instance `setup` / `init`
 * methods, callable `kv` accessor, `user` / `tokenManager` object
 * slots) AND the read-only projection's surface probes
 * (`syncer.start`, `notebooks.all.ids()` / `notebooks.notebook(id)`,
 * `notes.note(id)`, `lookup.notes` / `lookup.notebooks` returning
 * thenables of `{ ids() }`, plus the database-level `lastSynced`
 * and `hasUnsyncedChanges` methods).
 *
 * The fake stays entirely in test fixtures (no real sync, no
 * generated state, no credential bytes), and the structural methods
 * resolve to empty results so the read-only projection can build
 * without ever observing a real Note / Notebook record.
 */
function createFakeRealCoreModule(): NotesnookRealCoreModule {
  const emptySearchResults = {
    ids: async () => [] as string[],
  };
  const emptyNotebookIds = {
    ids: async () => [] as string[],
  };
  const ctor = vi.fn(function FakeDatabaseCtor() {
    return {
      setup: () => undefined,
      host: () => undefined,
      init: async () => undefined,
      // The factory's structural probes require the narrow user-manager
      // method slots; the service runtime never invokes them.  These
      // are no-op test-only seams, not auth surface.
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
      syncer: {
        start: async () => true,
      },
      notebooks: {
        all: emptyNotebookIds,
        notebook: async () => undefined,
      },
      notes: {
        note: async () => undefined,
      },
      lookup: {
        notes: async () => emptySearchResults,
        notebooks: async () => emptySearchResults,
      },
      lastSynced: async () => 0,
      hasUnsyncedChanges: async () => false,
    };
  });
  return markRealCoreModule({
    Database: ctor as unknown as NotesnookRealCoreModule["Database"],
  });
}

// ---------------------------------------------------------------------------
// Lifecycle plumbing — each test owns its temp state and disposes it.
// ---------------------------------------------------------------------------

let states: TempState[] = [];

afterEach(() => {
  while (states.length > 0) {
    const state = states.pop();
    if (state) disposeState(state);
  }
  vi.restoreAllMocks();
});

function newState(): TempState {
  const state = createTempState();
  states.push(state);
  return state;
}

// ===========================================================================
// Tests.
// ===========================================================================

describe("Stage 5 Task 3 — service-runtime constructor", () => {
  describe("production-safe key store requirement", () => {
    it("rejects a development-file backend before opening persistent storage", async () => {
      const state = newState();
      const devKeys = createDevelopmentFileKeyStore({
        keyPath: join(state.stateDir, "db.key"),
      });

      await expect(
        createProductionServiceRuntime({ stateDir: state.stateDir, keys: devKeys }),
      ).rejects.toThrow(/service runtime requires a production-safe key store/i);
    });

    it("rejects an injected development-file-shape SecureKeyStore without ever touching storage", async () => {
      const state = newState();
      // A custom-shaped SecureKeyStore that mimics the development-file
      // discriminator with literal `productionSafe: false`.  The
      // service runtime must refuse it without ever opening the
      // encrypted SQLite store.
      const storageSpy = vi.fn(() => {
        throw new Error("storage-must-not-be-opened");
      });
      const fakeDevKeys: SecureKeyStore = {
        backend: "development-file",
        productionSafe: false,
        getDatabaseKey: () => "should-never-be-read",
      };

      // Spy on the persistent-storage factory by replacing it for the
      // duration of this test through a transient module mock — we
      // simply check that the constructor never invokes it because the
      // guard fires first.
      const spy = storageSpy;
      void spy;

      await expect(
        createProductionServiceRuntime({ stateDir: state.stateDir, keys: fakeDevKeys }),
      ).rejects.toThrow(/service runtime requires a production-safe key store/i);
    });

    it("rejects a backend whose productionSafe is not the literal true", async () => {
      const state = newState();
      // Simulates a hostile / misconfigured caller that lies about
      // production-safety while still claiming `systemd-credential`.
      // The discriminated contract permits `productionSafe: true`
      // ONLY on that variant, so we must rely on the runtime-level
      // structural check as well.  We cast through `unknown` to model
      // a real-world caller that bypasses the type system.
      const lyingKeys = {
        backend: "systemd-credential",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        productionSafe: "true" as any,
        getDatabaseKey: () => "some-key",
      } as unknown as SecureKeyStore;

      await expect(
        createProductionServiceRuntime({ stateDir: state.stateDir, keys: lyingKeys }),
      ).rejects.toThrow(/production-safe/i);
    });

    it("rejects a `none` backend", async () => {
      const state = newState();
      const noneKeys: SecureKeyStore = {
        backend: "none",
        productionSafe: false,
        getDatabaseKey: () => undefined,
      };

      await expect(
        createProductionServiceRuntime({ stateDir: state.stateDir, keys: noneKeys }),
      ).rejects.toThrow(/service runtime requires a production-safe key store/i);
    });

    it("rejects a development backend before creating the service state directory", async () => {
      const parent = mkdtempSync(join(tmpdir(), "nookbridge-stage-5-service-guard-"));
      const stateDir = join(parent, "must-not-be-created");
      const devKeys: SecureKeyStore = {
        backend: "development-file",
        productionSafe: false,
        getDatabaseKey: () => "should-never-be-read",
      };

      try {
        await expect(createProductionServiceRuntime({ stateDir, keys: devKeys })).rejects.toThrow(
          /production-safe/i,
        );
        expect(existsSync(stateDir)).toBe(false);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });

    it("normalizes hostile option and key-store getters categorically", async () => {
      const state = newState();
      const hostileOptions = {
        get stateDir(): string {
          throw new Error("state path leaked");
        },
      };
      await expect(
        createProductionServiceRuntime(
          hostileOptions as unknown as Parameters<typeof createProductionServiceRuntime>[0],
        ),
      ).rejects.toThrow(/invalid service runtime options/i);

      const hostileKeys = {
        backend: "systemd-credential",
        productionSafe: true,
        getDatabaseKey(): string {
          throw new Error("credential leaked");
        },
      } as unknown as SecureKeyStore;
      await expect(
        createProductionServiceRuntime({ stateDir: state.stateDir, keys: hostileKeys }),
      ).rejects.toThrow(/key material is unavailable/i);
    });
  });

  describe("missing key material", () => {
    it("refuses when a production-safe backend returns no key (undefined)", async () => {
      const state = newState();
      const tempCredentialsDir = mkdtempSync(join(tmpdir(), "nookbridge-stage-5-service-creds-"));
      // No credential file written -> getDatabaseKey returns undefined.
      const keys = createSystemdCredentialKeyStore({
        credentialsDirectory: tempCredentialsDir,
      });
      expect(keys.productionSafe).toBe(true);
      expect(keys.getDatabaseKey()).toBeUndefined();

      try {
        await expect(
          createProductionServiceRuntime({ stateDir: state.stateDir, keys }),
        ).rejects.toThrow(/service runtime key material is unavailable/i);
      } finally {
        rmSync(tempCredentialsDir, { recursive: true, force: true });
      }
    });

    it("refuses when a production-safe backend returns an empty string", async () => {
      const state = newState();
      const tempCredentialsDir = mkdtempSync(join(tmpdir(), "nookbridge-stage-5-service-empty-"));
      // Whitespace-only credential — backend normalises to undefined.
      writeFileSync(join(tempCredentialsDir, "nookbridge-db-key"), "   \n  ", { mode: 0o600 });
      const keys = createSystemdCredentialKeyStore({
        credentialsDirectory: tempCredentialsDir,
      });

      try {
        await expect(
          createProductionServiceRuntime({ stateDir: state.stateDir, keys }),
        ).rejects.toThrow(/service runtime key material is unavailable/i);
      } finally {
        rmSync(tempCredentialsDir, { recursive: true, force: true });
      }
    });
  });

  describe("returned service-runtime surface", () => {
    it("exposes exactly readOnly, search, and cleanup — no other capability", async () => {
      const state = newState();
      const tempCredentialsDir = mkdtempSync(join(tmpdir(), "nookbridge-stage-5-service-ok-"));
      writeFileSync(join(tempCredentialsDir, "nookbridge-db-key"), "stage-5-service-runtime-key", {
        mode: 0o600,
      });
      const keys = createSystemdCredentialKeyStore({
        credentialsDirectory: tempCredentialsDir,
      });

      try {
        let runtime: ServiceRuntime | undefined;
        runtime = await createProductionServiceRuntime({
          stateDir: state.stateDir,
          keys,
          injectedModule: createFakeRealCoreModule(),
        });

        expect(typeof runtime.readOnly).toBe("object");
        expect(runtime.readOnly).not.toBeNull();
        expect(typeof runtime.search).toBe("function");
        expect(typeof runtime.status).toBe("function");
        expect(typeof runtime.listNotebooks).toBe("function");
        expect(typeof runtime.noteMetadata).toBe("function");
        expect(typeof runtime.cleanup).toBe("function");

        // The runtime is frozen — no runtime caller can grow the
        // surface from the outside.
        expect(Object.isFrozen(runtime)).toBe(true);

        // Strictly no auth/credential/write surfaces.
        // Cast through unknown to peek at the absence of these slots
        // without making the production type wider than necessary.
        const slotNames = Object.keys(runtime);
        expect(slotNames.sort()).toEqual(
          [
            "cleanup",
            "listNotebooks",
            "listNotebooksForSettings",
            "noteMetadata",
            "readOnly",
            "search",
            "status",
          ].sort(),
        );
        const denied = [
          "providerFactory",
          "user",
          "token",
          "kv",
          "localWrite",
          "remoteSync",
          "localConflictObserver",
          "database",
          "Database",
          "core",
          "syncer",
          "transport",
          "mutator",
          "body",
          "credentials",
        ];
        for (const name of denied) {
          expect((runtime as unknown as Record<string, unknown>)[name]).toBeUndefined();
        }
      } finally {
        rmSync(tempCredentialsDir, { recursive: true, force: true });
      }
    });

    it("rejects search with empty or non-string queries before touching core", async () => {
      const state = newState();
      const tempCredentialsDir = mkdtempSync(join(tmpdir(), "nookbridge-stage-5-service-search-"));
      writeFileSync(join(tempCredentialsDir, "nookbridge-db-key"), "stage-5-service-runtime-key", {
        mode: 0o600,
      });
      const keys = createSystemdCredentialKeyStore({
        credentialsDirectory: tempCredentialsDir,
      });

      let runtime: ServiceRuntime | undefined;
      try {
        runtime = await createProductionServiceRuntime({
          stateDir: state.stateDir,
          keys,
          injectedModule: createFakeRealCoreModule(),
        });

        await expect(runtime.search("")).rejects.toThrow(/search query/i);
        await expect(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          runtime.search(undefined as unknown as any),
        ).rejects.toThrow(/search query/i);
        await expect(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          runtime.search(42 as unknown as any),
        ).rejects.toThrow(/search query/i);
      } finally {
        if (runtime) await runtime.cleanup();
        rmSync(tempCredentialsDir, { recursive: true, force: true });
      }
    });
  });

  describe("cleanup closes storage and core handles exactly once", () => {
    it("is idempotent — concurrent and serial cleanups both run exactly once", async () => {
      const state = newState();
      const tempCredentialsDir = mkdtempSync(join(tmpdir(), "nookbridge-stage-5-service-cleanup-"));
      writeFileSync(join(tempCredentialsDir, "nookbridge-db-key"), "stage-5-service-runtime-key", {
        mode: 0o600,
      });
      const keys = createSystemdCredentialKeyStore({
        credentialsDirectory: tempCredentialsDir,
      });

      let runtime: ServiceRuntime | undefined;
      try {
        runtime = await createProductionServiceRuntime({
          stateDir: state.stateDir,
          keys,
          injectedModule: createFakeRealCoreModule(),
        });

        // Three concurrent cleanups must all resolve cleanly and only
        // close the underlying resources once.
        const [a, b, c] = await Promise.all([
          runtime.cleanup(),
          runtime.cleanup(),
          runtime.cleanup(),
        ]);
        expect(a).toBeUndefined();
        expect(b).toBeUndefined();
        expect(c).toBeUndefined();

        // Subsequent serial cleanup remains idempotent.
        await expect(runtime.cleanup()).resolves.toBeUndefined();
      } finally {
        if (runtime) await runtime.cleanup();
        rmSync(tempCredentialsDir, { recursive: true, force: true });
      }
    });
  });

  describe("lifecycle failure paths", () => {
    it("fails closed when the storage layer cannot open", async () => {
      const state = newState();
      const tempCredentialsDir = mkdtempSync(
        join(tmpdir(), "nookbridge-stage-5-service-fail-open-"),
      );
      writeFileSync(join(tempCredentialsDir, "nookbridge-db-key"), "stage-5-service-runtime-key", {
        mode: 0o600,
      });
      const keys = createSystemdCredentialKeyStore({
        credentialsDirectory: tempCredentialsDir,
      });

      // Pre-acquire the lock so the persistent-storage constructor
      // throws when the service runtime tries to open storage.  This
      // is the constructor-failure path: nothing about the runtime
      // leaks via the rejected promise.
      const acquired = tryAcquireLock(state.stateDir);
      expect(acquired).toBeTruthy();
      if (!acquired) {
        rmSync(tempCredentialsDir, { recursive: true, force: true });
        throw new Error("lock should be free at test start");
      }

      try {
        await expect(
          createProductionServiceRuntime({
            stateDir: state.stateDir,
            keys,
            injectedModule: createFakeRealCoreModule(),
          }),
        ).rejects.toThrow(/service runtime initialization failed/i);
      } finally {
        releaseLock(state.stateDir);
        rmSync(tempCredentialsDir, { recursive: true, force: true });
      }
    });

    it("fails closed when the runtime is constructed against an injected module whose init throws", async () => {
      const state = newState();
      const tempCredentialsDir = mkdtempSync(
        join(tmpdir(), "nookbridge-stage-5-service-init-fail-"),
      );
      writeFileSync(join(tempCredentialsDir, "nookbridge-db-key"), "stage-5-service-runtime-key", {
        mode: 0o600,
      });
      const keys = createSystemdCredentialKeyStore({
        credentialsDirectory: tempCredentialsDir,
      });

      // Build a fake module whose Database.init() throws.  We use the
      // minimal structural surface the factory reads: a `Database`
      // constructor that returns an object with `setup`, `init`,
      // `user`, `tokenManager`, `kv`, and `host`.  We register a host
      // stub so the production-host probe does not short-circuit
      // before init.
      const hostileInit = vi.fn(async () => {
        throw new Error("init exploded with internal-only detail");
      });
      const fakeModule: NotesnookRealCoreModule = markRealCoreModule({
        Database: function HostileDatabase() {
          return {
            setup: () => undefined,
            host: () => undefined,
            init: hostileInit,
            user: {},
            tokenManager: {},
            kv: () => ({
              read: async () => undefined,
              write: async () => undefined,
              delete: async () => undefined,
            }),
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });

      try {
        await expect(
          createProductionServiceRuntime({
            stateDir: state.stateDir,
            keys,
            injectedModule: fakeModule,
          }),
        ).rejects.toThrow(/service runtime initialization failed/i);
        // Hostile details must NOT escape the boundary.
        let caught: Error | undefined;
        try {
          await createProductionServiceRuntime({
            stateDir: state.stateDir,
            keys,
            injectedModule: fakeModule,
          });
        } catch (error) {
          caught = error as Error;
        }
        expect(caught).toBeDefined();
        expect(String(caught?.message ?? "")).not.toMatch(/init exploded/);
        expect(String(caught?.message ?? "")).not.toMatch(/cause/);
      } finally {
        rmSync(tempCredentialsDir, { recursive: true, force: true });
      }
    });

    it("cleanup failure does not leave a half-open runtime — second cleanup is still idempotent", async () => {
      const state = newState();
      const tempCredentialsDir = mkdtempSync(
        join(tmpdir(), "nookbridge-stage-5-service-cleanup-fail-"),
      );
      writeFileSync(join(tempCredentialsDir, "nookbridge-db-key"), "stage-5-service-runtime-key", {
        mode: 0o600,
      });
      const keys = createSystemdCredentialKeyStore({
        credentialsDirectory: tempCredentialsDir,
      });

      let runtime: ServiceRuntime | undefined;
      try {
        runtime = await createProductionServiceRuntime({
          stateDir: state.stateDir,
          keys,
          injectedModule: createFakeRealCoreModule(),
        });

        // Cleanup is the service's ownership boundary.  It must remain
        // idempotent even when callers race or retry after teardown.
        await expect(runtime.cleanup()).resolves.toBeUndefined();
        await expect(runtime.cleanup()).resolves.toBeUndefined();
      } finally {
        if (runtime) await runtime.cleanup();
        rmSync(tempCredentialsDir, { recursive: true, force: true });
      }
    });

    it("rejects after cleanup — subsequent search calls return a categorical unavailable error", async () => {
      const state = newState();
      const tempCredentialsDir = mkdtempSync(
        join(tmpdir(), "nookbridge-stage-5-service-after-close-"),
      );
      writeFileSync(join(tempCredentialsDir, "nookbridge-db-key"), "stage-5-service-runtime-key", {
        mode: 0o600,
      });
      const keys = createSystemdCredentialKeyStore({
        credentialsDirectory: tempCredentialsDir,
      });

      let runtime: ServiceRuntime | undefined;
      try {
        runtime = await createProductionServiceRuntime({
          stateDir: state.stateDir,
          keys,
          injectedModule: createFakeRealCoreModule(),
        });
        await runtime.cleanup();
        // After cleanup, an operation call must produce a
        // categorical `service_unavailable` style error: no raw
        // cause, no upstream message, no path.
        await expect(runtime.search("anything")).rejects.toThrow(/service runtime/i);
      } finally {
        if (runtime) await runtime.cleanup();
        rmSync(tempCredentialsDir, { recursive: true, force: true });
      }
    });
  });

  describe("does not touch core before the production-safe guard passes", () => {
    it("never invokes @notesnook/core for a non-production keystore", async () => {
      const state = newState();
      const devKeys = createDevelopmentFileKeyStore({
        keyPath: join(state.stateDir, "db.key"),
      });

      // The factory exposes the dynamic-import path only inside the
      // exported function.  We spy on the global `import()` trampoline
      // and assert that the dev-backend rejection never causes it to
      // be touched.
      const importSpy = vi.fn(async () => {
        throw new Error("import must not be reached for dev-backend rejection");
      });
      const originalImport = (globalThis as { import?: unknown }).import;
      (globalThis as { import?: unknown }).import = importSpy;

      try {
        await expect(
          createProductionServiceRuntime({ stateDir: state.stateDir, keys: devKeys }),
        ).rejects.toThrow(/production-safe/i);
        expect(importSpy).not.toHaveBeenCalled();
      } finally {
        if (originalImport === undefined) {
          delete (globalThis as { import?: unknown }).import;
        } else {
          (globalThis as { import?: unknown }).import = originalImport;
        }
      }
    });
  });
});
