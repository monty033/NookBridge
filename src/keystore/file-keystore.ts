/**
 * NookBridge Stage 1 — development-only file-backed SecureKeyStore.
 *
 * **This backend is for Stage 1 development and CI only.**  It is NOT
 * suitable for production — it stores the database key in a plaintext
 * file.  Production arrives in Stage 5.
 *
 * Safety properties:
 *
 *   - The key file is opened with restrictive permissions when the
 *     backend writes it (`mode: 0o600`), and it is only ever written
 *     by THIS backend (or, in tests, by fixture code).
 *   - The backend logs its identity at startup only (`backend =
 *     development-file`), never the key bytes.  The redaction set in
 *     the logger covers `key` as a JSON field name so an accidental
 *     `log({ key: ... })` is dropped even if a caller tried.
 *   - The backend is explicitly named `development-file` so an
 *     operator reading doctor output cannot mistake it for a
 *     production path.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";

import type { SecureKeyStore } from "./keystore.js";

export type DevelopmentFileKeyStoreOptions = {
  /** Absolute path to the key file. */
  keyPath: string;
  /**
   * Optional: if true and the file does not exist, generate a random
   * key and write it.  Defaults to `false` to keep test fixtures
   * deterministic.
   */
  generateIfMissing?: boolean;
};

/**
 * Construct a development-file SecureKeyStore backend.  The backend
 * reads the bytes verbatim and returns them as the database key; the
 * SQLite layer applies the `cipher='sqlcipher'; key=...` pragmas.
 *
 * The returned object's `backend`/`productionSafe` fields make the
 * development posture discoverable to doctor and other diagnostic
 * callers.
 */
export function createDevelopmentFileKeyStore(
  options: DevelopmentFileKeyStoreOptions,
): SecureKeyStore {
  const { keyPath, generateIfMissing = false } = options;

  // The key directory is part of the secret boundary too. mkdir's mode is
  // only applied on creation, so tighten existing directories as well and
  // fail closed if the filesystem cannot enforce the boundary.
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(keyPath), 0o700);

  if (!existsSync(keyPath)) {
    if (!generateIfMissing) {
      // No key, no fabrication.  The caller decides what to do.
      return {
        backend: "development-file",
        productionSafe: false,
        getDatabaseKey: () => undefined,
      };
    }
    // generateIfMissing is opt-in and explicitly development-only.  The
    // material is sourced from Node's CSPRNG, NOT from secrets
    // available to the agent.
    const generated = generateRandomKey();
    writeFileSync(keyPath, generated, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
  }

  // Even if the file exists, tighten permissions defensively in case
  // a previous bug or an operator set them loosely.
  chmodSync(keyPath, 0o600);

  // Read the file ONCE at construction time.  Stage 1 has no key
  // rotation; the dev backend does not hot-reload.
  let cached: string;
  try {
    cached = readFileSync(keyPath, "utf8").trim();
  } catch {
    cached = "";
  }

  return {
    backend: "development-file",
    productionSafe: false,
    getDatabaseKey: () => (cached && cached.length > 0 ? cached : undefined),
  };
}

function generateRandomKey(): string {
  // 48 random bytes => 64 base64 chars => enough entropy for
  // sqlcipher's PBKDF2 key derivation.
  return randomBytes(48).toString("base64");
}
