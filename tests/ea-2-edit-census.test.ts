/**
 * EA-2 — `notes.edit-census` over a synthetic database.
 *
 * Counts only: no body, title, raw id or snippet. The corpus test uses the real
 * production runtime over the synthetic core (the same harness as the EA-1/EA-2
 * reproduction tests), with the production discovery visibility filter: the
 * census counts only what `notes.browse` would list: both hidden classes, a
 * locked note and a note in a notebook whose settings deny `read`, are seeded
 * and must be in no bucket. The read-only proof
 * snapshots the persisted pending-marker set, the operation-record store, every
 * note record and every `notes.get` projection before and after the census.
 */

import { Buffer } from "node:buffer";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PersistentSyncMetadataStateStore } from "../src/core/notesnook-sync-state-store.js";
import { createOperatorWriteSource } from "../src/nookd.js";
import { createDiscoveryVisibility } from "../src/service/discovery-visibility.js";
import { createOperatorWriteRuntime } from "../src/service/notes-operator-write-runtime.js";
import { createNotesUndoStore, type OperationStoreFs } from "../src/service/notes-undo-store.js";
import { handleRpcRequest } from "../src/service/rpc-handler.js";
import {
  createOperatorHandleRegistry,
  createOperatorDiscoveryRuntime,
} from "../src/service/operator-discovery-runtime.js";
import { createOperatorDiscoveryHandler } from "../src/service/operator-discovery-handler.js";
import type { OperatorPeer } from "../src/service/operator-server.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import {
  parseRpcFrame,
  serializeRpcResponse,
  type RpcNotesEditCensusResult,
  type RpcRequest,
} from "../src/service/rpc-protocol.js";
import {
  createNotesEditCensus,
  MAX_EDIT_CENSUS_NOTES_PER_RUN,
  NotesEditCensusUnavailableError,
} from "../src/service/notes-edit-census.js";
import type * as NoteDocumentMarkdownModule from "../src/core/note-document-markdown.js";
import type * as NoteDocumentNativeModule from "../src/core/note-document-native.js";
import type * as NotesEditCensusModule from "../src/service/notes-edit-census.js";
import type { ServiceRuntime } from "../src/service/service-runtime.js";
import { buildNotebookIndex } from "../src/settings/notebook-index.js";
import { createSettingsEvaluator } from "../src/settings/settings-evaluator.js";
import type { SettingsFile } from "../src/settings/settings-types.js";
import {
  cleanupSyntheticDaemons,
  startDaemon,
  type SeedNote,
} from "./helpers/ea-synthetic-daemon.js";

const OPERATOR: OperatorPeer = {
  uid: 1,
  gid: 2,
  groups: ["nookbridge-operators"],
};

/** One notebook whose settings deny `read`; `n-denied` is its only note. */
const DENIED_NOTEBOOK = { id: "nb-denied", title: "Denied" } as const;
const NOTEBOOK_OF: Readonly<Record<string, string>> = { "n-denied": DENIED_NOTEBOOK.id };

/** Every note readable by default; the lock and the denied notebook hide two. */
const SETTINGS: SettingsFile = {
  version: 1,
  upload: "attributed",
  defaults: { read: true, edit: true, create: true, delete: false },
  overrides: [{ notebooks: [DENIED_NOTEBOOK.title], read: false }],
};

const STRICT = "<p>Synthetic strict body</p>";
const PRESERVED = "<hr>";
const OPAQUE_HEADING = "<h4>Synthetic heading body</h4>";
const SERIALIZER_FALLBACK = '<p contenteditable="false">Synthetic fallback body</p>';
const OVERSIZE = `<p>${"x".repeat(200_000)}</p>`;
/** `new URL` throws inside the decoder: a throw no `fail()` site names. */
const UNCLASSIFIED = '<p><a href="http://[">Synthetic unclassified body</a></p>';

const SEEDS: readonly SeedNote[] = [
  { id: "n-strict", title: "Synthetic strict title", data: STRICT },
  { id: "n-preserved", title: "Synthetic preserved title", data: PRESERVED },
  { id: "n-heading", title: "Synthetic heading title", data: OPAQUE_HEADING },
  { id: "n-fallback", title: "Synthetic fallback title", data: SERIALIZER_FALLBACK },
  { id: "n-hostile", title: "Synthetic hostile title", data: "<script>alert(1)</script>" },
  { id: "n-unclassified", title: "Synthetic unclassified title", data: UNCLASSIFIED },
  // Visible to nothing: browse hides a locked note, so the census must too. Its
  // body would otherwise land in the hostile bucket.
  {
    id: "n-hidden",
    title: "Synthetic hidden title",
    data: "<script>alert(2)</script>",
    locked: true,
  },
  // Hidden the other way: unlocked, but in a notebook whose settings deny
  // `read`. Its body would also land in the hostile bucket.
  { id: "n-denied", title: "Synthetic denied title", data: "<script>alert(3)</script>" },
];
const HIDDEN = ["n-denied", "n-hidden"];

/** The four refusal classes, summed. */
const refused = (reasons: RpcNotesEditCensusResult["reasons"]): number =>
  Object.values(reasons).reduce((sum, value) => sum + value, 0);

afterEach(cleanupSyntheticDaemons);

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

class MemoryFs implements OperationStoreFs {
  readonly files = new Map<string, Uint8Array>();
  async list(limit: number) {
    return [...this.files.keys()].slice(0, limit);
  }
  async read(name: string, limit: number) {
    const bytes = this.files.get(name)!;
    if (bytes.length > limit) throw Error("oversize");
    return bytes.slice();
  }
  async writeExclusive(name: string, bytes: Uint8Array) {
    if (this.files.has(name)) throw Error("exists");
    this.files.set(name, bytes.slice());
  }
  async syncFile() {}
  async rename(from: string, to: string) {
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
  async syncDirectory() {}
  async remove(name: string) {
    this.files.delete(name);
  }
}

/**
 * The operator handler composed as `nookd` composes it: discovery (browse,
 * search, census) over the production visibility filter, plus the operator
 * write runtime and its operation-record store.
 */
async function censusHarness(
  runtime: ServiceRuntime,
  hierarchy: () => Promise<ReadonlyArray<unknown>> = async () => [DENIED_NOTEBOOK],
) {
  const registry = createOperatorHandleRegistry();
  // The synthetic core has no notebooks; give the production filter one, with
  // `n-denied` directly and only in it.
  const visibility = createDiscoveryVisibility({
    source: {
      ...runtime.readOnly!,
      findNoteIdsByNotebook: async (notebookId: string) =>
        Object.keys(NOTEBOOK_OF).filter((id) => NOTEBOOK_OF[id] === notebookId),
      hasNoteInNotebook: async (notebookId: string, noteId: string) =>
        NOTEBOOK_OF[noteId] === notebookId,
    },
    settingsEvaluator: createSettingsEvaluator(SETTINGS, buildNotebookIndex([DENIED_NOTEBOOK])),
    listNotebooksForSettings: hierarchy,
  });
  // Every snapshot the census reads, by note id.
  const snapshotReads: string[] = [];
  const readOnly = {
    ...runtime.readOnly,
    readNoteSnapshot: (id: string) => {
      snapshotReads.push(id);
      return runtime.readOnly.readNoteSnapshot!(id);
    },
  };
  const discovery = createOperatorDiscoveryRuntime(
    { readOnly } as ServiceRuntime,
    registry,
    visibility,
  );
  const fs = new MemoryFs();
  const source = createOperatorWriteSource({
    operatorCreateNote: runtime.operatorCreateNote,
    operatorUpdateNote: runtime.operatorUpdateNote,
    readOnly: runtime.readOnly,
  });
  if (source === undefined) throw new Error("operator write source unavailable");
  const write = createOperatorWriteRuntime({
    source,
    store: await createNotesUndoStore({ fs, daemonKey: new Uint8Array(32).fill(7) }),
    resolveHandle: (handle, peer) => registry.resolve(handle, peer),
    mintHandle: (noteId, peer) => registry.mint(noteId, peer),
  });
  const handler = createOperatorDiscoveryHandler({ ...discovery, ...write });
  return { registry, handler, fs, snapshotReads };
}

/** Every note id `notes.browse` lists, resolved through the handles it minted. */
async function browsedIds(
  handler: Awaited<ReturnType<typeof censusHarness>>["handler"],
  registry: Awaited<ReturnType<typeof censusHarness>>["registry"],
): Promise<string[]> {
  const response = await handler(
    { id: "browse", method: "notes.browse", params: { limit: 100 } } as RpcRequest,
    OPERATOR,
  );
  if (!response.ok) throw new Error("browse refused");
  const page = response.result as unknown as { notes: Array<{ handle: string }> };
  return page.notes.map((note) => registry.resolve(note.handle, OPERATOR)!).sort();
}

async function callCensus(
  handler: Awaited<ReturnType<typeof censusHarness>>["handler"],
  params: object,
) {
  const response = await handler(
    { id: "census", method: "notes.edit-census", params } as RpcRequest,
    OPERATOR,
  );
  if (!response.ok) throw new Error(`census refused: ${JSON.stringify(response)}`);
  // The production serializer accepts the closed result shape.
  expect(() => serializeRpcResponse(response)).not.toThrow();
  return response.result as unknown as RpcNotesEditCensusResult;
}

describe("EA-2 — the census counts the synthetic corpus", () => {
  it("partitions the corpus exactly into the read projections", async () => {
    const { runtime } = await startDaemon(SEEDS);
    const { handler } = await censusHarness(runtime);
    const result = await callCensus(handler, {});

    expect(result.kind).toBe("edit-census");
    expect(result.scope).toBe("corpus");
    expect(result.total).toBe(6);
    expect(result.projection).toEqual({
      strict: 1,
      strictWithPreservedBlocks: 1,
      opaqueHeadingFallback: 1,
      serializerFallback: 3,
      locked: 0,
      oversize: 0,
      unavailable: 0,
    });
    // The reasons partition exactly the refused notes: three serializer
    // fallbacks, each one class, and nothing for a note that decoded.
    expect(result.reasons).toEqual({ hostile: 1, uninterpretable: 1, limit: 0, unclassified: 1 });
    expect(refused(result.reasons)).toBe(
      result.projection.serializerFallback + result.projection.oversize,
    );
    expect(result.editRefusals).toBe(0);
    expect(result.preservedBlocks).toBe(2);
    expect(result.preservedTaskLists).toBe(0);
    expect(result.cap).toBe(MAX_EDIT_CENSUS_NOTES_PER_RUN);
    expect(result.skipped).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("reports unknown visibility as unavailable, never as an empty corpus", async () => {
    const { runtime } = await startDaemon(SEEDS);
    let loadable = true;
    const { handler, snapshotReads } = await censusHarness(runtime, async () => {
      if (!loadable) throw new Error("synthetic hierarchy failure");
      return [DENIED_NOTEBOOK];
    });
    const browse = await handler(
      { id: "browse", method: "notes.browse", params: { limit: 100 } } as RpcRequest,
      OPERATOR,
    );
    if (!browse.ok) throw new Error("browse refused");
    const handle = (browse.result as unknown as { notes: Array<{ handle: string }> }).notes[0]!
      .handle;

    // The hierarchy can no longer be loaded: visibility is unknown.
    loadable = false;
    snapshotReads.length = 0;
    for (const params of [{}, { id: handle }]) {
      const response = await handler(
        { id: "census", method: "notes.edit-census", params } as RpcRequest,
        OPERATOR,
      );
      expect(response, JSON.stringify(params)).toMatchObject({
        ok: false,
        error: { code: "service_unavailable" },
      });
      expect((response as { result?: unknown }).result).toBeUndefined();
    }
    // Nothing was read, and browse still fails closed to an empty page.
    expect(snapshotReads).toEqual([]);
    const closed = await handler(
      { id: "browse", method: "notes.browse", params: { limit: 100 } } as RpcRequest,
      OPERATOR,
    );
    expect(closed).toMatchObject({ ok: true, result: { notes: [] } });
  });

  it("counts only what browse lists: a locked or denied-notebook note is in no bucket", async () => {
    const { runtime } = await startDaemon(SEEDS);
    const { registry, handler, snapshotReads } = await censusHarness(runtime);

    // The production filter hides both from browse: the locked note by its
    // lock, the other by its notebook's `read: false`...
    const visible = await browsedIds(handler, registry);
    for (const id of HIDDEN) expect(visible).not.toContain(id);
    expect(visible).toHaveLength(SEEDS.length - HIDDEN.length);

    // ...and the census counts exactly the browse listing, so neither adds to
    // the total, a projection or a refusal class. Unfiltered it would read
    // total 8, locked 1 and hostile 2 (3 with the locked note unlocked).
    const result = await callCensus(handler, {});
    expect([...new Set(snapshotReads)].sort()).toEqual(visible);
    expect(result.total).toBe(visible.length);
    expect(result.skipped).toBe(0);
    expect(result.projection.locked).toBe(0);
    expect(result.reasons.hostile).toBe(1);
    expect(Object.values(result.projection).reduce((a, b) => a + b, 0)).toBe(visible.length);

    // A handle minted before the note was hidden is refused like a forged one,
    // and the census does not read its snapshot.
    for (const id of HIDDEN) {
      const stale = registry.mint(id, OPERATOR);
      const response = await handler(
        { id: "census", method: "notes.edit-census", params: { id: stale } } as RpcRequest,
        OPERATOR,
      );
      expect(response, id).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(snapshotReads).not.toContain(id);
    }
  });

  it("returns no body, title, raw id or snippet", async () => {
    const { runtime } = await startDaemon(SEEDS);
    const { handler } = await censusHarness(runtime);
    const result = await callCensus(handler, {});
    const wire = JSON.stringify(result);

    for (const forbidden of [
      "Synthetic strict body",
      "Synthetic strict title",
      "Synthetic heading body",
      "Synthetic fallback body",
      "Synthetic hostile title",
      "Synthetic unclassified body",
      "Synthetic hidden title",
      "Synthetic denied title",
      "n-strict",
      "n-preserved",
      "n-heading",
      "n-fallback",
      "n-hostile",
      "n-unclassified",
      "n-hidden",
      "n-denied",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
    // Internal refusal reasons stay internal: only class counts cross the wire.
    for (const reason of ["attr_unrecognised", "forbidden_tag", "internal_failure"]) {
      expect(wire).not.toContain(reason);
    }
  });

  it("scopes to one note and echoes only the opaque handle", async () => {
    const { runtime } = await startDaemon(SEEDS);
    const { registry, handler } = await censusHarness(runtime);
    const handle = registry.mint("n-fallback", OPERATOR);
    const result = await callCensus(handler, { id: handle });
    const wire = JSON.stringify(result);

    expect(result.scope).toBe("note");
    expect(result.note).toBe(handle);
    expect(result.total).toBe(1);
    expect(result.projection.serializerFallback).toBe(1);
    expect(result.reasons).toEqual({ hostile: 0, uninterpretable: 1, limit: 0, unclassified: 0 });
    expect(wire).not.toContain("n-fallback");
    expect(wire).not.toContain("Synthetic fallback body");
  });

  it("refuses an unknown or forged handle as not_found", async () => {
    const { runtime } = await startDaemon(SEEDS);
    const { handler } = await censusHarness(runtime);
    const response = await handler(
      { id: "census", method: "notes.edit-census", params: { id: "h_forged" } } as RpcRequest,
      OPERATOR,
    );
    expect(response).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("EA-2 — the census is read-only", () => {
  it("leaves the pending markers, operation records, note records and read projections unchanged", async () => {
    // The coordinator loads its persisted queue through this store at startup;
    // capturing the instance lets the test read the durable marker set itself.
    const load = vi.spyOn(PersistentSyncMetadataStateStore.prototype, "load");
    const { runtime, core } = await startDaemon(SEEDS);
    const markerStore = load.mock.contexts[0] as PersistentSyncMetadataStateStore;
    load.mockRestore();
    expect(markerStore).toBeInstanceOf(PersistentSyncMetadataStateStore);
    const { handler, fs } = await censusHarness(runtime);
    const policy = createReadWriteNoDeleteServicePolicy();

    // Give both stores something to lose: one MCP write queues a pending
    // marker, one operator create writes an operation record.
    const mcpCreate = await handleRpcRequest(
      {
        id: "seed-write",
        method: "notes.create",
        params: { title: "Synthetic queued title", content: "synthetic queued body" },
      } as RpcRequest,
      runtime,
      policy,
    );
    expect(mcpCreate.ok, JSON.stringify(mcpCreate)).toBe(true);
    const operatorCreate = await handler(
      {
        id: "seed-operation",
        method: "notes.create",
        params: { title: "Synthetic operator title", content: "synthetic operator body" },
      } as RpcRequest,
      OPERATOR,
    );
    expect(operatorCreate.ok, JSON.stringify(operatorCreate)).toBe(true);

    const markers = () => JSON.stringify(markerStore.load());
    const records = () =>
      JSON.stringify(
        [...fs.files].map(([name, bytes]) => [name, Buffer.from(bytes).toString("base64")]),
      );
    const markersBefore = markers();
    const recordsBefore = records();
    expect((JSON.parse(markersBefore) as { pending: unknown[] }).pending.length).toBeGreaterThan(0);
    expect(fs.files.size).toBeGreaterThan(0);

    const noteBefore = new Map([...core.notes].map(([id, note]) => [id, { ...note }]));
    const unsyncedBefore = core.state.unsynced;
    const fullRunsBefore = core.state.fullRuns;
    const projectionsBefore = new Map<string, unknown>();
    for (const id of noteBefore.keys()) {
      const response = await handleRpcRequest(
        { id: "before", method: "notes.get", params: { id } } as RpcRequest,
        runtime,
        policy,
      );
      projectionsBefore.set(id, response);
    }

    const first = await callCensus(handler, {});
    const second = await callCensus(handler, {});

    // Observed, not inferred: the durable marker set and every operation-record
    // byte are identical, so a census that queued a marker or wrote, moved or
    // removed a record fails here.
    expect(markers()).toBe(markersBefore);
    expect(records()).toBe(recordsBefore);

    expect(core.notes.size).toBe(noteBefore.size);
    for (const [id, before] of noteBefore) {
      expect(core.notes.get(id)).toEqual(before);
      const response = await handleRpcRequest(
        { id: "after", method: "notes.get", params: { id } } as RpcRequest,
        runtime,
        policy,
      );
      const projection = projectionsBefore.get(id) as { result?: unknown };
      expect(response).toEqual({ ...(projection as object), id: "after" });
    }
    expect(core.state.unsynced).toBe(unsyncedBefore);
    // A census starts no sync: the synthetic syncer counts every full run.
    expect(core.state.fullRuns).toBe(fullRunsBefore);
    // Idempotent: running the census cannot change a projection outcome.
    expect(second).toEqual(first);
  });

  it("classifies locked, oversize and unavailable through the source seam", async () => {
    // The same snapshot shape the production projection returns. A 300 KB body
    // clears the read adapter in the fake but is oversize for the decoder. The
    // locked note is listed as visible but its snapshot refuses the body: the
    // race in which a note is locked between the listing and the read.
    const revision = `rev_${"0".repeat(32)}`;
    const census = createNotesEditCensus({
      listVisibleNotes: async () => [
        { id: "n-locked" },
        { id: "n-oversize" },
        { id: "n-unclassified" },
        { id: "n-unavailable" },
      ],
      readNoteSnapshot: async (id) => {
        if (id === "n-locked") {
          return {
            metadata: { id, locked: true, revision },
            contentRefusal: "locked" as const,
          };
        }
        if (id === "n-oversize") {
          return {
            metadata: { id, locked: false, revision },
            content: { type: "tiptap" as const, data: OVERSIZE },
          };
        }
        if (id === "n-unclassified") {
          return {
            metadata: { id, locked: false, revision },
            content: { type: "tiptap" as const, data: UNCLASSIFIED },
          };
        }
        return undefined;
      },
    });
    const result = await census.corpus();
    expect(result.total).toBe(4);
    expect(result.projection.locked).toBe(1);
    expect(result.projection.oversize).toBe(1);
    expect(result.projection.serializerFallback).toBe(1);
    expect(result.projection.unavailable).toBe(1);
    // The oversized block trips the document validator's inline bound: a
    // limit. The URL parser throw is named by no site: unclassified, never
    // uninterpretable. The four classes add up to the refused notes.
    expect(result.reasons).toEqual({ hostile: 0, uninterpretable: 0, limit: 1, unclassified: 1 });
    expect(refused(result.reasons)).toBe(
      result.projection.serializerFallback + result.projection.oversize,
    );
  });

  it("keeps the refusal reason when the read-only fallback cannot render the note either", async () => {
    // The decoder refuses the envelope shape; the fallback accepts only html or
    // tiptap, so it throws as well and the note is unavailable. The refusal
    // must still be counted.
    const census = createNotesEditCensus({
      listVisibleNotes: async () => [{ id: "n-shape" }],
      readNoteSnapshot: async (id) => ({
        metadata: { id, locked: false, revision: `rev_${"0".repeat(32)}` },
        content: { type: "json", data: "<p>x</p>" },
      }),
    });
    const result = await census.corpus();
    expect(result.projection.unavailable).toBe(1);
    expect(result.reasons).toEqual({ hostile: 0, uninterpretable: 1, limit: 0, unclassified: 0 });
    expect(() => serializeRpcResponse({ id: "r", ok: true, result } as never)).not.toThrow();
  });
});

describe("EA-2 — a scoped census decides visibility for the named note", () => {
  // Live finding: a note `search` and `notes.get` both served was reported
  // `missing` by the scoped census, because the census only looked for it in
  // the listing, and the listing is not the whole corpus.
  const HANDLE = `h_${"a".repeat(24)}`;

  it("measures a note the caller can name even when the listing omits it", async () => {
    const census = createNotesEditCensus({
      listVisibleNotes: async () => [],
      isNoteVisible: async () => true,
      readNoteSnapshot: async (id) => ({
        metadata: { id, locked: false, revision: `rev_${"0".repeat(32)}` },
        content: { type: "tiptap" as const, data: STRICT },
      }),
    });
    const result = await census.note("n-unlisted", HANDLE);
    expect(result?.scope).toBe("note");
    expect(result?.note).toBe(HANDLE);
    expect(result?.total).toBe(1);
    expect(result?.projection.strict).toBe(1);
  });

  it("reports unknown visibility as unavailable rather than as a missing note", async () => {
    const census = createNotesEditCensus({
      listVisibleNotes: async () => [],
      isNoteVisible: async () => undefined,
      readNoteSnapshot: async () => {
        throw new Error("a snapshot must not be read for an undecided note");
      },
    });
    await expect(census.note("n-unknown", HANDLE)).rejects.toBeInstanceOf(
      NotesEditCensusUnavailableError,
    );
  });

  it("still reports a hidden note as missing, without reading it", async () => {
    const census = createNotesEditCensus({
      listVisibleNotes: async () => [{ id: "n-hidden" }],
      isNoteVisible: async () => false,
      readNoteSnapshot: async () => {
        throw new Error("a snapshot must not be read for a hidden note");
      },
    });
    await expect(census.note("n-hidden", HANDLE)).resolves.toBeUndefined();
  });

  it("falls back to the listing when the source has no per-note check", async () => {
    const census = createNotesEditCensus({
      listVisibleNotes: async () => [{ id: "n-listed" }],
      readNoteSnapshot: async (id) => ({
        metadata: { id, locked: false, revision: `rev_${"0".repeat(32)}` },
        content: { type: "tiptap" as const, data: STRICT },
      }),
    });
    await expect(census.note("n-absent", HANDLE)).resolves.toBeUndefined();
    await expect(census.note("n-listed", HANDLE)).resolves.toMatchObject({ total: 1 });
  });
});

describe("EA-2 — the census is capped per run", () => {
  it("decodes at most the cap, in listing order, and reports the rest as skipped", async () => {
    expect(MAX_EDIT_CENSUS_NOTES_PER_RUN).toBe(500);
    const extra = 3;
    const listed = Array.from({ length: MAX_EDIT_CENSUS_NOTES_PER_RUN + extra }, (_, i) => ({
      id: `n-${i}`,
    }));
    const reads: string[] = [];
    const census = createNotesEditCensus({
      listVisibleNotes: async () => listed,
      readNoteSnapshot: async (id) => {
        reads.push(id);
        return {
          metadata: { id, locked: false, revision: `rev_${"0".repeat(32)}` },
          content: { type: "tiptap" as const, data: STRICT },
        };
      },
    });
    const result = await census.corpus();

    expect(result.cap).toBe(MAX_EDIT_CENSUS_NOTES_PER_RUN);
    expect(result.total).toBe(MAX_EDIT_CENSUS_NOTES_PER_RUN);
    expect(result.skipped).toBe(extra);
    // The result says so: the later notes in listing order were not measured.
    expect(result.truncated).toBe(true);
    expect(result.projection.strict).toBe(MAX_EDIT_CENSUS_NOTES_PER_RUN);
    // The skipped notes are never read, let alone decoded.
    expect(reads).toEqual(listed.slice(0, MAX_EDIT_CENSUS_NOTES_PER_RUN).map((n) => n.id));
    expect(() => serializeRpcResponse({ id: "r", ok: true, result } as never)).not.toThrow();
  });
});

describe("EA-2 — the reasons bucket counts only refusal reasons", () => {
  it("a Markdown failure after a clean decode is a serializer fallback with no reason", async () => {
    const MARKDOWN = "../src/core/note-document-markdown.js";
    vi.resetModules();
    vi.doMock(MARKDOWN, async (importOriginal) => ({
      ...(await importOriginal<typeof NoteDocumentMarkdownModule>()),
      serializeNoteDocumentMarkdown: () => {
        throw new Error("synthetic Markdown failure");
      },
    }));
    try {
      const { createNotesEditCensus: fresh } = (await import(
        "../src/service/notes-edit-census.js"
      )) as typeof NotesEditCensusModule;
      const census = fresh({
        listVisibleNotes: async () => [{ id: "n-strict" }, { id: "n-preserved" }],
        readNoteSnapshot: async (id) => ({
          metadata: { id, locked: false, revision: `rev_${"0".repeat(32)}` },
          content: { type: "tiptap" as const, data: id === "n-preserved" ? PRESERVED : STRICT },
        }),
      });
      const result = await census.corpus();
      expect(result.projection.serializerFallback).toBe(2);
      expect(result.reasons).toEqual({ hostile: 0, uninterpretable: 0, limit: 0, unclassified: 0 });
      // `n-preserved` decoded with one preserved block, then fell back: the
      // preserved counts cover only the preserving outcomes, so it adds none.
      expect(result.preservedBlocks).toBe(0);
      expect(result.preservedTaskLists).toBe(0);
    } finally {
      vi.doUnmock(MARKDOWN);
      vi.resetModules();
    }
  });

  it("an edit refusal is counted on its own, never as a decode class", async () => {
    const NATIVE = "../src/core/note-document-native.js";
    vi.resetModules();
    vi.doMock(NATIVE, async (importOriginal) => {
      const actual = await importOriginal<typeof NoteDocumentNativeModule>();
      return {
        ...actual,
        decodeNoteDocumentNative: () => {
          throw new actual.NoteDocumentNativeError("context_references_mismatch");
        },
      };
    });
    try {
      const { createNotesEditCensus: fresh } = (await import(
        "../src/service/notes-edit-census.js"
      )) as typeof NotesEditCensusModule;
      const census = fresh({
        listVisibleNotes: async () => [{ id: "n-strict" }],
        readNoteSnapshot: async (id) => ({
          metadata: { id, locked: false, revision: `rev_${"0".repeat(32)}` },
          content: { type: "tiptap" as const, data: STRICT },
        }),
      });
      const result = await census.corpus();
      expect(result.editRefusals).toBe(1);
      expect(result.reasons).toEqual({ hostile: 0, uninterpretable: 0, limit: 0, unclassified: 0 });
      expect(() => serializeRpcResponse({ id: "r", ok: true, result } as never)).not.toThrow();
    } finally {
      vi.doUnmock(NATIVE);
      vi.resetModules();
    }
  });

  it("the wire refuses more refusal reasons than refused projections", () => {
    const base = {
      kind: "edit-census",
      scope: "corpus",
      total: 2,
      reasons: { hostile: 1, uninterpretable: 0, limit: 0, unclassified: 0 },
      editRefusals: 0,
      cap: MAX_EDIT_CENSUS_NOTES_PER_RUN,
      skipped: 0,
      truncated: false,
      projection: {
        strict: 1,
        strictWithPreservedBlocks: 0,
        opaqueHeadingFallback: 0,
        serializerFallback: 1,
        locked: 0,
        oversize: 0,
        unavailable: 0,
      },
      preservedBlocks: 0,
      preservedTaskLists: 0,
    };
    const envelope = (result: object) => ({ id: "r", ok: true, result }) as never;
    expect(() => serializeRpcResponse(envelope(base))).not.toThrow();
    expect(() =>
      serializeRpcResponse(envelope({ ...base, reasons: { ...base.reasons, unclassified: 1 } })),
    ).toThrow();
    // An edit refusal is a refused note too: it cannot exceed them either.
    expect(() => serializeRpcResponse(envelope({ ...base, editRefusals: 1 }))).toThrow();
    // The cap is in the result and bounds the count.
    expect(() => serializeRpcResponse(envelope({ ...base, cap: 1 }))).toThrow();
    expect(() =>
      serializeRpcResponse(envelope({ ...base, skipped: 1, truncated: true })),
    ).toThrow();
    expect(() =>
      serializeRpcResponse(envelope({ ...base, cap: 2, skipped: 1, truncated: true })),
    ).not.toThrow();
    const { cap: _cap, ...uncapped } = base;
    expect(() => serializeRpcResponse(envelope(uncapped))).toThrow();
    // `truncated` states the skip; it can neither hide one nor invent one.
    expect(() => serializeRpcResponse(envelope({ ...base, cap: 2, skipped: 1 }))).toThrow();
    expect(() => serializeRpcResponse(envelope({ ...base, truncated: true }))).toThrow();
    const { truncated: _truncated, ...unstated } = base;
    expect(() => serializeRpcResponse(envelope(unstated))).toThrow();
  });
});

describe("EA-2 — the census is RPC-invisible", () => {
  it("is refused by the daemon handler exactly like an unknown method", async () => {
    const { runtime } = await startDaemon(SEEDS);
    const policy = createReadWriteNoDeleteServicePolicy();
    const operator = await handleRpcRequest(
      { id: "r", method: "notes.edit-census", params: {} } as RpcRequest,
      runtime,
      policy,
    );
    const unknown = await handleRpcRequest(
      { id: "r", method: "notes.definitely-not-a-method", params: {} } as unknown as RpcRequest,
      runtime,
      policy,
    );

    expect(operator).toEqual(unknown);
    expect(operator).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect((operator as { result?: unknown }).result).toBeUndefined();
  });

  it("is admitted by the operator parser and refused on the daemon socket allowlist", () => {
    // The shared parser admits the literal so the operator listener can route it.
    const parsed = parseRpcFrame(
      frame({ id: "r", method: "notes.edit-census", params: { id: "h_abcdefghijklmnop" } }),
    );
    expect(parsed.method).toBe("notes.edit-census");

    // The daemon handler's structural allowlist is the closed set that does NOT
    // contain it; the connection-level `isOperatorOnlyMethod` refusal follows
    // from membership in OPERATOR_METHODS (pinned by the T10 non-regression).
    expect(() =>
      parseRpcFrame(frame({ id: "r", method: "notes.edit-census", params: { extra: 1 } })),
    ).toThrow();
  });
});
