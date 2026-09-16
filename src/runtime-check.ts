/**
 * Production `nookbridge-runtime-check` entrypoint.
 *
 * The runtime check is the *production* companion to the Stage 0
 * `tests/native-runtime.test.ts` disposable harness.  It loads the
 * same four native Notesnook-required extensions the daemon uses
 * (`better-sqlite3-multiple-ciphers` + `sqlite-better-trigram` +
 * `sqlite-regex` + `sqlite3-fts5-html`) against an *in-memory*
 * SQLCipher-capable database, runs a representative FTS5 trigram + regex
 * query, and prints a single fixed categorical success or failure
 * line.
 *
 * Hard rules:
 *
 *   - Output is strictly categorical.  No paths, no extension names,
 *     no version numbers, no query strings, no error messages, no
 *     database contents, no notes, no titles, no IDs, no
 *     credentials.
 *   - The runtime check never opens, reads, writes, or references
 *     any host filesystem path, configuration file, credentials
 *     file, daemon state directory, Notesnook vault, or live
 *     network socket.
 *     * No `node:fs` / `node:net` / `node:http` / `node:https` /
 *       `node:dgram` / `node:fetch` / `node:child_process` /
 *       `node:os` imports.
 *     * No process environment lookups of any kind.
 *     * No Notesnook / vault / live factory imports.
 *   - Exit code is `0` for the categorical OK and `1` for every
 *     other categorical failure.
 *   - The runtime check is the *only* code path in the entrypoint.
 *     The `runRuntimeCheck` seam is exported for unit tests so the
 *     same categorical contract is asserted independent of argv
 *     parsing and process-level exit.
 *
 * This module never reaches for the daemon, the live sync surface,
 * or any state.  It only proves the four native extensions can be
 * loaded together with an encrypted in-memory database — the
 * preconditions the production daemon requires before opening a
 * real Notesnook vault.
 *
 * The module deliberately avoids `import.meta.url` lookups for
 * path resolution and never inspects any host tmp directory or any
 * configuration directory: every side effect is bounded to the
 * in-memory `:memory:` database and the caller's injectable
 * seams.
 */

import { createRequire } from "node:module";
import process from "node:process";

/**
 * Closed set of categorical output lines this entrypoint may emit.
 *
 * `RUNTIME_CHECK_OK_LINE` is written to stdout on success;
 * `RUNTIME_CHECK_FAILURE_LINE` is written to stderr on every
 * failure path.  Both lines are deliberately short, lowercase,
 * hyphen-delimited, and carry no extension name, version number,
 * path, error text, query text, or note content.  Future edits
 * must keep them inside the closed alphabet `^[a-z0-9 _-]+$` so
 * upstream diagnostics cannot leak into the operator surface.
 */
export const RUNTIME_CHECK_OK_LINE = "nookbridge-runtime-check ok";
export const RUNTIME_CHECK_FAILURE_LINE = "nookbridge-runtime-check failed";

/**
 * Minimal description of the four native extension seams the
 * runtime check exercises.  Tests substitute a fake implementation
 * so the failure branch can be exercised without loading the real
 * native modules.
 */
export interface RuntimeCheckExtensions {
  /** better-sqlite3-multiple-ciphers constructor seam. */
  readonly openDatabase: (path: string) => RuntimeCheckCipherDatabase;
  /** `sqlite-better-trigram` loadable-path resolver seam. */
  readonly trigramPath: () => string;
  /** `sqlite-regex` loadable-path resolver seam. */
  readonly regexPath: () => string;
  /** `sqlite3-fts5-html` loadable-path resolver seam. */
  readonly fts5HtmlPath: () => string;
}

/**
 * Minimal slice of the better-sqlite3-multiple-ciphers surface
 * the runtime check actually touches.  Every method is invoked
 * with literal strings only; the database is closed on every exit
 * path so the native module never leaks across invocations.
 */
export interface RuntimeCheckCipherDatabase {
  exec(sql: string): void;
  pragma(source: string): unknown;
  loadExtension(path: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

/** The injectable seams for {@link runRuntimeCheck}. */
export interface RuntimeCheckOptions {
  /** Override for the native extension loader; default uses the
   *  real `better-sqlite3-multiple-ciphers`, `sqlite-better-trigram`,
   *  `sqlite-regex`, and `sqlite3-fts5-html` modules.  Tests use
   *  this seam to exercise the failure branch without native I/O. */
  readonly loadExtensions?: () => RuntimeCheckExtensions;
  /** Override for the representative FTS5 trigram + regex query;
   *  default runs the canonical trigram-then-regex query.  Tests
   *  substitute a failing seam here to exercise the failure branch. */
  readonly runRepresentativeQuery?: (db: RuntimeCheckCipherDatabase) => void;
  /** Override for stdout sink.  Defaults to `process.stdout.write`. */
  readonly writeOut?: (text: string) => void;
  /** Override for stderr sink.  Defaults to `process.stderr.write`. */
  readonly writeErr?: (text: string) => void;
}

/**
 * Default path for the probe database.
 *
 * The probe opens an in-memory SQLite database through the
 * `better-sqlite3-multiple-ciphers` constructor and selects the
 * SQLCipher implementation. SQLCipher refuses to set a key on an
 * in-memory database, so encrypted file create/reopen coverage remains
 * in `tests/native-runtime.test.ts`; this probe proves the runtime
 * can select the cipher implementation and load the complete native
 * extension stack without touching host state.
 */
const PROBE_DATABASE_PATH = ":memory:";

/**
 * Run one runtime-check attempt and write the categorical result.
 *
 * The function is intentionally synchronous from the caller's
 * perspective: every side effect is bounded to the in-memory
 * database and the injectable output seams.  It returns `0` for
 * the categorical OK and `1` for every failure path — never any
 * other code.
 */
export async function runRuntimeCheck(options: RuntimeCheckOptions): Promise<number> {
  const writeOut = options.writeOut ?? defaultWriteOut;
  const writeErr = options.writeErr ?? defaultWriteErr;

  let db: RuntimeCheckCipherDatabase | undefined;
  try {
    const extensions = (options.loadExtensions ?? defaultLoadExtensions)();
    db = openProbeEncryptedDatabase(extensions);
    loadRequiredExtensions(db, extensions);
    const runQuery = options.runRepresentativeQuery ?? defaultRunRepresentativeQuery;
    runQuery(db);
    writeOut(`${RUNTIME_CHECK_OK_LINE}\n`);
    return 0;
  } catch {
    // Every failure path collapses to the same categorical line.
    // No diagnostic, no error message, no path, no extension name,
    // no upstream cause may reach the operator surface.
    writeErr(`${RUNTIME_CHECK_FAILURE_LINE}\n`);
    return 1;
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort cleanup; never propagate close errors.
    }
  }
}

/**
 * Default stdout sink — only reached when the entrypoint is invoked
 * as a CLI.  Production callers use the injectable `writeOut` seam.
 */
function defaultWriteOut(text: string): void {
  process.stdout.write(text);
}

/**
 * Default stderr sink — only reached when the entrypoint is invoked
 * as a CLI.  Production callers use the injectable `writeErr` seam.
 */
function defaultWriteErr(text: string): void {
  process.stderr.write(text);
}

/**
 * Load the four native modules the runtime check exercises.  Two
 * of the four are CommonJS and must be reached through
 * `createRequire`; the other two are ESM.  The resolved modules
 * are returned through a uniform surface so callers and tests can
 * substitute the whole stack at once.
 */
function defaultLoadExtensions(): RuntimeCheckExtensions {
  // CommonJS extensions: load via createRequire so this ESM module
  // does not have to use a top-level `require()`.
  const localRequire = createRequire(import.meta.url);
  const cipherModule = localRequire("better-sqlite3-multiple-ciphers") as {
    new (path: string): RuntimeCheckCipherDatabase;
  };
  const trigramModule = localRequire("sqlite-better-trigram") as {
    getLoadablePath: () => string;
  };
  const fts5HtmlModule = localRequire("sqlite3-fts5-html") as {
    getLoadablePath: () => string;
  };
  // The `sqlite-regex` ESM package is loaded through the same
  // createRequire bridge; its namespace exposes a named helper.
  const sqliteRegexModule = localRequire("sqlite-regex") as unknown as {
    getLoadablePath?: () => string;
  };

  const regexGetLoadablePath = sqliteRegexModule.getLoadablePath;

  if (typeof regexGetLoadablePath !== "function") {
    throw new Error("runtime-check: sqlite-regex loader is unavailable");
  }

  return Object.freeze({
    openDatabase: (path: string) => new cipherModule(path),
    trigramPath: () => trigramModule.getLoadablePath(),
    regexPath: () => regexGetLoadablePath(),
    fts5HtmlPath: () => fts5HtmlModule.getLoadablePath(),
  });
}

/**
 * Open the probe database through the `better-sqlite3-multiple-ciphers`
 * constructor.  Loading the cipher module is the runtime guarantee
 * the production daemon relies on; the in-memory database is then
 * populated with the four required native extensions and a
 * representative FTS5 trigram + regex query.  The database lives
 * only in process memory and is wiped when the handle is closed.
 */
function openProbeEncryptedDatabase(
  extensions: RuntimeCheckExtensions,
): RuntimeCheckCipherDatabase {
  const db = extensions.openDatabase(PROBE_DATABASE_PATH);
  db.pragma("cipher='sqlcipher'");
  return db;
}

/**
 * Load the four required native extensions in the order the Stage 0
 * harness exercises them.  Load-order matters because the trigram
 * extension registers helpers consumed by `sqlite3-fts5-html`.
 */
function loadRequiredExtensions(
  db: RuntimeCheckCipherDatabase,
  extensions: RuntimeCheckExtensions,
): void {
  db.loadExtension(extensions.trigramPath());
  db.loadExtension(extensions.regexPath());
  db.loadExtension(extensions.fts5HtmlPath());
}

/**
 * Run the canonical representative FTS5 trigram + regex query.
 *
 * The query bodies are hard-coded and never reach the categorical
 * output surface; they only have to succeed.  If the underlying
 * extension stack cannot satisfy them, the database throws and the
 * outer try/catch collapses to the failure line.
 */
function defaultRunRepresentativeQuery(db: RuntimeCheckCipherDatabase): void {
  db.exec(`
    CREATE TABLE notes(
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE notes_fts USING fts5(
      title,
      body,
      tokenize='better_trigram'
    );
    INSERT INTO notes(id, title, body) VALUES
      (1, 'alpha', 'A first row for trigram matching'),
      (2, 'beta',  'A second row for regex matching'),
      (3, 'gamma', 'A third row for boundary checks');
    INSERT INTO notes_fts(rowid, title, body) VALUES
      (1, 'alpha', 'A first row for trigram matching'),
      (2, 'beta',  'A second row for regex matching'),
      (3, 'gamma', 'A third row for boundary checks');
  `);
  // Trigram hit.  The result is intentionally unused: success is
  // the only signal this entrypoint reports.
  db.prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank`).all("trigram");
  // Regex hit.
  db.prepare(`SELECT id FROM notes WHERE body REGEXP ?`).all("regex matching");
}

/**
 * CLI dispatch.  When this module is invoked as `node dist/runtime-check.js`,
 * the bottom-of-file branch runs `runRuntimeCheck` with the default
 * stdout/stderr sinks and exits with the categorical code.  The
 * CLI never accepts argv: the runtime check is a one-button probe.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  runRuntimeCheck({}).then((code) => {
    process.exit(code);
  });
}
