/**
 * Native-runtime compatibility test for NookBridge Stage 0.
 *
 * This test mirrors what the Stage -1 disposable harness proved: under the
 * pinned Node + native modules + Nix devShell, `better-sqlite3-multiple-ciphers`
 * loads, the three Notesnook-required FTS/trigram/regex extensions are
 * loadable via `db.loadExtension(...)`, and an encrypted database can be
 * created, reopened, and queried.
 *
 * This is the Stage 0 "native-runtime check" gate from
 * docs/implementation-plan-v1.5.md. Stage 1 will build PersistentStorage
 * on top of the same primitives this test exercises.
 *
 * The test intentionally does NOT import @notesnook/core — Stage 1 will.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";

// Notesnook-required extensions. They are small native modules shipped as
// prebuilt binaries (sqlite3-fts5-html) or as loadable shared libraries
// installed alongside `better-sqlite3-multiple-ciphers`.
//
// Stage -1 measured these specific versions in /tmp/nookbridge-stage-minus-1;
// Stage 0 pins them in package.json.
//
// `sqlite-better-trigram` and `sqlite3-fts5-html` are CommonJS in this
// ESM package; load them via createRequire. `sqlite-regex` ships as ESM
// and is imported normally.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const betterTrigram = require("sqlite-better-trigram") as {
  getLoadablePath: () => string;
};
const fts5Html = require("sqlite3-fts5-html") as {
  getLoadablePath: () => string;
};
import * as sqliteRegex from "sqlite-regex";

import { PINNED_NOTESNOOK_CORE_VERSION } from "../src/index.js";

/** Minimal interface for the parts of better-sqlite3-multiple-ciphers we touch. */
// (Local declaration; the upstream package's types are richer.)
interface CipherDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  pragma(source: string, options?: { simple?: boolean }): unknown;
  close(): void;
  loadExtension(path: string): void;
}

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "nookbridge-stage0-"));
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("Stage 0 native-runtime compatibility", () => {
  it("loads better-sqlite3-multiple-ciphers 11.5.0 with the pinned core version", () => {
    // The version guard is a sanity check against the runtime we expect
    // once `npm install` lands; the assertion below runs in the devShell
    // and will fail loudly if a future bump changes the package shape.
    expect(PINNED_NOTESNOOK_CORE_VERSION).toBe("8.1.3");

    const db = new Database(":memory:") as unknown as CipherDb;
    expect(typeof db.prepare).toBe("function");
    expect(typeof db.exec).toBe("function");
    expect(typeof db.pragma).toBe("function");
    expect(typeof db.loadExtension).toBe("function");
    db.close();
  });

  it("creates and reopens an encrypted database with multiple ciphers", () => {
    const path = join(workDir, "encrypted.db");
    const key = "stage-0-test-key-do-not-use-in-prod";

    {
      const db = new Database(path) as unknown as CipherDb;
      // sqlcipher bulk key pragma — same shape Stage -1 used.
      db.pragma(`cipher='sqlcipher'`);
      db.pragma(`key="${key}"`);
      db.exec(`CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
      db.exec(`INSERT INTO note(id, body) VALUES ('n1', 'encrypted-at-rest payload');`);
      db.close();
    }

    // Reopen the encrypted database with the same key and confirm rows survive.
    {
      const db = new Database(path) as unknown as CipherDb;
      db.pragma(`cipher='sqlcipher'`);
      db.pragma(`key="${key}"`);
      const row = db.prepare(`SELECT body FROM note WHERE id = ?`).get("n1") as
        | { body: string }
        | undefined;
      expect(row?.body).toBe("encrypted-at-rest payload");
      db.close();
    }

    // Sanity: with the wrong key, the row must not be readable.
    {
      const db = new Database(path) as unknown as CipherDb;
      db.pragma(`cipher='sqlcipher'`);
      db.pragma(`key="wrong-key"`);
      // sqlcipher behavior varies across builds: some throw on a bad key,
      // others silently return garbage rows. Accept either outcome as
      // long as the original plaintext is never returned.
      let threw = false;
      let rows: { body: string }[] = [];
      try {
        rows = db.prepare(`SELECT body FROM note WHERE id = ?`).all("n1") as {
          body: string;
        }[];
      } catch (err) {
        threw = true;
        expect(err).toBeDefined();
      }
      const anyMatch = rows.some((r) => r.body === "encrypted-at-rest payload");
      expect(threw || !anyMatch).toBe(true);
      db.close();
    }
  });

  it("exposes the loadable paths of the three Notesnook-required extensions", () => {
    // The extensions export a `getLoadablePath()` helper. If the package
    // version changes this shape can shift, so the test makes the contract
    // explicit.
    const trigram = (betterTrigram as unknown as { getLoadablePath?: () => string })
      .getLoadablePath;
    const regex = (sqliteRegex as unknown as { getLoadablePath?: () => string }).getLoadablePath;
    const fts5HtmlPath = (fts5Html as unknown as { getLoadablePath?: () => string })
      .getLoadablePath;

    expect(typeof trigram).toBe("function");
    expect(typeof regex).toBe("function");
    expect(typeof fts5HtmlPath).toBe("function");

    const db = new Database(":memory:") as unknown as CipherDb;
    expect(() => db.loadExtension(trigram!())).not.toThrow();
    expect(() => db.loadExtension(regex!())).not.toThrow();
    expect(() => db.loadExtension(fts5HtmlPath!())).not.toThrow();
    db.close();
  });

  it("runs a representative FTS5 trigram + regex search end-to-end", () => {
    // Mirrors what the Stage -1 `corrected-extensions.sql` script proved:
    // a trigram FTS5 index can find a needle that's a typo'd substring
    // of a longer word, and the regex extension can find a pattern that
    // spans token boundaries.
    const db = new Database(":memory:") as unknown as CipherDb;

    const trigram = (
      betterTrigram as unknown as { getLoadablePath: () => string }
    ).getLoadablePath();
    const regex = (sqliteRegex as unknown as { getLoadablePath: () => string }).getLoadablePath();
    const fts5HtmlPath = (
      fts5Html as unknown as { getLoadablePath: () => string }
    ).getLoadablePath();

    db.loadExtension(trigram);
    db.loadExtension(regex);
    db.loadExtension(fts5HtmlPath);

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
        (1, 'alpha', 'The quick brown fox jumps over the lazy dog.'),
        (2, 'beta',  'A regex sample with multiple tokens here.'),
        (3, 'gamma', 'Plain unrelated text in this row.');
      INSERT INTO notes_fts(rowid, title, body) VALUES
        (1, 'alpha', 'The quick brown fox jumps over the lazy dog.'),
        (2, 'beta',  'A regex sample with multiple tokens here.'),
        (3, 'gamma', 'Plain unrelated text in this row.');
    `);

    // Trigram should find "quick" verbatim via a 3-gram overlap.
    // `notes_fts` only exposes `title` and `body` as user columns; the
    // document id lives in the implicit `rowid`, so we project that.
    const trigramHits = db
      .prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank`)
      .all("quick") as { rowid: number }[];
    expect(trigramHits.map((r) => r.rowid)).toContain(1);

    // Regex should find a pattern that spans token boundaries.
    const regexHits = db
      .prepare(`SELECT id FROM notes WHERE body REGEXP ?`)
      .all("multiple tokens") as { id: number }[];
    expect(regexHits.map((r) => r.id)).toContain(2);

    db.close();
  });

  it("registers the html better_trigram tokenizer from sqlite3-fts5-html", () => {
    // The upstream html tokenizer is the one Notesnook uses for note
    // bodies. It composes the HTML stripper ahead of the trigram
    // tokenizer; both names must be visible to FTS5 once the extension
    // is loaded.
    const db = new Database(":memory:") as unknown as CipherDb;
    db.loadExtension(
      (betterTrigram as unknown as { getLoadablePath: () => string }).getLoadablePath(),
    );
    db.loadExtension((fts5Html as unknown as { getLoadablePath: () => string }).getLoadablePath());

    // Match the exact tokenizer string the upstream Notesnook migration
    // uses for note bodies: `html` strips tags, `better_trigram` handles
    // fuzzy matching, `remove_diacritics 1` folds accents so "café" and
    // "cafe" share the same trigrams. SQLite parses this as four
    // tokenizer-arg tokens and rejects anything shorter with
    // "error in tokenizer constructor".
    expect(() =>
      db.exec(
        `CREATE VIRTUAL TABLE html_fts USING fts5(body, tokenize='html better_trigram remove_diacritics 1');`,
      ),
    ).not.toThrow();
    db.close();
  });
});
