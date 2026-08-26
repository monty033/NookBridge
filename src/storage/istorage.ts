/**
 * NookBridge Stage 1 — local IStorage compatibility types.
 *
 * Why this file exists:
 *
 *   Stage 1 introduces `PersistentStorage` against an encrypted local
 *   backing store.  Upstream Notesnook declares the IStorage contract
 *   in `packages/core/src/interfaces.ts` of the pinned monorepo
 *   (`c9c4936d9e8222b86204781cd1c93cdf2a1738d3`, `@notesnook/core@8.1.3`).
 *   Stage 1 deliberately does NOT add `@notesnook/core` as a runtime
 *   dependency — adding it is Stage 2 work and would also pull in the
 *   encrypted sync transports that Stage 2 needs but Stage 1 doesn't.
 *
 *   To keep PersistentStorage structurally conformant with the
 *   eventual Stage 2 wiring, we re-declare the contract here with the
 *   SAME method names, signatures, and return shapes upstream uses.
 *   When Stage 2 adds `@notesnook/core`, `PersistentStorage` will keep
 *   satisfying this structural interface and `Database.setup(...)` will
 *   accept it through the adapter hook without further changes.
 *
 *   Keep these declarations byte-for-byte stable: a renumber here is a
 *   Stage-2 regression risk.
 *
 * Reference:
 *
 *   - Upstream IStorage: docs/upstream-contract.md §"What upstream
 *     contract NookBridge relies on".
 *   - @notesnook/crypto SerializedKey/Cipher: the type shapes below
 *     match the upstream definitions 1:1; crypto-math semantics are
 *     the upstream library's responsibility (Stage 2).
 */

// ---------------------------------------------------------------------------
// Crypto primitives — match @notesnook/crypto shapes.

export type StringOutputFormat = "base64" | "base58" | "base32" | "hex" | "text";
export type Uint8ArrayOutputFormat = "uint8array";
export type DataFormat = StringOutputFormat | Uint8ArrayOutputFormat;

/**
 * A cipher envelope persisted by IStorage.encrypt(...).  Matches the
 * upstream `Cipher<TFormat>` type from `@notesnook/crypto`.
 */
export type Cipher<TFormat extends DataFormat = DataFormat> = {
  /** Serialisation format of `cipher`.  NookBridge writes `"base64"`. */
  format: TFormat;
  /** Algorithm identifier; e.g. `"xchacha20-poly1305"`. */
  alg: string;
  /** The ciphertext itself, encoded in `format`. */
  cipher: string;
  /** Initialisation vector, base64. */
  iv: string;
  /** Salt, base64. */
  salt: string;
  /** Length of the plaintext in bytes before encryption. */
  length: number;
};

/**
 * A serialised symmetric key.  Matches upstream `SerializedKey`.
 * Stage 1's `generateCryptoKey`/`deriveCryptoKey` use the optional
 * `password`/`salt` fields; Stage 2 will switch to materialised key
 * data.
 */
export type SerializedKey = {
  password?: string;
  key?: string;
  salt?: string;
};

/**
 * A serialised PGP key pair.  Matches upstream `SerializedKeyPair`.
 */
export type SerializedKeyPair = {
  publicKey: string;
  privateKey: string;
};

// ---------------------------------------------------------------------------
// IStorage — re-declared from upstream, with local-only documentation.

/**
 * Structural copy of upstream `@notesnook/core` IStorage.
 *
 * Every method name, parameter order, parameter nullability, and return
 * shape MUST match upstream so that `PersistentStorage` can be plugged
 * into `Database.setup({ storage: ... })` with no adapter shim in
 * Stage 2.
 *
 * Stage 1 implements this interface using an encrypted SQLite backing
 * store.  See `src/storage/persistent-storage.ts`.
 */
export interface IStorage {
  write<T>(key: string, data: T): Promise<void>;
  writeMulti<T>(entries: [string, T][]): Promise<void>;
  readMulti<T>(keys: string[]): Promise<[string, T][]>;
  read<T>(key: string, isArray?: boolean): Promise<T | undefined>;
  remove(key: string): Promise<void>;
  removeMulti(keys: string[]): Promise<void>;
  clear(): Promise<void>;
  getAllKeys(): Promise<string[]>;
  encrypt(key: SerializedKey, plainText: string): Promise<Cipher<"base64">>;
  encryptMulti(key: SerializedKey, items: string[]): Promise<Cipher<"base64">[]>;
  decrypt(key: SerializedKey, cipherData: Cipher<"base64">): Promise<string>;
  decryptMulti(key: SerializedKey, items: Cipher<"base64">[]): Promise<string[]>;
  deriveCryptoKey(credentials: SerializedKey): Promise<void>;
  hash(password: string, email: string, options?: { usesFallback?: boolean }): Promise<string>;
  getCryptoKey(): Promise<string | undefined>;
  generateCryptoKey(password: string, salt?: string): Promise<SerializedKey>;
  generatePGPKeyPair(): Promise<SerializedKeyPair>;
  decryptPGPMessage(privateKeyArmored: string, encryptedMessage: string): Promise<string>;
  validatePGPKeyPair(keys: SerializedKeyPair): Promise<{
    isValid: boolean;
    message: string;
  }>;
  generateCryptoKeyFallback(password: string, salt?: string): Promise<SerializedKey>;
  deriveCryptoKeyFallback(credentials: SerializedKey): Promise<void>;
}
