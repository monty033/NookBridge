/**
 * The pre-write pull for the live write path.
 *
 * A local mutation that never fetched can overwrite a note the phone changed
 * since this bridge last saw it. That produces exactly the conflicted note the
 * operator then has to resolve by hand, so the write path pulls first.
 *
 * The pull is FETCH ONLY. Upstream `syncer.start({ type: "full" })` performs a
 * fetch *followed by a send*, which is a different operation with different
 * failure modes; issuing it here would upload inside the mutation path. This
 * module therefore issues the literal `{ type: "fetch" }` and nothing else.
 *
 * Every failure is reported as `false`. The composition turns that into
 * `sync_required`, which is the same categorical refusal it already uses for a
 * full pending queue: sync, then retry.
 */

/** Injected pull. Resolves `true` only for a confirmed fetch. */
export type LivePreWriteRead = () => Promise<boolean>;

type Fn = (...args: unknown[]) => unknown;

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function readSlot(owner: unknown, key: string): unknown {
  if (owner === null || (typeof owner !== "object" && typeof owner !== "function")) {
    return undefined;
  }
  try {
    return Reflect.get(owner, key);
  } catch {
    return undefined;
  }
}

/**
 * Build the pull from a live database.
 *
 * Construction refuses a database that cannot fetch, so a misconfigured write
 * path fails at startup instead of writing blind at the first mutation.
 */
export function createLivePreWriteRead(database: object, ensureOpen: () => void): LivePreWriteRead {
  if (!isRecord(database)) {
    throw new Error("conflict pre-write read: database is invalid");
  }
  if (typeof ensureOpen !== "function") {
    throw new Error("conflict pre-write read: ensureOpen is invalid");
  }

  const syncer = readSlot(database, "syncer") ?? database;
  const start = readSlot(syncer, "start");
  if (!isRecord(syncer) || typeof start !== "function") {
    throw new Error("conflict pre-write read: database cannot fetch");
  }
  const boundStart = (start as Fn).bind(syncer);

  return async (): Promise<boolean> => {
    ensureOpen();
    try {
      // The exact request, pinned here so nothing can widen it to "full".
      const result = await boundStart({ type: "fetch" });
      return result === true;
    } catch {
      return false;
    }
  };
}
