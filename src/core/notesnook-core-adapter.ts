/**
 * Narrow, injected seam for the pinned Notesnook core.
 *
 * Stage 2A introduced the seam with only `Database.setup({ storage }).init()`
 * in view — an injected `NotesnookCoreModule` or factory plus the Stage 1
 * `IStorage` was sufficient to drive the offline adapter test.
 *
 * Stage 2 widens the seam to model the verified real-upstream setup
 * options surface documented in `docs/upstream-contract.md` and
 * `@notesnook/core@8.1.3`.  The widened shape is now:
 *
 *   - `sqliteOptions`   — required, structurally validated (see
 *                         `validateSQLiteOptions`).
 *   - `storage`         — required `IStorage`.
 *   - `fs`              — required `IFileStorage` (the adapter only
 *                         enforces the structural surface the real
 *                         upstream module reads; an injected fake core
 *                         may accept a stub).
 *   - `compressor`      — required `ICompressor`.
 *   - `batchSize`       — required, finite positive integer.
 *   - `eventsource`     — optional EventSource constructor.
 *
 * The Stage 2A test fixture continues to inject a fake module whose
 * `setup` only inspects `{ storage }`.  To preserve that test without
 * rewriting it, the seam accepts the Stage 2A `NotesnookCoreModule`
 * shape (single required key `storage`) unchanged, AND adds a new
 * `NotesnookRealCoreModule` shape that requires the full upstream
 * option surface.  Callers that wire the pinned `@notesnook/core` use
 * the real shape; offline tests keep using the Stage 2A shape.
 *
 * Runtime importing of `@notesnook/core` is owned by
 * `src/core/notesnook-live-factory.ts` and is gated behind an explicit
 * factory call; the adapter itself never imports it.
 */

import type { IStorage } from "../storage/istorage.js";

// ---------------------------------------------------------------------------
// SQLite dialect — the narrowed shape upstream's `setup({ sqliteOptions })`
// actually consumes.  Drawn from `@notesnook/core@8.1.3`
// `packages/core/src/api/sqliteoptions.ts` (Dialect from kysely).
// ---------------------------------------------------------------------------

/**
 * The minimal dialect surface the upstream SQLite options pass to
 * kysely.  Declared structurally so the adapter does not pull kysely
 * types into its own surface.
 */
export interface NotesnookSQLiteDialect {
  createAdapter(): unknown;
  createDriver(): unknown;
  createIntrospector(database: unknown): unknown;
  createQueryCompiler(): unknown;
}

/**
 * The pinned SQLite options shape consumed by `Database.setup({ sqliteOptions })`.
 *
 * Only the fields upstream reads at `setup`-time are validated; the
 * adapter is conservative and does NOT introduce a generic
 * passthrough for arbitrary unknown keys.
 */
export type NotesnookSQLiteOptions = Readonly<{
  /** Required dialect function. */
  dialect: (name: string, init?: () => Promise<void>) => NotesnookSQLiteDialect;
  /** Optional journal mode. */
  journalMode?: "WAL" | "MEMORY" | "OFF" | "PERSIST" | "TRUNCATE" | "DELETE";
  /** Optional synchronous mode. */
  synchronous?: "normal" | "extra" | "full" | "off";
  /** Optional locking mode. */
  lockingMode?: "normal" | "exclusive";
  /** Optional temp-store mode. */
  tempStore?: "memory" | "file" | "default";
  /** Optional cache size in pages (non-negative integer). */
  cacheSize?: number;
  /** Optional page size in bytes (non-negative integer). */
  pageSize?: number;
  /** Optional sqlcipher passphrase. */
  password?: string;
  /** Optional skip flag. */
  skipInitialization?: boolean;
}>;

// ---------------------------------------------------------------------------
// IFileStorage — the narrowed structural shape `@notesnook/core@8.1.3`
// expects.  Persistent file storage is deferred to a later slice;
// the adapter enforces the closed shape but does NOT implement it.
// ---------------------------------------------------------------------------

export interface NotesnookRequestOptions {
  url: string;
  chunkSize: number;
  headers: { Authorization: string };
}

export interface NotesnookFileEncryptionMetadata {
  chunkSize: number;
  iv: string;
  size: number;
  salt: string;
  alg: string;
}

export interface NotesnookFileEncryptionMetadataWithHash extends NotesnookFileEncryptionMetadata {
  hash: string;
  hashType: string;
}

export interface NotesnookCancellable<T> {
  execute(): Promise<T>;
  cancel(reason?: string): Promise<void>;
}

export interface NotesnookIFileStorage {
  downloadFile(
    filename: string,
    requestOptions: NotesnookRequestOptions,
  ): NotesnookCancellable<boolean>;
  uploadFile(
    filename: string,
    requestOptions: NotesnookRequestOptions,
  ): NotesnookCancellable<boolean>;
  readEncrypted<
    TOutputFormat extends "base64" | "base58" | "base32" | "hex" | "text" | "uint8array",
  >(
    filename: string,
    encryptionKey: { password?: string; key?: string; salt?: string },
    cipherData: NotesnookFileEncryptionMetadataWithHash & { outputType: TOutputFormat },
  ): Promise<string | Uint8Array | undefined>;
  writeEncryptedBase64(
    data: string,
    encryptionKey: { password?: string; key?: string; salt?: string },
    mimeType: string,
  ): Promise<NotesnookFileEncryptionMetadataWithHash>;
  deleteFile(filename: string, requestOptions?: NotesnookRequestOptions): Promise<boolean>;
  exists(filename: string): Promise<boolean>;
  bulkExists(filenames: string[]): Promise<string[]>;
  getUploadedFileSize(filename: string): Promise<number>;
  clearFileStorage(): Promise<void>;
  hashBase64(data: string): Promise<{ hash: string; type: string }>;
}

// ---------------------------------------------------------------------------
// ICompressor — narrowed structural shape upstream's `setup({ compressor })`
// expects.
// ---------------------------------------------------------------------------

export interface NotesnookICompressor {
  compress(data: string): Promise<string>;
  decompress(data: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// EventSource — the narrowed constructor type.  Real modules accept any
// EventSource-shaped constructor; the adapter only enforces that the
// value, if provided, is callable with `new`.
// ---------------------------------------------------------------------------

export interface NotesnookEventSourceInit {
  withCredentials?: boolean;
}

export interface NotesnookEventSourceLike {
  close(): void;
}

export type NotesnookEventSourceConstructor = new (
  uri: string,
  init: NotesnookEventSourceInit & { headers?: Record<string, string> },
) => NotesnookEventSourceLike;

// ---------------------------------------------------------------------------
// Database setup options — the closed shape `Database.setup({ ... })`
// accepts in `@notesnook/core@8.1.3`.
// ---------------------------------------------------------------------------

/**
 * The verified real-upstream `Database.setup({...})` options shape.
 *
 * Required keys: `sqliteOptions`, `storage`, `fs`, `compressor`, `batchSize`.
 * Optional key:  `eventsource`.
 *
 * The adapter does NOT widen this shape further.  Adding unknown keys
 * is rejected during validation; callers that need richer behavior
 * must drive setup directly through the real module.
 */
export type NotesnookDatabaseSetupOptions = Readonly<{
  sqliteOptions: NotesnookSQLiteOptions;
  storage: IStorage;
  fs: NotesnookIFileStorage;
  compressor: NotesnookICompressor;
  batchSize: number;
  eventsource?: NotesnookEventSourceConstructor;
}>;

// ---------------------------------------------------------------------------
// Module shapes.
// ---------------------------------------------------------------------------

/**
 * The minimal `Database` surface the adapter requires.  Stays
 * closed over the same `init()`-typed handle the Stage 2A fake core
 * exposed; the live-factory layer asserts the wider real-upstream
 * shape separately.
 */
export interface NotesnookDatabase {
  init(): void | PromiseLike<void>;
}

/**
 * The verified real-upstream `Database` instance surface from
 * `@notesnook/core@8.1.3` `dist/index.d.ts`:
 *
 *   - `setup(options)`   — INSTANCE method; populates `options`,
 *                          `kv`, `tokenManager`, etc.  Synchronous.
 *   - `init()`           — INSTANCE method; resolves once the
 *                          database is ready to serve.
 *   - `user`             — pre-built `UserManager`.
 *   - `tokenManager`     — pre-built `TokenManager`.
 *   - `kv`               — CALLABLE accessor (`KVStorageAccessor`).
 *                          Calling it returns a fresh `KVStorage`
 *                          snapshot; it is NOT a plain object.
 *
 * The `kv` field is intentionally typed as a callable: the real
 * upstream `KVStorageAccessor` is `() => KVStorage`, not
 * `KVStorage`.  This keeps the interface aligned with the pinned
 * d.ts and means callers reading `db.kv` only see a function they
 * can invoke to get the live storage object.
 */
export interface NotesnookLiveDatabase {
  setup(options: NotesnookDatabaseSetupOptions): void;
  init(): Promise<void>;
  user: unknown;
  tokenManager: unknown;
  /** Callable accessor: `db.kv()` returns the live `KVStorage`. */
  kv: () => unknown;
}

/**
 * The verified real-upstream module shape.  Mirrors the pinned
 * `@notesnook/core@8.1.3` `dist/index.d.ts` declaration:
 *
 *   `declare class Database { ... setup(...): void; init(): Promise<void>; ... }`
 *
 * `Database` is CONSTRUCTABLE.  Production code does
 * `new coreModule.Database()`, then calls `.setup(full options)`,
 * then `.init()`.  The Stage 2A fake core keeps its static
 * `Database.setup({ storage })` shape unchanged — that fake core
 * is a self-contained seam and is not part of the real-upstream
 * contract.
 *
 * The factory wraps a real package value with this shape so the
 * adapter / factory can drive the full pinned real-upstream path.
 * It is a separate nominal type from {@link NotesnookCoreModule};
 * the two accept different `Database` shapes and conflating them
 * would silently lose type safety.
 */
export interface NotesnookRealCoreModule {
  Database: new () => NotesnookLiveDatabase;
}

/**
 * The Stage 2A injected-fake module shape.  Defined here exactly as
 * the Stage 2A seam declared it: a `Database.setup` that consumes
 * only `{ storage }`.  Stage 2A's existing tests continue to import
 * and construct this shape without modification.
 */
export interface NotesnookCoreModule {
  Database: {
    setup(options: { storage: IStorage }): NotesnookDatabase;
  };
}

/**
 * A factory returning the Stage 2A injected-fake module shape.
 */
export type NotesnookCoreFactory = () => NotesnookCoreModule;

/**
 * A factory returning the verified real-upstream module shape.
 */
export type NotesnookRealCoreFactory = () => NotesnookRealCoreModule;

export type NotesnookCoreSource =
  | NotesnookCoreModule
  | NotesnookRealCoreModule
  | NotesnookCoreFactory
  | NotesnookRealCoreFactory;

export type NotesnookCoreAdapterOptions = Readonly<{
  core: NotesnookCoreSource;
  storage: IStorage;
}>;

export class NotesnookCoreAdapter {
  private readonly core: NotesnookCoreModule | NotesnookRealCoreModule;
  private readonly storage: IStorage;

  constructor(options: NotesnookCoreAdapterOptions) {
    this.core = resolveCore(options.core);
    this.storage = options.storage;
  }

  /**
   * Initialize the injected core database.  When the injected core is
   * the Stage 2A fake shape, only `storage` is forwarded and the
   * fake `Database.setup({ storage }).init()` path is taken.
   * When it is the real-upstream shape, the factory wraps a
   * CONSTRUCTABLE `Database` class with INSTANCE `setup` /
   * INSTANCE `init`; we run the full pinned
   * `@notesnook/core@8.1.3` path:
   *
   *   1. construct: `new this.core.Database()`
   *   2. instance setup: `database.setup(full options)` (sync)
   *   3. instance init:  `await database.init()`
   *
   * The adapter itself makes no network call.  Side effects are owned
   * by the injected module.
   */
  async init(): Promise<void> {
    if (isRealCoreModule(this.core)) {
      const options = buildFullSetupOptions(this.storage);
      let db: unknown;
      try {
        const Ctor = this.core.Database as unknown as new () => unknown;
        db = new Ctor();
      } catch {
        throw adapterError("invalid real Notesnook database: Database constructor failed");
      }
      if (!db || typeof db !== "object") {
        throw adapterError(
          "invalid real Notesnook database: Database constructor must return an object",
        );
      }
      const setupFn = (db as { setup?: unknown }).setup;
      if (typeof setupFn !== "function") {
        throw adapterError("invalid real Notesnook database: Database instance is missing setup()");
      }
      try {
        (setupFn as (options: NotesnookDatabaseSetupOptions) => void).call(db, options);
      } catch {
        throw adapterError(
          "invalid real Notesnook database: Database.setup rejected the supplied options",
        );
      }
      const initFn = (db as { init?: unknown }).init;
      if (typeof initFn !== "function") {
        throw adapterError("invalid real Notesnook database: Database instance is missing init()");
      }
      const awaited = (initFn as () => void | PromiseLike<void>).call(db);
      if (awaited && typeof (awaited as { then?: unknown }).then === "function") {
        try {
          await awaited;
        } catch {
          throw adapterError("invalid real Notesnook database: Database.init failed");
        }
      }
      return;
    }

    // Stage 2A fake path: only `storage` is required and only `storage`
    // is forwarded.  TypeScript cannot narrow the discriminator through
    // the `else` branch when the truthy branch's narrowing type lacks
    // shape compatibility with the inferred value, so we re-assert
    // the structural path here.
    const fake: NotesnookCoreModule = this.core as NotesnookCoreModule;
    const database: unknown = fake.Database.setup({ storage: this.storage });
    if (!isNotesnookDatabase(database)) {
      throw adapterError(
        "invalid injected Notesnook database: Database.setup must return an object with init()",
      );
    }
    await database.init();
  }

  /**
   * Expose the closed full real-upstream setup options surface.
   * Production wiring uses `notesnook-live-factory.ts` for that;
   * this method exists for tests that need to assert the closed
   * shape without invoking `init()` against the live module.
   */
  describeFullSetupOptions(): NotesnookDatabaseSetupOptions {
    return buildFullSetupOptions(this.storage);
  }
}

export function createNotesnookCoreAdapter(
  options: NotesnookCoreAdapterOptions,
): NotesnookCoreAdapter {
  return new NotesnookCoreAdapter(options);
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

/**
 * Structural discriminator between the Stage 2A fake module and the
 * pinned real-upstream module.  Stage 2A's `Database` is a plain
 * object with a `setup({ storage })` static method; the real
 * upstream's `Database` is a CONSTRUCTABLE class.  Both are
 * structurally callish so we use a non-forgeable identity marker
 * that the live factory applies at construction time.  Stage 2A
 * tests inject the fake directly without a marker and are routed
 * through the fake branch; live values produced by the factory are
 * routed through the real branch.
 *
 * The marker is held in a module-private `WeakSet<object>` keyed on
 * object identity.  This deliberately does NOT mutate the supplied
 * module object: dynamic `import("@notesnook/core")` returns an
 * ECMAScript module namespace, which is non-extensible, and any
 * attempt to attach a symbol-keyed property to it via
 * `Object.defineProperty` throws `TypeError: Cannot define
 * property ..., object is not extensible`.  Holding the marker in
 * private state instead keeps the discriminator working on the real
 * ESM namespace while remaining non-forgeable from outside (no
 * observable property to set, no enumerable marker to forge).
 */
const markedRealCoreModules = new WeakSet<object>();

export function markRealCoreModule(module: NotesnookRealCoreModule): NotesnookRealCoreModule {
  // `WeakSet#add` accepts any object reference and never mutates
  // the target.  Idempotent: re-marking the same module is a no-op,
  // which keeps the live factory's wrap-with-marker step safe
  // against repeated construction paths.
  markedRealCoreModules.add(module);
  return module;
}

function isRealCoreModule(
  core: NotesnookCoreModule | NotesnookRealCoreModule,
): core is NotesnookRealCoreModule {
  return markedRealCoreModules.has(core);
}

function resolveCore(source: NotesnookCoreSource): NotesnookCoreModule | NotesnookRealCoreModule {
  const resolved = typeof source === "function" ? (source as () => unknown)() : source;
  if (!isResolvedCore(resolved)) {
    throw adapterError(
      "invalid injected Notesnook core: Database is required (either a constructable class with instance setup/init, or a { Database: { setup } } stage 2A fake)",
    );
  }
  return resolved;
}

/**
 * Structural check for a resolved core module value.
 *
 * Both shapes have `Database` as a callable property of some kind:
 *   - Stage 2A fake:  `Database` is a plain object exposing a
 *                      `setup({ storage })` function.
 *   - Real upstream:  `Database` is a CONSTRUCTABLE class —
 *                      `typeof Database === "function"` is true for
 *                      ES classes; we accept any callable `Database`
 *                      value here and let the downstream branch
 *                      (`isRealCoreModule` via the marker) decide
 *                      which runtime path to take.
 */
function isResolvedCore(value: unknown): value is NotesnookCoreModule | NotesnookRealCoreModule {
  if (!value || typeof value !== "object") return false;
  const db = (value as { Database?: unknown }).Database;
  if (!db) return false;
  if (typeof db === "function") return true; // constructable class (real upstream)
  if (typeof db === "object") {
    // Stage 2A fake: must expose a `setup` function.
    return typeof (db as { setup?: unknown }).setup === "function";
  }
  return false;
}

/**
 * Validate a structural value against the closed
 * {@link NotesnookSQLiteOptions} shape.  Throws with a categorical
 * message on the first violation.
 */
export function validateSQLiteOptions(value: unknown): NotesnookSQLiteOptions {
  if (!value || typeof value !== "object") {
    throw adapterError("invalid Notesnook sqliteOptions: expected an object");
  }
  const opts = value as Record<string, unknown>;
  if (typeof opts.dialect !== "function") {
    throw adapterError("invalid Notesnook sqliteOptions: dialect is required");
  }
  if (
    opts.journalMode !== undefined &&
    !["WAL", "MEMORY", "OFF", "PERSIST", "TRUNCATE", "DELETE"].includes(opts.journalMode as string)
  ) {
    throw adapterError("invalid Notesnook sqliteOptions: journalMode is not a known value");
  }
  if (
    opts.synchronous !== undefined &&
    !["normal", "extra", "full", "off"].includes(opts.synchronous as string)
  ) {
    throw adapterError("invalid Notesnook sqliteOptions: synchronous is not a known value");
  }
  if (
    opts.lockingMode !== undefined &&
    !["normal", "exclusive"].includes(opts.lockingMode as string)
  ) {
    throw adapterError("invalid Notesnook sqliteOptions: lockingMode is not a known value");
  }
  if (
    opts.tempStore !== undefined &&
    !["memory", "file", "default"].includes(opts.tempStore as string)
  ) {
    throw adapterError("invalid Notesnook sqliteOptions: tempStore is not a known value");
  }
  if (
    opts.cacheSize !== undefined &&
    (!Number.isInteger(opts.cacheSize) || (opts.cacheSize as number) < 0)
  ) {
    throw adapterError("invalid Notesnook sqliteOptions: cacheSize must be a non-negative integer");
  }
  if (
    opts.pageSize !== undefined &&
    (!Number.isInteger(opts.pageSize) || (opts.pageSize as number) < 0)
  ) {
    throw adapterError("invalid Notesnook sqliteOptions: pageSize must be a non-negative integer");
  }
  if (opts.password !== undefined && typeof opts.password !== "string") {
    throw adapterError("invalid Notesnook sqliteOptions: password must be a string");
  }
  if (opts.skipInitialization !== undefined && typeof opts.skipInitialization !== "boolean") {
    throw adapterError("invalid Notesnook sqliteOptions: skipInitialization must be a boolean");
  }
  const ALLOWED = new Set([
    "dialect",
    "journalMode",
    "synchronous",
    "lockingMode",
    "tempStore",
    "cacheSize",
    "pageSize",
    "password",
    "skipInitialization",
  ]);
  for (const key of Object.keys(opts)) {
    if (!ALLOWED.has(key)) {
      throw adapterError("invalid Notesnook sqliteOptions: unknown option");
    }
  }
  return opts as unknown as NotesnookSQLiteOptions;
}

/**
 * Validate a structural value against the closed
 * {@link NotesnookDatabaseSetupOptions} shape.  Throws with a
 * categorical message on the first violation.
 *
 * This validator is chain-free and never bubbles a `cause` from the
 * upstream module: adapters are responsible for translating their own
 * options into the form the real package expects.
 */
export function validateDatabaseSetupOptions(value: unknown): NotesnookDatabaseSetupOptions {
  if (!value || typeof value !== "object") {
    throw adapterError("invalid Notesnook setup options: expected an object");
  }
  const opts = value as Record<string, unknown>;
  if (typeof opts.sqliteOptions !== "object" || opts.sqliteOptions === null) {
    throw adapterError("invalid Notesnook setup options: sqliteOptions is required");
  }
  validateSQLiteOptions(opts.sqliteOptions);
  if (!opts.storage || typeof opts.storage !== "object") {
    throw adapterError("invalid Notesnook setup options: storage is required");
  }
  if (!opts.fs || typeof opts.fs !== "object") {
    throw adapterError("invalid Notesnook setup options: fs is required");
  }
  if (!opts.compressor || typeof opts.compressor !== "object") {
    throw adapterError("invalid Notesnook setup options: compressor is required");
  }
  if (!Number.isInteger(opts.batchSize) || (opts.batchSize as number) <= 0) {
    throw adapterError("invalid Notesnook setup options: batchSize must be a positive integer");
  }
  if (opts.eventsource !== undefined && typeof opts.eventsource !== "function") {
    throw adapterError("invalid Notesnook setup options: eventsource must be a constructor");
  }
  const ALLOWED = new Set([
    "sqliteOptions",
    "storage",
    "fs",
    "compressor",
    "batchSize",
    "eventsource",
  ]);
  for (const key of Object.keys(opts)) {
    if (!ALLOWED.has(key)) {
      throw adapterError("invalid Notesnook setup options: unknown option");
    }
  }
  return opts as unknown as NotesnookDatabaseSetupOptions;
}

function buildFullSetupOptions(storage: IStorage): NotesnookDatabaseSetupOptions {
  // The widened real-options surface.  When `notesnook-live-factory.ts`
  // drives a real `Database.setup({...})` call, every key here is
  // structurally required by the pinned `@notesnook/core@8.1.3`.
  // The stub throws here so callers that mistakenly drive setup
  // through this helper directly are rejected with a categorical
  // message instead of silently producing an inconsistent view.
  return {
    sqliteOptions: {
      dialect: () => {
        throw adapterError("Notesnook sqliteOptions.dialect must be supplied by the live factory");
      },
    },
    storage,
    fs: {
      downloadFile: () => {
        throw adapterError(
          "Notesnook IFileStorage.downloadFile must be supplied by the live factory",
        );
      },
      uploadFile: () => {
        throw adapterError(
          "Notesnook IFileStorage.uploadFile must be supplied by the live factory",
        );
      },
      readEncrypted: () => {
        throw adapterError(
          "Notesnook IFileStorage.readEncrypted must be supplied by the live factory",
        );
      },
      writeEncryptedBase64: () => {
        throw adapterError(
          "Notesnook IFileStorage.writeEncryptedBase64 must be supplied by the live factory",
        );
      },
      deleteFile: () => {
        throw adapterError(
          "Notesnook IFileStorage.deleteFile must be supplied by the live factory",
        );
      },
      exists: () => {
        throw adapterError("Notesnook IFileStorage.exists must be supplied by the live factory");
      },
      bulkExists: () => {
        throw adapterError(
          "Notesnook IFileStorage.bulkExists must be supplied by the live factory",
        );
      },
      getUploadedFileSize: () => {
        throw adapterError(
          "Notesnook IFileStorage.getUploadedFileSize must be supplied by the live factory",
        );
      },
      clearFileStorage: () => {
        throw adapterError(
          "Notesnook IFileStorage.clearFileStorage must be supplied by the live factory",
        );
      },
      hashBase64: () => {
        throw adapterError(
          "Notesnook IFileStorage.hashBase64 must be supplied by the live factory",
        );
      },
    },
    compressor: {
      compress: () => {
        throw adapterError("Notesnook ICompressor.compress must be supplied by the live factory");
      },
      decompress: () => {
        throw adapterError("Notesnook ICompressor.decompress must be supplied by the live factory");
      },
    },
    batchSize: 1,
  };
}

/**
 * Adapter-owned errors are recognized by identity rather than by their
 * message.  The WeakSet is module-private, so callers cannot forge the
 * trusted-adapter classification by supplying an object with a copied
 * property or attacker-controlled message.
 */
const ADAPTER_ERRORS = new WeakSet<object>();

/**
 * Construct a categorical, chain-free adapter error.  We do NOT carry
 * a `cause` from upstream: upstream exceptions may contain secret
 * material (passwords, MFA codes, token bytes), so the adapter treats
 * any underlying throw as untrusted and re-raises a stable message.
 */
function adapterError(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  ADAPTER_ERRORS.add(error);
  return error;
}

/**
 * Predicate for errors emitted by this adapter.  Keep the marker private;
 * the factory uses this predicate to preserve validator categories without
 * allowing arbitrary thrown values through its hostile-input boundary.
 */
export function isNotesnookAdapterError(value: unknown): value is Error {
  return typeof value === "object" && value !== null && ADAPTER_ERRORS.has(value);
}

function isNotesnookDatabase(value: unknown): value is NotesnookDatabase {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { init?: unknown }).init === "function"
  );
}
