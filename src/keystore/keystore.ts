/**
 * NookBridge Stage 1 — SecureKeyStore interface.
 *
 * Design constraints (Stage 1 plan):
 *
 *   - `SecureKeyStore` is an interface.  The Stage 1 deliverable is the
 *     interface plus an explicitly marked development-only backend that
 *     reads a key from a local file when configured to do so.  No
 *     production backend ships in Stage 1.
 *   - The interface is intentionally narrow: callers only need to
 *     obtain the database key string used to unlock the encrypted
 *     SQLite database.  Crypto primitives (hashing, key derivation,
 *     PGP) are upstream's responsibility once `@notesnook/core` lands.
 *
 * What this stage is NOT doing:
 *
 *   - No system keychain integration (Stage 5).
 *   - No TPM / Secure Enclave (Stage 5+).
 *   - No production key rotation workflow (Stage 5+).
 */

export type KeyStoreBackendId = "development-file" | "none";

export type SecureKeyStore = {
  /**
   * The backend identifier.  Returns `"development-file"` for the
   * explicitly-marked dev backend, `"none"` if no key is configured.
   */
  readonly backend: KeyStoreBackendId;
  /**
   * Whether this backend is safe for production.  Always `false` for
   * Stage 1 backends — production backends arrive in Stage 5.
   */
  readonly productionSafe: false;
  /**
   * Returns the symmetric database key used to unlock the encrypted
   * SQLite state.  Returns `undefined` if no key is configured.
   *
   * Implementations MUST NOT log the returned value.  The NookBridge
   * logger never sees raw key material; the storage layer feeds the
   * key directly into the SQLCipher `key=` pragma.
   */
  getDatabaseKey(): string | undefined;
};
