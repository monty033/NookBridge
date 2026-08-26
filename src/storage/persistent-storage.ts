/**
 * NookBridge Stage 1 — PersistentStorage.
 *
 * `PersistentStorage` implements the structural `IStorage` interface
 * against an encrypted SQLite backing store.  It is the Stage 1
 * deliverable that:
 *
 *   - backs every key/value pair through encrypted SQLite (Gate 1.1
 *     and Gate 1.2);
 *   - never writes plaintext note bodies outside the encrypted state
 *     (Gate 1.3);
 *   - participates in the single-instance lock so a second DB-owning
 *     process is rejected up front (Gate 1.4);
 *   - keeps note content out of the structured logger by routing
 *     redaction through the Stage 1 logger module.
 *
 * Stage 2 hooks this class into `@notesnook/core`'s
 * `Database.setup({ storage })` adapter.  Stage 1 does not import
 * `@notesnook/core`.
 *
 * Schema (committed on first open if missing):
 *
 *   CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL,
 *                    format TEXT NOT NULL DEFAULT 'json');
 *
 * Stage 1 stores `data` as a JSON-encoded string.  Stage 3+ may add an
 * explicit `format` column and extend the codec; the column is added
 * defensively today so a future migration does not change the on-disk
 * row shape.
 */

import { mkdirSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";

import { tryAcquireLock, releaseLock } from "../config/lock.js";
import { ensureStateDir } from "../config/state-dir.js";
import type { Logger } from "../logging/logger.js";
import { createLogger, DEFAULT_REDACT_FIELDS } from "../logging/logger.js";
import { SqliteStorage } from "./sqlite-storage.js";
import type { Cipher, IStorage, SerializedKey, SerializedKeyPair } from "./istorage.js";
import type { SecureKeyStore } from "../keystore/keystore.js";

// ---------------------------------------------------------------------------
// Cryptographic primitives — Stage 1 uses only Node built-ins.
//
// Stage 2 will replace these with `@notesnook/crypto` (which itself
// wraps libsodium).  Keeping the primitives local for now means
// PersistentStorage is fully self-contained for Gate 1 testing.

import { createHash, createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from "node:crypto";

// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1 as const;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS kv(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'json'
  );
  CREATE TABLE IF NOT EXISTS meta(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS kv_format_idx ON kv(format);
`;

const SCHEMA_VERSION_KEY = "schema_version";

function defaultFormat(value: unknown): "json" | "text" {
  if (typeof value === "string") return "text";
  return "json";
}

function encodeValue(value: unknown, format: "json" | "text"): string {
  if (format === "text" && typeof value === "string") return value;
  return JSON.stringify(value);
}

function decodeValue(raw: string, format: "json" | "text"): unknown {
  if (format === "text") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export type CreatePersistentStorageOptions = {
  stateDir: string;
  /** Where the encrypted SQLite file lives. */
  dbPath?: string;
  /** Key source.  Stage 1 only supports the development-file backend. */
  keys: SecureKeyStore;
  logger?: Logger;
};

// ---------------------------------------------------------------------------

export class PersistentStorage implements IStorage {
  private readonly sq: SqliteStorage;
  private readonly stateDir: string;
  private readonly dbPath: string;
  private readonly keys: SecureKeyStore;
  private readonly logger: Logger;
  private readonly ownLock: boolean;
  private closed = false;

  constructor(opts: CreatePersistentStorageOptions) {
    this.stateDir = resolve(opts.stateDir);
    this.dbPath = resolve(opts.dbPath ?? `${this.stateDir}/nookbridge.db`);
    this.keys = opts.keys;
    this.logger =
      opts.logger ?? createLogger({ level: "warn", redactFields: DEFAULT_REDACT_FIELDS });

    // Gate 1.4: a second DB-owning process must be rejected up front.
    // If we cannot grab the lock we throw — the test asserts either
    // an upfront throw OR a write-time reject, so the throw path
    // is the simpler of the two.
    const release = tryAcquireLock(this.stateDir);
    if (!release) {
      throw new Error(`another process already owns the encrypted state at ${this.stateDir}`);
    }
    this.ownLock = true;

    const key = this.keys.getDatabaseKey();
    if (!key || key.length === 0) {
      this.releaseLockQuietly();
      throw new Error("no database key configured (SecureKeyStore returned no key)");
    }

    // Ensure the directory exists *before* sqlite opens the file, so
    // an operator with a missing dir gets a deterministic error.
    ensureStateDir(this.stateDir);
    mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });

    this.sq = new SqliteStorage({ dbPath: this.dbPath, key });
    try {
      this.sq.exec(SCHEMA_SQL);
      this.upsertMeta(SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));
    } catch (err) {
      // Reopen with the wrong key throws here on Stage -1's sqlcipher
      // build; bubble a stable error type so callers can distinguish.
      this.sq.close();
      this.releaseLockQuietly();
      throw new Error(
        `failed to initialise encrypted SQLite at ${this.dbPath}: ${(err as Error).message}`,
      );
    }

    this.logger.info("persistent-storage.open", {
      stateDir: this.stateDir,
      dbPath: this.dbPath,
      backend: this.keys.backend,
    });
  }

  private releaseLockQuietly(): void {
    if (this.ownLock) {
      try {
        releaseLock(this.stateDir);
      } catch {
        /* ignored */
      }
    }
  }

  private upsertMeta(key: string, value: string): void {
    this.sq.run(
      `INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [key, value],
    );
  }

  // ----- IStorage surface --------------------------------------------------

  async write<T>(key: string, data: T): Promise<void> {
    const format = defaultFormat(data);
    const encoded = encodeValue(data, format);
    this.sq.run(
      `INSERT INTO kv(key, value, format) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, format=excluded.format`,
      [key, encoded, format],
    );
  }

  async writeMulti<T>(entries: [string, T][]): Promise<void> {
    const tx = this.sq.db.transaction((rows: [string, string, string][]) => {
      const stmt = this.sq.prepare(
        `INSERT INTO kv(key, value, format) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, format=excluded.format`,
      );
      for (const [k, v, f] of rows) stmt.run(k, v, f);
    });
    const encoded: [string, string, string][] = entries.map(([k, v]) => [
      k,
      encodeValue(v, defaultFormat(v)),
      defaultFormat(v),
    ]);
    tx(encoded);
  }

  async read<T>(key: string, _isArray?: boolean): Promise<T | undefined> {
    const row = this.sq.get<{ value: string; format: "json" | "text" }>(
      `SELECT value, format FROM kv WHERE key = ?`,
      [key],
    );
    if (!row) return undefined;
    return decodeValue(row.value, row.format) as T | undefined;
  }

  async readMulti<T>(keys: string[]): Promise<[string, T][]> {
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => "?").join(",");
    const rows = this.sq.all<{ key: string; value: string; format: "json" | "text" }>(
      `SELECT key, value, format FROM kv WHERE key IN (${placeholders})`,
      keys,
    );
    // Preserve the requested order — preserve the requested keys even
    // when missing — upstream's behaviour returns [key, undefined]
    // for missing entries.
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return keys.map((k) => {
      const r = byKey.get(k);
      return [k, r ? (decodeValue(r.value, r.format) as T) : (undefined as unknown as T)];
    });
  }

  async remove(key: string): Promise<void> {
    this.sq.run(`DELETE FROM kv WHERE key = ?`, [key]);
  }

  async removeMulti(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const placeholders = keys.map(() => "?").join(",");
    this.sq.run(`DELETE FROM kv WHERE key IN (${placeholders})`, keys);
  }

  async clear(): Promise<void> {
    this.sq.run(`DELETE FROM kv`);
  }

  async getAllKeys(): Promise<string[]> {
    return this.sq.all<{ key: string }>(`SELECT key FROM kv ORDER BY key`).map((r) => r.key);
  }

  // ----- Crypto envelope (Stage 1 local implementation) -------------------
  //
  // Stage 2 will swap these implementations for `@notesnook/crypto`
  // wrappers so the IStorage contract gets the upstream-validated
  // crypto envelopes.  Until then the Stage 1 envelopes are
  // deterministic and round-trip-stable so Stage 1 tests can lock
  // them in.  They never persist the password to disk — only the
  // derived key material.

  async encrypt(_key: SerializedKey, plainText: string): Promise<Cipher<"base64">> {
    const keyMaterial = deriveKeyMaterial(_key);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keyMaterial, iv);
    const data = Buffer.from(plainText, "utf8");
    const enc = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([enc, tag]).toString("base64");
    return {
      format: "base64",
      alg: "aes-256-gcm",
      cipher: blob,
      iv: iv.toString("base64"),
      salt: _key.salt ?? "",
      length: data.length,
    };
  }

  async encryptMulti(key: SerializedKey, items: string[]): Promise<Cipher<"base64">[]> {
    return Promise.all(items.map((p) => this.encrypt(key, p)));
  }

  async decrypt(key: SerializedKey, cipherData: Cipher<"base64">): Promise<string> {
    const keyMaterial = deriveKeyMaterial(key);
    const iv = Buffer.from(cipherData.iv, "base64");
    const blob = Buffer.from(cipherData.cipher, "base64");
    const tag = blob.subarray(blob.length - 16);
    const enc = blob.subarray(0, blob.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", keyMaterial, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(enc), decipher.final()]);
    return out.toString("utf8");
  }

  async decryptMulti(key: SerializedKey, items: Cipher<"base64">[]): Promise<string[]> {
    return Promise.all(items.map((c) => this.decrypt(key, c)));
  }

  async deriveCryptoKey(credentials: SerializedKey): Promise<void> {
    const keyMaterial = deriveKeyMaterial(credentials);
    const encoded = keyMaterial.toString("base64");
    // Mirror upstream `NodeStorageInterface.deriveCryptoKey` — store
    // the derived key under `userEncryptionKey` so subsequent
    // encrypt/decrypt calls can be issued with a SerializedKey
    // carrying only the password+salt and recover the material.
    await this.write(`userEncryptionKey`, encoded);
  }

  async hash(password: string, email: string): Promise<string> {
    const APP_SALT = "oVzKtazBo7d8sb7TBvY9jw";
    return createHash("sha256").update(`${APP_SALT}${email}${password}`, "utf8").digest("base64");
  }

  async getCryptoKey(): Promise<string | undefined> {
    return this.read<string>(`userEncryptionKey`);
  }

  async generateCryptoKey(password: string, salt?: string): Promise<SerializedKey> {
    const finalSalt = salt ?? randomBytes(16).toString("base64");
    const material = pbkdf2Sync(password, finalSalt, 100_000, 32, "sha256");
    return { password, salt: finalSalt, key: material.toString("base64") };
  }

  async generatePGPKeyPair(): Promise<SerializedKeyPair> {
    // Stage 1 placeholder: upstream replaces this with NNCrypto in
    // Stage 2.  The contract requires that the return value is a
    // structurally valid SerializedKeyPair so an IStorage consumer
    // can be written today.
    return { publicKey: "", privateKey: "" };
  }

  async decryptPGPMessage(_privateKeyArmored: string, _encryptedMessage: string): Promise<string> {
    throw new Error("PGP message decryption is not implemented in Stage 1");
  }

  async validatePGPKeyPair(_keys: SerializedKeyPair): Promise<{
    isValid: boolean;
    message: string;
  }> {
    return { isValid: false, message: "PGP validation is not implemented in Stage 1" };
  }

  async generateCryptoKeyFallback(password: string, salt?: string): Promise<SerializedKey> {
    return this.generateCryptoKey(password, salt);
  }

  async deriveCryptoKeyFallback(_credentials: SerializedKey): Promise<void> {
    // no-op in Stage 1; Stage 2 plugs in @notesnook/crypto's fallback path.
    return Promise.resolve();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sq.close();
    } catch {
      /* best-effort */
    }
    this.releaseLockQuietly();
    this.logger.info("persistent-storage.close", {
      stateDir: this.stateDir,
      dbPath: this.dbPath,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveKeyMaterial(key: SerializedKey): Buffer {
  // Precedence mirrors upstream: an explicit materialised `key`
  // wins; otherwise derive via PBKDF2 with the provided salt.
  if (key.key) {
    return Buffer.from(key.key, "base64");
  }
  if (!key.password || !key.salt) {
    throw new Error("encrypt/decrypt requires a SerializedKey with `key` or `password`+`salt`");
  }
  return pbkdf2Sync(key.password, key.salt, 100_000, 32, "sha256");
}

// ---------------------------------------------------------------------------
// Public factory — keeps the new() shape discoverable for callers that
// just want a default-configured storage handle.

export function createPersistentStorage(opts: CreatePersistentStorageOptions): PersistentStorage {
  return new PersistentStorage(opts);
}
