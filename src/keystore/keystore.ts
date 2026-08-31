/**
 * NookBridge Stage 1 / Stage 5 — SecureKeyStore interface.
 *
 * Design constraints (Stage 1 plan):
 *
 *   - `SecureKeyStore` is an interface.  The Stage 1 deliverable is the
 *     interface plus an explicitly marked development-only backend that
 *     reads a key from a local file when configured to do so.
 *   - The interface is intentionally narrow: callers only need to
 *     obtain the database key string used to unlock the encrypted
 *     SQLite database.  Crypto primitives (hashing, key derivation,
 *     PGP) are upstream's responsibility once `@notesnook/core` lands.
 *
 * Stage 5 production safety contract:
 *
 *   `SecureKeyStore` is a discriminated union over `backend`.  Only the
 *   `systemd-credential` variant is allowed to carry the literal
 *   `productionSafe: true`.  The development-file and none variants
 *   are explicitly marked unsafe so a caller can never accidentally
 *   select a development backend for a production daemon.  The literal
 *   types are pinned at compile time — assigning `productionSafe: true`
 *   to a non-`systemd-credential` variant is a TypeScript error.
 *
 * What this stage is NOT doing:
 *
 *   - No system keychain integration beyond the systemd `LoadCredential=`
 *     delivery chosen by the Stage 5 service-boundary decision record.
 *   - No TPM / Secure Enclave (Stage 5+).
 *   - No production key rotation workflow (Stage 5+).
 */

export type KeyStoreBackendId = "development-file" | "systemd-credential" | "none";

export type SecureKeyStore =
  | {
      /**
       * The backend identifier.  Returns `"development-file"` for the
       * explicitly-marked dev backend, `"systemd-credential"` for the
       * production-safe systemd `LoadCredential=` backend,
       * `"none"` if no key is configured.
       */
      readonly backend: "development-file";
      /**
       * Whether this backend is safe for production.  Always the
       * literal `false` for the development-file variant — the
       * compiler rejects any other value.
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
    }
  | {
      /**
       * The systemd `LoadCredential=`-delivered production backend.
       * Identified by the literal `"systemd-credential"` discriminator.
       */
      readonly backend: "systemd-credential";
      /**
       * Whether this backend is safe for production.  Always the
       * literal `true` for this variant — the compiler rejects any
       * other value, so a development backend can never be marked
       * production-safe by mistake.
       */
      readonly productionSafe: true;
      /**
       * Returns the symmetric database key used to unlock the encrypted
       * SQLite state.  Returns `undefined` if no key is configured,
       * missing, empty, oversized, non-regular, or otherwise invalid.
       *
       * Implementations MUST NOT log the returned value, the credential
       * directory, or the credential name.  Callers must hand the key
       * directly into the SQLCipher `key=` pragma.
       */
      getDatabaseKey(): string | undefined;
    }
  | {
      /**
       * No backend selected.  Returned by callers that have not (yet)
       * configured a key store; the storage layer will refuse to start.
       */
      readonly backend: "none";
      /**
       * Whether this backend is safe for production.  Always the
       * literal `false` for this variant — the compiler rejects any
       * other value.
       */
      readonly productionSafe: false;
      /**
       * Returns the symmetric database key used to unlock the encrypted
       * SQLite state, or `undefined` if no key is configured.  Kept as
       * the same wide signature as the development-file variant so
       * test fixtures and external mocks can continue to inject a
       * synthetic key through this slot without subverting the
       * discriminated contract.
       */
      getDatabaseKey(): string | undefined;
    };
