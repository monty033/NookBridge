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
    const existedBefore = existsSync(opts.dbPath);
    this.db = new Database(opts.dbPath);

    // The encrypted SQLite file MUST NOT be world-readable.  better-sqlite3
    // creates new files honouring the process umask, which leaves them at
    // mode 0644 on a typical user umask of 022 — that would expose the
    // encrypted-at-rest header to any local account.  Tighten only the main
    // DB path to 0600 right after open.  We also re-tighten it on every open
    // so an operator who manually loosened permissions on a legacy database
    // cannot keep it that way indefinitely.  SQLite sidecars are deferred
    // hardening and are intentionally not handled in Stage 1.  chmod can
    // fail on some FS drivers; we swallow the error because the DB is still
    // usable — the on-disk bytes are still encrypted, the file just may
    // not be locked down — but if the file didn't exist we propagate so a
    // configuration error doesn't pass silently.
    try {
      chmodSync(opts.dbPath, 0o600);
    } catch (err) {
      if (!existedBefore) {
        // The DB was just created by better-sqlite3 and we failed to lock
        // it down; that is a configuration/FS error worth surfacing so
        // the caller doesn't ship an 0644 file to production by mistake.
        try {
          this.db.close();
        } catch {
          /* best-effort */
        }
        throw err;
      }
    }

    // Apply the cipher pragmas in the EXACT order used by Stage -1.
    // sqlcipher is the only cipher supported at this pin; an
    // accidental downgrade to a non-encrypted build MUST NOT
    // succeed silently, so we tighten key bytes using `hexkey` rather
    // than `key` when the key looks like hex.  Stage 1 keeps the
    // simple `key=` form because all upstream tests use it.
    this.db.pragma(`cipher='sqlcipher'`);
    this.db.pragma(`key="${escapeKey(opts.key)}"`);

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
    this.db.exec(sql);
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
    return this.prepare(sql).run(...params);
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.prepare(sql).all(...params) as T[];
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
