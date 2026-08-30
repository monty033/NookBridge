/**
 * Stage 4 — production projection from the pinned `@notesnook/core@8.1.3`
 * `Database` collections to the separately named live write capability.
 *
 * This module is the only place where a live `Database` instance is turned
 * into a write capability, and it is deliberately narrow:
 *
 *   - It reads exactly five collection slots (`notes`, `content`,
 *     `notebooks`, `tags`, `relations`) into a fresh, null-prototype
 *     structural runtime object.  The raw `Database` is never stored on that
 *     object, never returned, and never reachable from the published
 *     capability.  `user`, `tokenManager`, `kv`, `syncer`, `vault`,
 *     `attachments`, `backup`, `trash`, and every other slot stay behind the
 *     boundary.
 *   - The structural runtime is validated and bound by the existing
 *     `bindNotesnookWriteRuntime` → `NotesnookWriteAdapter` →
 *     `NotesnookLocalWriteComposition` chain.  No new mutation path is
 *     introduced by this module; it only supplies the already-reviewed chain
 *     with its production inputs.
 *   - The published capability exposes exactly `createNote`, `appendNote`,
 *     `updateNote`, and `pendingSnapshot`.  `requestSync` is intentionally
 *     NOT exposed: this slice ships no live remote executor, so a remote
 *     trigger here could only ever produce an unprovable remote claim.  The
 *     injected coordinator executor therefore refuses every remote attempt,
 *     and pending work stays pending.
 *   - The capability is frozen and lifecycle-guarded: once the owning runtime
 *     has been closed, every method fails categorically instead of touching a
 *     torn-down database.
 */

import { DETERMINISTIC_MARKDOWN_CODEC } from "./notesnook-write-codec.js";
import { NotesnookWriteContractError } from "./notesnook-write-contract.js";
import { createNotesnookWriteAdapter } from "./notesnook-write-adapter.js";
import { bindNotesnookWriteRuntime } from "./notesnook-write-wiring.js";
import {
  createNotesnookLocalWriteComposition,
  type NotesnookLocalWriteComposition,
} from "./notesnook-write-composition.js";
import { SyncCoordinator } from "./notesnook-sync-coordinator.js";
import type { NotesnookLiveWriteCapability } from "./notesnook-write-admin.js";

/** The five collection slots the write chain consumes. */
const WRITE_RUNTIME_SLOTS: readonly string[] = [
  "notes",
  "content",
  "notebooks",
  "tags",
  "relations",
];

function capabilityError(): Error {
  const error = new NotesnookWriteContractError("sync_failed");
  Object.defineProperty(error, "name", {
    configurable: true,
    value: "NotesnookLiveWriteCapabilityError",
  });
  return error;
}

/**
 * True when `database` exposes every collection slot the write chain needs.
 *
 * Used by the live factory so a legacy auth-only injected fake simply remains
 * without the optional write capability instead of failing construction.
 */
export function hasLiveWriteSurface(database: unknown): boolean {
  if (typeof database !== "object" || database === null) return false;
  try {
    return WRITE_RUNTIME_SLOTS.every((slot) => slot in (database as object));
  } catch {
    return false;
  }
}

/**
 * Read one collection slot through a hostile-getter-safe accessor.
 *
 * A throwing accessor, a missing slot, or a primitive slot is a categorical
 * failure; the observed value is never echoed.
 */
function readCollection(database: object, slot: string): object {
  let value: unknown;
  try {
    value = Reflect.get(database, slot, database);
  } catch {
    throw capabilityError();
  }
  if (typeof value !== "object" || value === null) throw capabilityError();
  return value;
}

/**
 * Project the live `Database` collections into the structural write runtime.
 *
 * The returned object is a FRESH null-prototype record holding only the five
 * collection references.  It is consumed immediately by
 * `bindNotesnookWriteRuntime` and is never published.
 */
function projectWriteRuntime(database: object): object {
  const runtime = Object.create(null) as Record<string, unknown>;
  for (const slot of WRITE_RUNTIME_SLOTS) {
    Object.defineProperty(runtime, slot, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: readCollection(database, slot),
    });
  }
  return Object.freeze(runtime);
}

/**
 * Build the local-write composition for a live database.
 *
 * The coordinator's executor refuses every remote attempt, so a pending
 * marker can only ever be cleared by a future slice that wires a real
 * executor.  Local commits are never reported as remotely synchronised.
 */
export function createLiveLocalWriteComposition(database: object): NotesnookLocalWriteComposition {
  const seam = bindNotesnookWriteRuntime(
    projectWriteRuntime(database) as Parameters<typeof bindNotesnookWriteRuntime>[0],
  );
  const adapter = createNotesnookWriteAdapter({
    source: seam,
    codec: DETERMINISTIC_MARKDOWN_CODEC,
  });
  const coordinator = new SyncCoordinator({
    // No live remote executor exists in this slice.  Refusing here keeps
    // pending work pending rather than fabricating a remote receipt.
    executor: () => ({ status: "failed" as const }),
  });
  return createNotesnookLocalWriteComposition({ adapter, coordinator });
}

/**
 * Project a live `Database` into the separately named write capability.
 *
 * `ensureOpen` is the owning runtime's lifecycle check; it runs before every
 * published method so a closed runtime cannot be driven through a captured
 * capability reference.
 */
export function projectLiveDatabaseToWriteCapability(
  database: object,
  ensureOpen: () => void,
): NotesnookLiveWriteCapability {
  const composition = createLiveLocalWriteComposition(database);
  return Object.freeze({
    createNote: async (command: Parameters<NotesnookLiveWriteCapability["createNote"]>[0]) => {
      ensureOpen();
      return composition.createNote(command as Parameters<typeof composition.createNote>[0]);
    },
    appendNote: async (command: Parameters<NotesnookLiveWriteCapability["appendNote"]>[0]) => {
      ensureOpen();
      return composition.appendNote(command as Parameters<typeof composition.appendNote>[0]);
    },
    updateNote: async (command: Parameters<NotesnookLiveWriteCapability["updateNote"]>[0]) => {
      ensureOpen();
      return composition.updateNote(command as Parameters<typeof composition.updateNote>[0]);
    },
    pendingSnapshot: () => {
      ensureOpen();
      return composition.pendingSnapshot();
    },
  });
}
