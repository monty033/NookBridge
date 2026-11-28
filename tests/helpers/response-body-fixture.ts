/**
 * A daemon with a fixed set of notes for the `notes.get` response-body tests.
 *
 * Imports only APIs that existed before the response body was added, so the
 * same file can drive the pre-change tree: that is how the compatibility
 * fixture in `nookd-response-body.test.ts` was recorded.
 */

import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { LargeBodyBudget } from "../../src/service/large-body-budget.js";
import {
  startNookdServer,
  type NookdServerHandle,
  type NookdServerRuntime,
} from "../../src/service/nookd-server.js";
import { DEFAULT_SERVICE_ABUSE_BOUNDS } from "../../src/service/service-abuse-bounds.js";
import { createReadOnlyServicePolicy } from "../../src/service/service-policy.js";

export const REVISION = "rev_0123456789abcdef0123456789abcdef";

/** Prose every projection keeps verbatim: letters, spaces, multi-byte text. */
const MULTIBYTE_UNIT = "Grüße 漢字 😀 naïve ";

/** Each note's stored HTML; the projection of each is what a read returns. */
export const NOTE_HTML: Readonly<Record<string, string>> = Object.freeze({
  small: "<p>Hello ünïcødé 😀</p>",
  // Over the single-frame projection bound, well under the wire bound.
  large: `<p>${"x".repeat(100_000)}</p>`,
  // Over the single-frame bound, multi-byte throughout, including 4-byte
  // characters that a split at the wrong byte would break.
  multibyte: `<p>${MULTIBYTE_UNIT.repeat(5_000)}end</p>`,
  // One byte over the single-frame projection bound.
  oversize: `<p>${"y".repeat(65_537)}</p>`,
  // A title-only note: its projection is the empty string.
  empty: "",
  locked: "<p>locked secret</p>",
});

export type NoteName = keyof typeof NOTE_HTML;

export function noteId(name: string): string {
  return `note-${name}`;
}

function metadataFor(id: string): Record<string, unknown> | undefined {
  const name = id.startsWith("note-") ? id.slice("note-".length) : undefined;
  if (name === undefined || (!(name in NOTE_HTML) && name !== "unreadable")) return undefined;
  return {
    id,
    title: `Title ${name}`,
    revision: REVISION,
    ...(name === "locked" ? { locked: true } : {}),
  };
}

export interface ResponseBodyRuntime {
  readonly runtime: NookdServerRuntime;
  /** Every content read, by note id; a locked note must never appear here. */
  readonly contentReads: string[];
}

/**
 * The snapshot slot the way the live factory builds it: metadata first, the
 * body only for a note that is not locked.
 */
export function responseBodyRuntime(): ResponseBodyRuntime {
  const contentReads: string[] = [];
  const readContent = async (id: string): Promise<unknown> => {
    contentReads.push(id);
    const name = id.slice("note-".length);
    if (name === "unreadable") throw new Error("read failed");
    return { type: "html", data: NOTE_HTML[name] };
  };
  const readNoteSnapshot = async (id: string): Promise<unknown> => {
    const metadata = metadataFor(id);
    if (metadata === undefined) return undefined;
    if (metadata.locked === true) return { metadata, contentRefusal: "locked" };
    try {
      return { metadata, content: await readContent(id) };
    } catch {
      return { metadata, contentRefusal: "read_failed" };
    }
  };
  const runtime = Object.freeze({
    search: async () => [],
    noteMetadata: async (id: string) => metadataFor(id),
    readOnly: Object.freeze({ readNoteSnapshot }),
    cleanup: async () => undefined,
  }) as unknown as NookdServerRuntime;
  return { runtime, contentReads };
}

export interface ResponseBodyDaemon {
  readonly socketPath: string;
  readonly handle: NookdServerHandle;
  readonly contentReads: string[];
  readonly close: () => Promise<void>;
}

export async function startResponseBodyDaemon(
  options: { readonly bodyBudget?: LargeBodyBudget; readonly bodyReceiveTimeoutMs?: number } = {},
): Promise<ResponseBodyDaemon> {
  const directory = await mkdtemp(path.join("/tmp", "nbk-resp-"));
  const socketPath = path.join(directory, "nookd.sock");
  const { runtime, contentReads } = responseBodyRuntime();
  const handle = await startNookdServer({
    socketPath,
    runtime,
    policy: createReadOnlyServicePolicy(),
    installSignalHandlers: false,
    resolvePeer: async () => ({
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      groups: ["test"],
    }),
    abuseBounds: {
      ...DEFAULT_SERVICE_ABUSE_BOUNDS,
      perProcessBurstSize: 100,
      ...(options.bodyReceiveTimeoutMs === undefined
        ? {}
        : { bodyReceiveTimeoutMs: options.bodyReceiveTimeoutMs }),
    },
    ...(options.bodyBudget === undefined ? {} : { bodyBudget: options.bodyBudget }),
  });
  return {
    socketPath,
    handle,
    contentReads,
    close: async () => {
      await handle.shutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A `notes.get` frame, with `accept` only when an offer is given. */
export function getFrame(id: string, note: string, acceptBodyBytes?: number): Buffer {
  const envelope: Record<string, unknown> = { id, method: "notes.get", params: { id: note } };
  if (acceptBodyBytes !== undefined) envelope.accept = { bodyBytes: acceptBodyBytes };
  const payload = Buffer.from(JSON.stringify(envelope), "utf8");
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}
