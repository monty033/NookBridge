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
 * Refuse a database that cannot say whether a sync completed.
 *
 * A pull is provable only through two signals — core publishing its completion
 * event during the call, and the completion stamp advancing afterwards — so the
 * production write path calls this while it is being built: a deployment whose
 * database cannot report both fails at startup rather than accepting an
 * unprovable pull on every write. Test fakes that model a sync without those
 * records are not required to carry them; they take the legacy path documented
 * below.
 */
export function assertLivePreWriteConfirmation(database: object): void {
  const eventSlot = readSlot(database, "eventManager");
  const subscribe = isRecord(eventSlot) ? readSlot(eventSlot, "subscribe") : undefined;
  const canStamp = typeof readSlot(database, "lastSynced") === "function";
  const canObserve = typeof subscribe === "function";
  if (!canStamp || !canObserve) {
    // Both signals are required: the documented guarantee is an event during
    // the call and an advanced stamp afterwards. A database that offers only
    // one would silently weaken it to a stamp-only check.
    throw new Error("conflict pre-write read: database cannot confirm a fetch");
  }
}

/**
 * Build the pull from a live database.
 *
 * Construction refuses a database that cannot fetch, so a misconfigured write
 * path fails at startup instead of writing blind at the first mutation.
 *
 * When the database can report a completion stamp, a pull counts as confirmed
 * only if that stamp advanced. Without one — a fixture that models a sync
 * without a completion record — the reported boolean stands, which is the
 * pre-Stage-2 behaviour. The production path asserts the stamp is present
 * separately, so the loose path cannot be reached by a real deployment.
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
  const lastSyncedSlot = readSlot(database, "lastSynced");
  const boundStart = (start as Fn).bind(syncer);
  // `acquireLock` stops core's auto-sync scheduling for the duration of the
  // callback. It is not what makes the confirmation sound — it cannot cancel a
  // sync already in flight — but it costs nothing and keeps the scheduler out
  // of the window. What makes it sound is that every bridge caller of the core
  // sync entry point holds the same per-database lock, so no other sync from
  // this process can be running here.
  const acquireLockSlot = readSlot(syncer, "acquireLock");
  const boundAcquireLock =
    typeof acquireLockSlot === "function" ? (acquireLockSlot as Fn).bind(syncer) : undefined;
  const boundLastSynced =
    typeof lastSyncedSlot === "function" ? (lastSyncedSlot as Fn).bind(database) : undefined;
  const userSlot = readSlot(database, "user");
  const getUser = isRecord(userSlot) ? readSlot(userSlot, "getUser") : undefined;
  const boundGetUser = typeof getUser === "function" ? (getUser as Fn).bind(userSlot) : undefined;
  const eventSlot = readSlot(database, "eventManager");
  const subscribeEvent = isRecord(eventSlot) ? readSlot(eventSlot, "subscribe") : undefined;
  const boundSubscribe =
    typeof subscribeEvent === "function"
      ? (((handler: () => void) =>
          Reflect.apply(subscribeEvent, eventSlot, ["sync:completed", handler])) as (
          handler: () => void,
        ) => unknown)
      : undefined;
  const subscribed = boundSubscribe !== undefined;
  const tokenSlot = readSlot(database, "tokenManager");
  const getToken = isRecord(tokenSlot) ? readSlot(tokenSlot, "getToken") : undefined;
  const boundGetToken =
    typeof getToken === "function" ? (getToken as Fn).bind(tokenSlot) : undefined;

  /**
   * Whether a remote account could hold a different version of this note.
   *
   * A token means a session even when no user record is loaded: core stores the
   * two separately, so an absent user record is not proof of being signed out.
   * Local-only writes are therefore allowed only when every signal says there
   * is no account. When neither signal is readable the answer is "assume
   * remote", so the pull is required.
   */
  async function hasRemoteSession(): Promise<boolean> {
    let signals = 0;
    if (boundGetToken !== undefined) {
      signals += 1;
      const token = await boundGetToken();
      // The token is an opaque envelope, not necessarily a string; anything
      // present means a session, so only "absent" is treated as signed out.
      if (token !== undefined && token !== null) return true;
    }
    if (boundGetUser !== undefined) {
      signals += 1;
      const user = await boundGetUser();
      if (user !== undefined && user !== null) return true;
    }
    return signals === 0;
  }

  return async (): Promise<boolean> => {
    ensureOpen();
    let completed = false;
    let unsubscribe: (() => unknown) | undefined;
    try {
      if (!(await hasRemoteSession())) return true;
      if (boundSubscribe !== undefined) {
        const subscription: unknown = boundSubscribe(() => {
          completed = true;
        });
        if (isRecord(subscription)) {
          const candidate = readSlot(subscription, "unsubscribe");
          if (typeof candidate === "function") {
            unsubscribe = (candidate as Fn).bind(subscription) as () => unknown;
          }
        }
      }
      const before = boundLastSynced === undefined ? undefined : await boundLastSynced();
      // The exact request, pinned here so nothing can widen it to "full".
      let result: unknown;
      const pull = async (): Promise<void> => {
        result = await boundStart({ type: "fetch" });
      };
      if (boundAcquireLock === undefined) {
        await pull();
      } else {
        await boundAcquireLock(pull);
      }
      if (result !== true) return false;
      if (boundLastSynced === undefined) {
        // No completion record at all: the legacy seam keeps the reported
        // boolean. Production asserts the record exists before it can get here.
        return !subscribed || completed;
      }
      const after = await boundLastSynced();
      // Strictly later: an unchanged stamp means no sync finished, and a false
      // refusal is recoverable while a false pass is not.
      const stampAdvanced =
        typeof before === "number" && typeof after === "number" && after > before;
      // When both signals exist require both: the event ties completion to a
      // sync finishing now, the stamp rules out a concurrent sync satisfying
      // the event alone.
      return subscribed ? completed && stampAdvanced : stampAdvanced;
    } catch {
      return false;
    } finally {
      if (unsubscribe !== undefined) {
        try {
          await unsubscribe();
        } catch {
          // Unsubscribing is best effort; the result is already decided.
        }
      }
    }
  };
}
