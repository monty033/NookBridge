import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/** One daemon owns one store instance. The adapter owns a private directory,
 * rejects symlinks/non-regular files, bounds reads/listing before allocation,
 * and implements same-directory atomic rename. Names are relative opaque names.
 * No production filesystem or database is opened by this module. */
export interface OperationStoreFs {
  list(limit: number): Promise<string[]>;
  read(name: string, maxBytes: number): Promise<Uint8Array>;
  writeExclusive(name: string, bytes: Uint8Array, mode: 0o600): Promise<void>;
  syncFile(name: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  syncDirectory(): Promise<void>;
  remove(name: string): Promise<void>;
}
export type OperationState =
  | "prepared"
  | "committing"
  | "committed"
  | "unresolved"
  | "undone"
  | "aborted";
export interface OperationRecord {
  readonly handle: string;
  readonly kind: "create" | "edit" | "undo";
  readonly state: OperationState;
  /** Private daemon recovery envelope; never an RPC response. */
  readonly payload: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}
export interface NotesUndoStoreOptions {
  fs: OperationStoreFs;
  daemonKey: Uint8Array;
  now?: () => number;
  maxRecords?: number;
  maxRecordBytes?: number;
  maxTotalBytes?: number;
}
const HANDLE = /^op_[a-f0-9]{64}$/;
const TEMP = /^tmp_[a-f0-9]{64}$/;
const PREFIX = Buffer.from("NBO1");
const DOMAIN = "nookbridge/daemon-operation-store/v1";
const transitions: Record<OperationState, readonly OperationState[]> = {
  prepared: ["committing", "aborted"],
  committing: ["committed", "unresolved", "aborted"],
  committed: ["undone"],
  unresolved: ["committed", "aborted"],
  undone: [],
  aborted: [],
};
function fail(code: string): never {
  throw new Error(code);
}
function positive(n: number) {
  return Number.isSafeInteger(n) && n > 0;
}

/** HKDF has a fixed application salt and purpose-separated info. Inject a
 * high-entropy daemon key unique to the installation. AAD binds version and
 * filename identity. This does not claim protection against rollback of an
 * authentic older record; database revision reconciliation is T07's job. */
export async function createNotesUndoStore(options: NotesUndoStoreOptions) {
  const { fs } = options;
  const now = options.now ?? Date.now;
  const maxRecords = options.maxRecords ?? 256;
  const maxRecordBytes = options.maxRecordBytes ?? 65536;
  const maxTotalBytes = options.maxTotalBytes ?? 8 * 1024 * 1024;
  if (
    !(options.daemonKey instanceof Uint8Array) ||
    options.daemonKey.length !== 32 ||
    ![maxRecords, maxRecordBytes, maxTotalBytes].every(positive) ||
    maxRecords > 10000 ||
    maxRecordBytes > 65536
  )
    fail("invalid-input");
  const copy = Buffer.from(options.daemonKey);
  let key: Buffer;
  try {
    key = Buffer.from(
      hkdfSync("sha256", copy, Buffer.from(DOMAIN), Buffer.from("aes-256-gcm/records"), 32),
    );
  } catch {
    fail("invalid-input");
  } finally {
    copy.fill(0);
  }
  const records = new Map<string, { record: OperationRecord; bytes: number }>();
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  function closeKey() {
    closed = true;
    key.fill(0);
    records.clear();
  }
  async function io<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      closeKey();
      fail("io");
    }
  }
  function clock() {
    const t = now();
    if (!Number.isSafeInteger(t) || t < 0) fail("invalid-input");
    return t;
  }
  function run<T>(action: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      if (closed) fail("closed");
      try {
        return await action();
      } catch (error) {
        if (
          error instanceof Error &&
          ["invalid-input", "conflict", "quota", "missing", "io", "closed"].includes(error.message)
        )
          fail(error.message);
        fail("invalid-input");
      }
    });
    tail = result.catch(() => undefined);
    return result;
  }
  const aad = (handle: string) => Buffer.from(`${DOMAIN}:${handle}`);
  function decode(handle: string, frame: Uint8Array): OperationRecord {
    let plain: Buffer | undefined;
    let partial: Buffer | undefined;
    try {
      const b = Buffer.from(frame);
      if (b.length < 33 || !b.subarray(0, 4).equals(PREFIX)) fail("corrupt");
      const cipher = createDecipheriv("aes-256-gcm", key, b.subarray(4, 16));
      cipher.setAAD(aad(handle));
      cipher.setAuthTag(b.subarray(16, 32));
      partial = cipher.update(b.subarray(32));
      plain = Buffer.concat([partial, cipher.final()]);
      const r = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(plain),
      ) as OperationRecord;
      if (
        !r ||
        Object.keys(r).sort().join() !== "createdAt,expiresAt,handle,kind,payload,state" ||
        r.handle !== handle ||
        !["create", "edit", "undo"].includes(r.kind) ||
        !Object.hasOwn(transitions, r.state) ||
        typeof r.payload !== "string" ||
        !Number.isSafeInteger(r.createdAt) ||
        r.createdAt < 0 ||
        !positive(r.expiresAt) ||
        r.expiresAt <= r.createdAt
      )
        fail("corrupt");
      return Object.freeze(r);
    } catch {
      return fail("corrupt");
    } finally {
      plain?.fill(0);
      partial?.fill(0);
    }
  }
  async function persist(record: OperationRecord) {
    if (Buffer.byteLength(record.payload, "utf8") > maxRecordBytes) fail("quota");
    const plain = Buffer.from(JSON.stringify(record));
    let frame: Buffer;
    try {
      if (plain.length + 32 > maxRecordBytes) fail("quota");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(record.handle));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      frame = Buffer.concat([PREFIX, nonce, cipher.getAuthTag(), encrypted]);
    } finally {
      plain.fill(0);
    }
    const old = records.get(record.handle);
    const total = [...records.values()].reduce((n, r) => n + r.bytes, 0) + frame.length;
    if ((!old && records.size >= maxRecords) || total > maxTotalBytes) fail("quota");
    const temp = `tmp_${randomBytes(32).toString("hex")}`;
    // Any IO failure poisons this instance: rename may have succeeded even when
    // directory fsync fails. Reopen/reconcile, never blindly retry a mutation.
    await io(async () => {
      await fs.writeExclusive(temp, frame, 0o600);
      await fs.syncFile(temp);
      await fs.rename(temp, record.handle);
      await fs.syncDirectory();
    });
    records.set(record.handle, { record: Object.freeze(record), bytes: frame.length });
    return record;
  }
  async function remove(handle: string) {
    await io(async () => {
      await fs.remove(handle);
      await fs.syncDirectory();
    });
    records.delete(handle);
  }
  async function expire() {
    const t = clock();
    for (const [h, r] of records) if (r.record.expiresAt <= t) await remove(h);
  }
  function lookup(handle: string) {
    if (typeof handle !== "string" || !HANDLE.test(handle)) fail("invalid-input");
    return records.get(handle)?.record ?? fail("missing");
  }
  try {
    const names = await io(() => fs.list(maxRecords * 2 + 2));
    if (names.length > maxRecords * 2 + 1) fail("quota");
    if (new Set(names).size !== names.length || names.some((n) => !HANDLE.test(n) && !TEMP.test(n)))
      fail("corrupt");
    let recoveredBytes = 0;
    for (const name of names.filter((n) => HANDLE.test(n))) {
      const frame = await io(() => fs.read(name, maxRecordBytes));
      recoveredBytes += frame.length;
      if (
        frame.length > maxRecordBytes ||
        recoveredBytes > maxTotalBytes ||
        records.size >= maxRecords
      )
        fail("quota");
      const record = decode(name, frame);
      records.set(name, { record, bytes: frame.length });
    }
    if (
      records.size > maxRecords ||
      [...records.values()].reduce((n, r) => n + r.bytes, 0) > maxTotalBytes
    )
      fail("quota");
    // Validate every final record before removing any expired record or orphan.
    for (const name of names.filter((n) => TEMP.test(n))) await remove(name);
    await expire();
  } catch (error) {
    closeKey();
    if (
      error instanceof Error &&
      ["quota", "corrupt", "io", "invalid-input"].includes(error.message)
    )
      fail(error.message);
    fail("corrupt");
  }
  return Object.freeze({
    insert(input: { kind: OperationRecord["kind"]; payload: string; ttlMs: number }) {
      return run(async () => {
        if (
          !input ||
          !["create", "edit", "undo"].includes(input.kind) ||
          typeof input.payload !== "string" ||
          !positive(input.ttlMs)
        )
          fail("invalid-input");
        const createdAt = clock();
        const expiresAt = createdAt + input.ttlMs;
        if (!positive(expiresAt)) fail("invalid-input");
        await expire();
        const handle = `op_${randomBytes(32).toString("hex")}`;
        if (records.has(handle)) fail("conflict");
        return persist({
          handle,
          kind: input.kind,
          payload: input.payload,
          state: "prepared",
          createdAt,
          expiresAt,
        });
      });
    },
    get(handle: string, owner?: string) {
      return run(async () => {
        await expire();
        return ownedLookup(handle, owner);
      });
    },
    list(owner?: string) {
      return run(async () => {
        await expire();
        return [...records.values()]
          .map((r) => r.record)
          .filter((record) => owner === undefined || recordOwner(record) === owner);
      });
    },
    /** Expected-state CAS; unresolved -> aborted requires explicit reconciliation
     * by the daemon caller. Payload can carry actual revisions, never predictions. */
    transition(
      handle: string,
      expected: OperationState,
      next: OperationState,
      payload?: string,
      owner?: string,
    ) {
      return run(async () => {
        await expire();
        const r = ownedLookup(handle, owner);
        if (r.state !== expected || !transitions[r.state].includes(next)) fail("conflict");
        if (payload !== undefined && typeof payload !== "string") fail("invalid-input");
        return persist({ ...r, state: next, payload: payload ?? r.payload });
      });
    },
    acknowledge(handle: string) {
      return run(async () => {
        await expire();
        const r = lookup(handle);
        if (r.state !== "aborted" && r.state !== "undone") fail("conflict");
        await remove(handle);
      });
    },
    close() {
      return run(async () => {
        closeKey();
      });
    },
  });

  function recordOwner(record: OperationRecord): string | undefined {
    try {
      const payload = JSON.parse(record.payload) as { owner?: unknown };
      return typeof payload.owner === "string" ? payload.owner : undefined;
    } catch {
      return undefined;
    }
  }

  function ownedLookup(handle: string, owner: string | undefined): OperationRecord {
    const record = lookup(handle);
    if (owner !== undefined && recordOwner(record) !== owner) fail("missing");
    return record;
  }
}
