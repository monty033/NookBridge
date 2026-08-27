/**
 * Stage 2B-live regression: the live-login SQLite dialect must not forward
 * upstream's `init` bootstrap callback to kysely as `onCreateConnection`.
 *
 * Upstream `@notesnook/core@8.1.3` `createDatabase(name, options)` builds its
 * kysely instance as:
 *
 *     new Kysely({ dialect: options.dialect(name, async () => {
 *       await db.connection().execute(async (conn) => { ...bootstrap... });
 *     }) })
 *
 * and then (when `skipInitialization` is falsy) runs that same bootstrap
 * itself.  The second argument is therefore upstream's OWN bootstrap driver,
 * not a connection hook.  Passing it to `SqliteDialect` as
 * `onCreateConnection` makes `SqliteDriver.init()` re-enter the driver
 * through `db.connection()`:
 *
 *     driver.init() -> onCreateConnection -> bootstrap -> connection()
 *       -> driver.init() -> ...  => RangeError: Maximum call stack size exceeded
 *
 * which aborted `Database.init()` before the live-login runtime could return a
 * handle.  These tests exercise the REAL production runtime
 * (`createProductionLiveLoginRuntime`) with a probe core module that mirrors
 * upstream's `createDatabase` wiring against a real kysely + real encrypted
 * `better-sqlite3-multiple-ciphers` database, and assert:
 *
 *   1. the dialect the production runtime hands back never invokes the
 *      supplied `init` callback from `SqliteDriver.init()` (no recursion), and
 *      upstream's own bootstrap runs exactly once and can execute SQL;
 *   2. the assertion in (1) is non-vacuous — the same driver-level probe DOES
 *      observe the callback when a dialect is deliberately constructed with
 *      `onCreateConnection`.
 *
 * No network, no credentials, and no live account are involved: the pinned
 * `@notesnook/core` package is never imported (the runtime's injected-module
 * seam is used instead), and only local temp-directory SQLite files are
 * touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { Kysely, SqliteDialect, type Dialect } from "@streetwriters/kysely";
import Database from "better-sqlite3-multiple-ciphers";

import { createProductionLiveLoginRuntime } from "../src/auth/live-login-runtime.js";
import {
  markRealCoreModule,
  type NotesnookDatabaseSetupOptions,
  type NotesnookRealCoreModule,
} from "../src/core/notesnook-core-adapter.js";
import { releaseLock } from "../src/config/lock.js";

/** Minimal schema the probe bootstrap creates inside the live SQLite file. */
interface ProbeSchema {
  live_init_probe: { id: string };
}

/** The narrow driver surface `Dialect.createDriver()` exposes. */
interface ProbeDriver {
  init(): Promise<void>;
  destroy(): Promise<void>;
}

type CoreProbe = Readonly<{
  module: NotesnookRealCoreModule;
  /** Setup options the production runtime passed to `Database.setup`. */
  setupOptions: () => NotesnookDatabaseSetupOptions;
  /** How many times upstream's own bootstrap body ran. */
  bootstrapRuns: () => number;
  /** How many times the `init` callback handed to `dialect(...)` was called. */
  initCallbackRuns: () => number;
  /** Rows the bootstrap wrote, read back through the live dialect. */
  probeRows: () => readonly string[];
  /** Tear down every kysely instance the probe created. */
  destroyAll: () => Promise<void>;
}>;

/**
 * Build a probe core module whose `init()` reproduces upstream's
 * `createDatabase` wiring verbatim against the dialect the runtime supplies.
 */
function createCoreProbe(): CoreProbe {
  let setupOptions: NotesnookDatabaseSetupOptions | undefined;
  let bootstrapRuns = 0;
  let initCallbackRuns = 0;
  const probeRows: string[] = [];
  const instances: Kysely<ProbeSchema>[] = [];

  const runBootstrap = async (conn: Kysely<ProbeSchema>): Promise<void> => {
    bootstrapRuns += 1;
    await conn.schema
      .createTable("live_init_probe")
      .ifNotExists()
      .addColumn("id", "text")
      .execute();
    await conn
      .insertInto("live_init_probe")
      .values({ id: `bootstrap-${bootstrapRuns}` })
      .execute();
  };

  const user = {
    authenticateEmail: vi.fn(async () => ({ scope: "notes" })),
    authenticateMultiFactorCode: vi.fn(async () => undefined),
    authenticatePassword: vi.fn(async () => undefined),
    _login: vi.fn(async () => undefined),
    getUser: vi.fn(async () => ({ id: "probe-user", email: "probe@example.test" })),
    logout: vi.fn(async () => undefined),
  };
  const tokenManager = {
    getToken: vi.fn(async () => undefined),
    _refreshToken: vi.fn(async () => undefined),
  };
  const kvStorage = {
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };

  class ProbeCoreDatabase {
    readonly user = user;
    readonly tokenManager = tokenManager;
    readonly kv = () => kvStorage;

    setup(options: NotesnookDatabaseSetupOptions): void {
      setupOptions = options;
    }

    /**
     * Mirror of upstream `@notesnook/core@8.1.3` `createDatabase("notesnook", ...)`:
     * the dialect factory receives a bootstrap callback that itself calls
     * `db.connection().execute(...)`, and upstream then runs that bootstrap
     * once directly.
     */
    async init(): Promise<void> {
      if (!setupOptions) throw new Error("probe init ran before setup");
      const dialectFactory = setupOptions.sqliteOptions.dialect;
      const db: Kysely<ProbeSchema> = new Kysely<ProbeSchema>({
        dialect: dialectFactory("notesnook", async () => {
          initCallbackRuns += 1;
          await db.connection().execute(runBootstrap);
        }) as unknown as Dialect,
      });
      instances.push(db);
      await db.connection().execute(runBootstrap);
      const rows = await db.selectFrom("live_init_probe").select("id").execute();
      for (const row of rows) probeRows.push(row.id);
    }
  }

  return {
    module: markRealCoreModule({
      Database: ProbeCoreDatabase,
    } as unknown as NotesnookRealCoreModule),
    setupOptions: () => {
      if (!setupOptions) throw new Error("probe never received setup options");
      return setupOptions;
    },
    bootstrapRuns: () => bootstrapRuns,
    initCallbackRuns: () => initCallbackRuns,
    probeRows: () => probeRows,
    destroyAll: async () => {
      for (const instance of instances.splice(0)) {
        await instance.destroy();
      }
    },
  };
}

describe("Stage 2B-live SQLite dialect init-recursion regression", () => {
  it("initialises the production runtime without re-entering the dialect through onCreateConnection", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-init-recursion-"));
    const probe = createCoreProbe();
    let cleanup: (() => void | Promise<void>) | undefined;

    try {
      const runtime = await createProductionLiveLoginRuntime({
        stateDir,
        injectedModule: probe.module,
      });
      cleanup = runtime.cleanup;

      // Upstream's bootstrap ran exactly once — from upstream's own
      // `db.connection().execute(...)` call, never re-entered by the driver.
      expect(probe.initCallbackRuns()).toBe(0);
      expect(probe.bootstrapRuns()).toBe(1);
      // Non-vacuous: the dialect really opened the encrypted database and
      // executed SQL through it.
      expect(probe.probeRows()).toEqual(["bootstrap-1"]);
      // The narrow handle survived `Database.init()` (the recursion aborted it).
      expect(typeof runtime.providerFactory).toBe("function");
    } finally {
      await probe.destroyAll();
      if (cleanup) await cleanup();
      releaseLock(stateDir);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("never wires the init callback as onCreateConnection, and the probe would notice if it did", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-init-recursion-driver-"));
    const probe = createCoreProbe();
    let cleanup: (() => void | Promise<void>) | undefined;

    try {
      const runtime = await createProductionLiveLoginRuntime({
        stateDir,
        injectedModule: probe.module,
      });
      cleanup = runtime.cleanup;

      // Ask the production dialect factory for a fresh dialect and drive the
      // kysely driver's own `init()` — the only place `onCreateConnection`
      // would ever fire.
      const initCallback = vi.fn(async () => undefined);
      const dialect = probe
        .setupOptions()
        .sqliteOptions.dialect("notesnook-logs", initCallback) as unknown as Dialect;
      const driver = dialect.createDriver() as unknown as ProbeDriver;
      await driver.init();
      expect(initCallback).not.toHaveBeenCalled();

      // Control: the same driver-level probe DOES observe the callback when a
      // dialect is deliberately built with `onCreateConnection`, so the
      // assertion above cannot pass vacuously.
      const wiredCallback = vi.fn(async () => undefined);
      const wiredDatabase = new Database(":memory:");
      const wiredDriver = new SqliteDialect({
        database: wiredDatabase,
        onCreateConnection: wiredCallback,
      }).createDriver() as unknown as ProbeDriver;
      try {
        await wiredDriver.init();
        expect(wiredCallback).toHaveBeenCalledTimes(1);
      } finally {
        await wiredDriver.destroy();
      }
    } finally {
      await probe.destroyAll();
      if (cleanup) await cleanup();
      releaseLock(stateDir);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
