import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { decodeNoteDocumentNative } from "../core/note-document-native.js";
import { serializeNoteDocumentMarkdown } from "../core/note-document-markdown.js";
import type { ServiceRuntime } from "./service-runtime.js";
import type {
  OperatorDiscoveryPage,
  OperatorDiscoveryRuntime,
} from "./operator-discovery-handler.js";
import type { OperatorPeer } from "./operator-server.js";
import { OperatorWriteError } from "./notes-operator-write-runtime.js";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_CURSOR_COUNT = 512;
const MAX_HANDLE_COUNT = 10_000;

type CursorState = Readonly<{ query?: string; offset: number }>;

/**
 * The daemon-side opaque handle registry.
 *
 * Handles are the ONLY way a note is addressed across the operator socket:
 * raw database ids never cross it.  Discovery mints handles while browsing
 * and searching; the mutation runtime resolves them.  Both therefore need
 * the SAME registry instance, so it is created once per daemon and injected
 * into each consumer rather than owned privately by discovery.
 */
export interface OperatorHandleRegistry {
  /** Mint a fresh opaque handle for a note id, evicting the oldest if needed. */
  readonly mint: (noteId: string, peer?: OperatorPeer) => string;
  /** Resolve an opaque handle only for its owning peer. */
  readonly resolve: (handle: string, peer?: OperatorPeer) => string | undefined;
}

export function operatorPeerKey(peer?: OperatorPeer): string {
  if (peer === undefined) return "legacy";
  return `${peer.uid}:${peer.gid}:${[...peer.groups].sort().join(",")}`;
}

/** Build a process-local, peer-scoped handle registry. */
export function createOperatorHandleRegistry(): OperatorHandleRegistry {
  const handles = new Map<string, Readonly<{ noteId: string; owner: string }>>();

  const mint = (noteId: string, peer?: OperatorPeer): string => {
    const owner = operatorPeerKey(peer);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const handle = `h_${randomBytes(18).toString("base64url")}`;
      if (!handles.has(handle)) {
        if (handles.size >= MAX_HANDLE_COUNT) {
          const oldest = handles.keys().next().value;
          if (typeof oldest === "string") handles.delete(oldest);
        }
        handles.set(handle, { noteId, owner });
        return handle;
      }
    }
    throw new Error("handle unavailable");
  };

  return Object.freeze({
    mint,
    resolve: (handle: string, peer?: OperatorPeer): string | undefined => {
      const entry = handles.get(handle);
      return entry?.owner === operatorPeerKey(peer) ? entry.noteId : undefined;
    },
  });
}

/**
 * Build the daemon-owned discovery projection. Handles and cursors are
 * session-scoped random capabilities; raw note IDs never cross the socket.
 */
export function createOperatorDiscoveryRuntime(
  service: ServiceRuntime,
  registry: OperatorHandleRegistry = createOperatorHandleRegistry(),
): OperatorDiscoveryRuntime {
  const cursors = new Map<string, CursorState>();

  return {
    browse: async (params, peer) => {
      const notes = await service.readOnly.listNotes();
      return page(
        notes.map((note) => ({ id: note.id, title: note.title })),
        params,
        undefined,
        peer,
      );
    },
    search: async (params, peer) => {
      const hits = await service.readOnly.search(params.query);
      return page(
        hits
          .filter((hit) => hit.source === "note")
          .map((hit) => ({ id: hit.id, title: hit.title })),
        params,
        params.query,
        peer,
      );
    },
    view: async ({ id }, peer) => {
      const noteId = registry.resolve(id, peer);
      if (noteId === undefined) throw new OperatorWriteError("not_found");
      const reader = service.readOnly.readNoteContent;
      if (reader === undefined) throw new Error("content unavailable");
      const metadata = await service.readOnly.noteMetadata(noteId);
      if (metadata === undefined) throw new Error("note unavailable");
      const content = await reader(noteId);
      const revision = metadata.revision ?? `rev_${"0".repeat(32)}`;
      const decoded = decodeNoteDocumentNative(content, { noteId, revision });
      const markdown = serializeNoteDocumentMarkdown(decoded.document);
      return {
        id,
        revision,
        markdown,
        contentBytes: Buffer.byteLength(markdown, "utf8"),
      };
    },
    create: async (params, peer) => {
      if (service.createNote === undefined) throw new Error("create unavailable");
      const result = await service.createNote(params);
      return {
        kind: "create",
        id: registry.mint(result.id, peer),
        titleBytes: result.titleBytes,
        contentBytes: result.contentBytes,
      };
    },
  };

  async function page(
    source: ReadonlyArray<Readonly<{ id: string; title: string }>>,
    params: Readonly<{ cursor?: string; limit?: number }>,
    query: string | undefined,
    peer: OperatorPeer | undefined,
  ): Promise<OperatorDiscoveryPage> {
    const limit = normalizeLimit(params.limit);
    const state = params.cursor === undefined ? undefined : cursors.get(params.cursor);
    if (params.cursor !== undefined && state === undefined) throw new Error("cursor unavailable");
    if (state !== undefined && state.query !== query) throw new Error("cursor query mismatch");
    const offset = state?.offset ?? 0;
    const selected = source.slice(offset, offset + limit);
    const notes = selected.map((note) => ({
      handle: registry.mint(note.id, peer),
      label: note.title,
      bytes: Buffer.byteLength(note.title, "utf8"),
    }));
    const nextOffset = offset + selected.length;
    const next =
      nextOffset < source.length
        ? mintCursor(query === undefined ? { offset: nextOffset } : { query, offset: nextOffset })
        : null;
    return { notes, next };
  }

  function mintCursor(state: CursorState): string {
    const cursor = `cur_${randomBytes(18).toString("base64url")}`;
    if (cursors.size >= MAX_CURSOR_COUNT) {
      const oldest = cursors.keys().next().value;
      if (typeof oldest === "string") cursors.delete(oldest);
    }
    cursors.set(cursor, state);
    return cursor;
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new Error("limit unavailable");
  return limit;
}
