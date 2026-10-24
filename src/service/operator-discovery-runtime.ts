import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { decodeNoteDocumentNative } from "../core/note-document-native.js";
import { serializeNoteDocumentMarkdown } from "../core/note-document-markdown.js";
import { noteHtmlReadonlyMarkdown } from "../core/note-html-readonly-markdown.js";
import type { ServiceRuntime } from "./service-runtime.js";
import type { DiscoveryVisibility } from "./discovery-visibility.js";
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
const DEFAULT_HANDLE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

type CursorState = Readonly<{ query?: string; offset: number; owner: string; expiresAt: number }>;

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
  readonly mint: (noteId: string, peer: OperatorPeer | undefined) => string;
  /** Resolve an opaque handle only for its owning peer. */
  readonly resolve: (handle: string, peer: OperatorPeer | undefined) => string | undefined;
}

export function operatorPeerKey(peer: OperatorPeer | undefined): string {
  const candidate = peer as unknown as Partial<OperatorPeer> | null | undefined;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !isId(candidate.uid) ||
    !isId(candidate.gid) ||
    !Array.isArray(candidate.groups) ||
    !candidate.groups.every((group) => typeof group === "string")
  )
    throw new OperatorWriteError("permission_denied");
  return `${candidate.uid}:${candidate.gid}:${[...candidate.groups].sort().join(",")}`;
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Build a process-local, peer-scoped handle registry. */
export function createOperatorHandleRegistry(
  options?: Readonly<{ ttlMs?: number; now?: () => number }>,
): OperatorHandleRegistry {
  const ttlMs = options?.ttlMs ?? DEFAULT_HANDLE_TTL_MS;
  const now = options?.now ?? Date.now;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("invalid handle ttl");
  const handles = new Map<string, Readonly<{ noteId: string; owner: string; expiresAt: number }>>();

  const sweep = (): void => {
    const current = now();
    for (const [handle, entry] of handles) if (entry.expiresAt <= current) handles.delete(handle);
  };

  const mint = (noteId: string, peer: OperatorPeer | undefined): string => {
    sweep();
    const owner = operatorPeerKey(peer);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const handle = `h_${randomBytes(18).toString("base64url")}`;
      if (!handles.has(handle)) {
        if (handles.size >= MAX_HANDLE_COUNT) {
          const oldest = handles.keys().next().value;
          if (typeof oldest === "string") handles.delete(oldest);
        }
        handles.set(handle, { noteId, owner, expiresAt: now() + ttlMs });
        return handle;
      }
    }
    throw new Error("handle unavailable");
  };

  return Object.freeze({
    mint,
    resolve: (handle: string, peer: OperatorPeer | undefined): string | undefined => {
      let owner: string;
      try {
        owner = operatorPeerKey(peer);
      } catch {
        return undefined;
      }
      sweep();
      const entry = handles.get(handle);
      return entry?.owner === owner ? entry.noteId : undefined;
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
  visibility: DiscoveryVisibility,
): OperatorDiscoveryRuntime {
  const cursors = new Map<string, CursorState>();

  return {
    // Every entry point validates the peer before any downstream call.
    browse: async (params, peer) => {
      requirePeer(peer);
      const notes = await visibility.listNotes();
      return page(
        notes.map((note) => ({ id: note.id, title: note.title })),
        params,
        undefined,
        peer,
      );
    },
    search: async (params, peer) => {
      requirePeer(peer);
      const hits = await visibility.searchHits(params.query);
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
      requirePeer(peer);
      const noteId = registry.resolve(id, peer);
      if (noteId === undefined) throw new OperatorWriteError("not_found");
      const reader = service.readOnly.readOperatorNoteContent;
      if (reader === undefined) throw new Error("content unavailable");
      const metadata = await service.readOnly.noteMetadata(noteId);
      if (metadata === undefined) throw new Error("note unavailable");
      const content = await reader(noteId);
      const revision = metadata.revision ?? `rev_${"0".repeat(32)}`;
      let markdown: string;
      try {
        const decoded = decodeNoteDocumentNative(content, { noteId, revision });
        markdown = serializeNoteDocumentMarkdown(decoded.document);
      } catch {
        // Read-only approximation, the same one `notes.get` uses.  Content the
        // strict decoder refuses still gets a bounded view; the fallback wraps
        // only decode/serialize, never the reader above, so a locked-note
        // refusal is untouched.  It is NOT an edit preimage and must never feed
        // editPreimage/applyEdit/applyUndo, which stay strict.
        markdown = tolerantViewMarkdown(content);
      }
      return {
        id,
        revision,
        markdown,
        contentBytes: Buffer.byteLength(markdown, "utf8"),
      };
    },
    create: async (params, peer) => {
      requirePeer(peer);
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
    if (state !== undefined && state.expiresAt <= Date.now()) {
      cursors.delete(params.cursor!);
      throw new Error("cursor unavailable");
    }
    if (state !== undefined && state.owner !== operatorPeerKey(peer))
      throw new Error("cursor unavailable");
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
        ? mintCursor(
            query === undefined ? { offset: nextOffset } : { query, offset: nextOffset },
            peer,
          )
        : null;
    return { notes, next };
  }

  function mintCursor(
    state: Readonly<{ query?: string; offset: number }>,
    peer: OperatorPeer | undefined,
  ): string {
    const cursor = `cur_${randomBytes(18).toString("base64url")}`;
    if (cursors.size >= MAX_CURSOR_COUNT) {
      const oldest = cursors.keys().next().value;
      if (typeof oldest === "string") cursors.delete(oldest);
    }
    cursors.set(cursor, {
      ...state,
      owner: operatorPeerKey(peer),
      expiresAt: Date.now() + DEFAULT_CURSOR_TTL_MS,
    });
    return cursor;
  }
}

/**
 * Bounded, approximate Markdown for view-only use.
 *
 * Mirrors `readBoundedNoteContent` in the RPC handler: only a stored-content
 * envelope the read projection could have produced is accepted, and the
 * tolerant renderer drops decoration, summarises images and attachments, and
 * never emits source URLs, data or opaque references.  The result is an
 * approximation, not an edit baseline.
 */
function tolerantViewMarkdown(content: unknown): string {
  if (content === null || typeof content !== "object") throw new Error("content unavailable");
  const candidate = content as { readonly type?: unknown; readonly data?: unknown };
  if (
    (candidate.type !== "tiptap" && candidate.type !== "html") ||
    typeof candidate.data !== "string"
  )
    throw new Error("content unavailable");
  return noteHtmlReadonlyMarkdown(candidate.data);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new Error("limit unavailable");
  return limit;
}

function requirePeer(peer: OperatorPeer | undefined): asserts peer is OperatorPeer {
  if (peer === undefined) throw new OperatorWriteError("permission_denied");
  operatorPeerKey(peer);
}
