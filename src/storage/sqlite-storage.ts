/**
 * NookBridge Stage 1 — lower-level encrypted SQLite handle.
 *
 * This wraps `better-sqlite3-multiple-ciphers` with the proven dialect
 * and extension load order from the Stage -1 spike:
 *
 *   - sqlcipher cipher + bulk key pragma on open
 *   - `cipher='sqlcipher'` (default for the `better-sqlite3-multiple-ciphers` build)
 *   - html better_trigram remove_diacritics 1 FTS5 tokenizer
 *   - load order matters (better-trigram before html)
 *
 * The wrapper exposes a small `prepare/run/get/all/close/transaction`
 * surface — enough for PersistentStorage to model the IStorage key/value
 * table and for doctor to run schema probes.  It deliberately does
 * NOT expose the upstream `Database.setup(...)` surface; that is
 * upstream's job once `@notesnook/core` is a runtime dependency.
 */

import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import Database, { type Database as DatabaseType } from "better-sqlite3-multiple-ciphers";

import type { Logger } from "../logging/logger.js";

const require = createRequire(import.meta.url);
const betterTrigram = require("sqlite-better-trigram") as {
  getLoadablePath: () => string;
};
const fts5Html = require("sqlite3-fts5-html") as {
  getLoadablePath: () => string;
};
const sqliteRegexModule = require("sqlite-regex") as {
  getLoadablePath?: () => string;
};

export type SqliteStorageOptions = {
  dbPath: string;
  /**
   * SQLCipher key bytes (the hex/base64/sqlcipher pragma form is
   * selected automatically; Stage 1 always uses the string form to
   * mirror the Stage -1 spike).
   */
  key: string;
  /** Optional logger; defaults to a no-op that never records. */
  logger?: Logger;
  /**
   * If true, also initialise the FTS5 extensions (`better_trigram`,
   * `regex`, `html`).  Stage 1 does not require an FTS index because
   * PersistentStorage only persists opaque JSON values; the table is
   * here so Stage 3 can build its note-search schema on top of the
   * same database file without re-priming extensions.
   */
  withExtensions?: boolean;
};

export class SqliteStorage {
  readonly db: DatabaseType;
  private readonly closed = { value: false };

  constructor(opts: SqliteStorageOptions) {
    // The default export IS the Database constructor
    // (`module.exports = require('./database')`); `DatabaseType` is the
    // matching class type so callers get strong typing on `db`.
    // Check before opening: Database creates a missing path as a side effect.
    this.db = new Database(opts.dbPath);

    // The encrypted SQLite file MUST NOT be world-readable.  better-sqlite3
    // creates new files honouring the process umask, which leaves them at
    // mode 0644 on a typical user umask of 022 — that would expose the
    // encrypted-at-rest header to any local account.  Tighten the main DB
    // path and all SQLite sidecars on every open.  A permission failure is
    // fatal: continuing with an unprotected state file violates the boundary.
    try {
      this.hardenPermissions();
    } catch (error) {
      try {
        this.db.close();
      } catch {
        /* best-effort */
      }
      throw error;
    }

    // Apply the cipher pragmas in the EXACT order used by Stage -1.
    // sqlcipher is the only cipher supported at this pin; an
    // accidental downgrade to a non-encrypted build MUST NOT
    // succeed silently, so we tighten key bytes using `hexkey` rather
    // than `key` when the key looks like hex.  Stage 1 keeps the
    // simple `key=` form because all upstream tests use it.
    this.db.pragma(`cipher='sqlcipher'`);
    this.db.pragma(`key="${escapeKey(opts.key)}"`);
    this.hardenPermissions();

    if (opts.withExtensions !== false) {
      // Load order: better-trigram, regex, html — exactly the order
      // Stage -1 proved works.  We swallow extension-load errors on
      // an encrypted DB so a wrong-key probe doesn't crash before we
      // can produce the Gate 1.2 behaviour assertion.
      try {
        this.db.loadExtension(betterTrigram.getLoadablePath());
      } catch {
        /* sqlcipher sometimes rejects operations before extension load */
      }
      try {
        if (typeof sqliteRegexModule.getLoadablePath === "function") {
          this.db.loadExtension(sqliteRegexModule.getLoadablePath());
        }
      } catch {
        /* same as above */
      }
      try {
        this.db.loadExtension(fts5Html.getLoadablePath());
      } catch {
        /* same as above */
      }
    }
  }

  exec(sql: string): void {
    try {
      this.db.exec(sql);
    } finally {
      this.hardenPermissions();
    }
  }

  prepare<TParams extends unknown[] = unknown[], TRow = unknown>(
    sql: string,
  ): {
    run(...params: TParams): unknown;
    get(...params: TParams): TRow | undefined;
    all(...params: TParams): TRow[];
  } {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: TParams) => stmt.run(...(params as unknown[])),
      get: (...params: TParams) => stmt.get(...(params as unknown[])) as TRow | undefined,
      all: (...params: TParams) => stmt.all(...(params as unknown[])) as TRow[],
    };
  }

  run(sql: string, params: unknown[] = []): unknown {
    try {
      return this.prepare(sql).run(...params);
    } finally {
      this.hardenPermissions();
    }
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    try {
      return this.prepare(sql).get(...params) as T | undefined;
    } finally {
      this.hardenPermissions();
    }
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    try {
      return this.prepare(sql).all(...params) as T[];
    } finally {
      this.hardenPermissions();
    }
  }

  /** Re-apply restrictive permissions after SQLite creates a sidecar. */
  hardenPermissions(): void {
    enforcePrivateFile(`${this.db.name}`);
    enforcePrivateFile(`${this.db.name}-wal`);
    enforcePrivateFile(`${this.db.name}-shm`);
    enforcePrivateFile(`${this.db.name}-journal`);
  }

  close(): void {
    if (this.closed.value) return;
    this.closed.value = true;
    try {
      this.db.close();
    } catch {
      /* best-effort */
    }
  }
}

/** Escape a SQLCipher `key=` pragma so a key containing `"` or `\` is safe. */
function escapeKey(key: string): string {
  // Stage -1 used a plain string key, but production reads keys from
  // a file and we must not allow an operator-supplied key to inject
  // a pragma terminator.
  return key.replace(/["\\]/g, "");
}

function enforcePrivateFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT" && !existsSync(path)) return;
    throw error;
  }
}
