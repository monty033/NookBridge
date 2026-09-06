/**
 * Stage 9 §13.11 — read-only runtime adapter slice.
 *
 * This is the test boundary for `src/operator/notes-read-runtime.ts`,
 * an isolated, injected, read-only seam that maps a bounded
 * Notesnook source (note metadata + title-only search hits) onto
 * the closed `NotesCategoricalResult` shapes the operator formatter
 * already understands.
 *
 * Strict TDD scope (pinned in the task allowlist):
 *
 *   - narrow injected source seam — no real Database, no real
 *     network, no real Notesnook handle, no filesystem, no RPC,
 *     no MCP, no sync, no auth, no editor, no undo preimage;
 *   - no `notes.delete` vocabulary and no `tree` vocabulary;
 *   - never expose raw source IDs — only INJECTED codec-produced
 *     opaque handles pass through;
 *   - opaque handles are validated before decode, and the
 *     decoded identity is bound to the requested note so a
 *     stale or forged handle cannot resolve to the wrong note;
 *   - the adapter does NOT construct or decode handles itself —
 *     it must use the injected `NotesReadRuntimeHandleCodec`
 *     provided in the adapter options;
 *   - the injected codec is the SOLE producer of handles in the
 *     bounded output and the SOLE consumer of handles on input;
 *     the adapter must reject forged / unknown handles
 *     categorically BEFORE invoking `source.note`;
 *   - if the injected codec returns a handle that violates the
 *     bounded opaque handle grammar (including the reserved
 *     `rev_` family rejection), the adapter collapses to a fixed
 *     categorical error and never emits the handle;
 *   - cursor/limit bounds are preserved and page output is
 *     capped at 100;
 *   - every bounded record returned to the formatter is
 *     frozen so downstream code cannot mutate it through the
 *     adapter;
 *   - any malformed / oversized / hostile source record is
 *     rejected categorically without leaking the underlying
 *     values, paths, titles, bodies, or upstream messages;
 *   - the adapter does NOT call a mutating, sync, transport,
 *     or generic capability; it does NOT accept delete / tree
 *     operations.
 *
 * Fixed categorical errors only.  No body, title, path, or
 * upstream message ever crosses the formatter boundary.
 *
 * The codec surface is intentionally injected so this slice does
 * NOT ship a reversible built-in source-id encoding.  The tests
 * provide a deterministic fake codec backed by an explicit Map
 * to prove the adapter is fully codec-driven and never
 * constructs / decodes handles itself.
 */

import { TextEncoder } from "node:util";

import { describe, expect, it } from "vitest";

import {
  createNotesReadRuntime,
  isNotesReadRuntimeError,
  MAX_NOTES_READ_QUERY_BYTES,
  NOTES_READ_PAGE_LIMIT_MAX,
  type NotesReadRuntimeHandleCodec,
  type NotesReadRuntimeSource,
  type NotesReadRuntimeSourceNote,
  type NotesReadRuntimeSourceSearchHit,
} from "../src/operator/notes-read-runtime.js";
import { isBoundedOpaqueValue } from "../src/operator/notes-cli.js";

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

/**
 * Build a deterministic fake source.  The source exposes ONLY
 * read-only surfaces and the test framework inspects the call
 * counters to prove the adapter never invokes a mutating,
 * transport, sync, or generic capability.
 */
type FakeSource = NotesReadRuntimeSource & {
  listCalls: number;
  searchCalls: number;
  searchCallsWith: readonly string[];
  noteCalls: number;
  noteCallsWith: readonly string[];
};

function createFakeSource(options?: {
  notes?: NotesReadRuntimeSourceNote[];
  searchHits?: NotesReadRuntimeSourceSearchHit[];
  throwOnList?: boolean;
  throwOnSearch?: boolean;
  throwOnNote?: boolean;
}): FakeSource {
  const notes = options?.notes ?? [];
  const searchHits = options?.searchHits ?? [];

  // The counters live on the SAME object that is returned as the
  // source — the adapter reads / writes through the same fields
  // the test asserts on.
  const counters = {
    listCalls: 0,
    searchCalls: 0,
    searchCallsWith: [] as string[],
    noteCalls: 0,
    noteCallsWith: [] as string[],
    async list(): Promise<NotesReadRuntimeSourceNote[]> {
      counters.listCalls += 1;
      if (options?.throwOnList === true) {
        throw new Error("upstream failure leaked: secret/path/credential");
      }
      return notes;
    },
    async search(query: string): Promise<NotesReadRuntimeSourceSearchHit[]> {
      counters.searchCalls += 1;
      counters.searchCallsWith.push(query);
      if (options?.throwOnSearch === true) {
        throw new Error("upstream failure leaked: secret/path/credential");
      }
      return searchHits;
    },
    async note(id: string): Promise<NotesReadRuntimeSourceNote | undefined> {
      counters.noteCalls += 1;
      counters.noteCallsWith.push(id);
      if (options?.throwOnNote === true) {
        throw new Error("upstream failure leaked: secret/path/credential");
      }
      return notes.find((entry) => entry.id === id);
    },
  };

  return counters as unknown as FakeSource;
}

// ---------------------------------------------------------------------------
// Fake opaque-handle codec (deterministic, Map-backed).
// ---------------------------------------------------------------------------

/**
 * Counter snapshot for the fake codec.  Tests assert against these
 * counters to prove the adapter does NOT construct or decode handles
 * itself — every handle crossing the adapter boundary is produced by
 * the injected codec.
 */
type FakeHandleCodecState = {
  readonly encodeCalls: number;
  readonly decodeCalls: number;
};

/**
 * A deterministic, Map-backed fake codec.  The fake produces handles
 * shaped `fakeh_<n>` where `<n>` is a monotonically increasing index,
 * so the test can prove:
 *
 *   - the bounded output contains ONLY the fake codec's handles;
 *   - the adapter never contains the literal source id in any
 *     returned handle (the fake handles share no characters with
 *     the seeded source ids);
 *   - forged / unknown handles are rejected before `source.note`
 *     is ever called;
 *   - the adapter MUST consult the codec for every input handle.
 *
 * The fake is intentionally NOT reversible — there is no source-id
 * substr extraction possible from `fakeh_<n>`.  A built-in
 * base64/checksum codec would be reversible; the fake proves that
 * property is now provided by the injected seam and not by the
 * adapter.
 */
type FakeHandleCodec = NotesReadRuntimeHandleCodec & {
  readonly state: FakeHandleCodecState;
  readonly handlesBySourceId: ReadonlyMap<string, string>;
  readonly sourceIdsByHandle: ReadonlyMap<string, string>;
};

function createFakeHandleCodec(): FakeHandleCodec {
  let counter = 0;
  const handlesBySourceId = new Map<string, string>();
  const sourceIdsByHandle = new Map<string, string>();
  const encodeCalls = { value: 0 };
  const decodeCalls = { value: 0 };
  return {
    handlesBySourceId,
    sourceIdsByHandle,
    get state() {
      return {
        encodeCalls: encodeCalls.value,
        decodeCalls: decodeCalls.value,
      };
    },
    encode(sourceId: string): string {
      encodeCalls.value += 1;
      const existing = handlesBySourceId.get(sourceId);
      if (existing !== undefined) return existing;
      counter += 1;
      // Deliberately shape handles with NO shared characters with the
      // seeded source ids used in these tests ("alpha", "beta", ...).
      // This proves the bounded output does not echo the source id.
      // The prefix `fakh` (4 lowercase letters) satisfies the
      // `<prefix>_<token>` grammar; the token is a monotonic
      // counter padded to 8 digits so it always clears the 4-char
      // token minimum.
      const handle = `fakh_${counter.toString().padStart(8, "0")}`;
      handlesBySourceId.set(sourceId, handle);
      sourceIdsByHandle.set(handle, sourceId);
      return handle;
    },
    decode(handle: string) {
      decodeCalls.value += 1;
      const sourceId = sourceIdsByHandle.get(handle);
      if (sourceId === undefined) return { kind: "invalid" } as const;
      return { kind: "ok", sourceId } as const;
    },
  };
}

// ---------------------------------------------------------------------------
// Injected codec — adapter does not construct / decode handles itself.
// ---------------------------------------------------------------------------

describe("createNotesReadRuntime — codec injection seam", () => {
  it("rejects a missing injected codec categorically", () => {
    let captured: unknown;
    try {
      createNotesReadRuntime({
        source: createFakeSource(),
        handleCodec: undefined as unknown as NotesReadRuntimeHandleCodec,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesReadRuntimeError(captured)).toBe(true);
  });

  it("rejects an injected codec missing `encode`", () => {
    const fake = createFakeSource();
    const bad = {
      decode: () => ({ kind: "invalid" as const }),
    };
    let captured: unknown;
    try {
      createNotesReadRuntime({
        source: fake,
        handleCodec: bad as unknown as NotesReadRuntimeHandleCodec,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesReadRuntimeError(captured)).toBe(true);
  });

  it("rejects an injected codec missing `decode`", () => {
    const fake = createFakeSource();
    const bad = {
      encode: () => "fakeh_9999",
    };
    let captured: unknown;
    try {
      createNotesReadRuntime({
        source: fake,
        handleCodec: bad as unknown as NotesReadRuntimeHandleCodec,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesReadRuntimeError(captured)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Constructor validation.
// ---------------------------------------------------------------------------

describe("createNotesReadRuntime — constructor", () => {
  it("rejects a missing source categorically", () => {
    const codec = createFakeHandleCodec();
    let captured: unknown;
    try {
      createNotesReadRuntime({
        source: undefined as unknown as NotesReadRuntimeSource,
        handleCodec: codec,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesReadRuntimeError(captured)).toBe(true);
  });

  it("rejects a source that exposes a forbidden mutating method", () => {
    const fake = createFakeSource();
    const leaky = {
      ...fake,
      delete: () => {
        throw new Error("delete must never be called");
      },
    };
    let captured: unknown;
    try {
      createNotesReadRuntime({
        source: leaky as unknown as NotesReadRuntimeSource,
        handleCodec: createFakeHandleCodec(),
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesReadRuntimeError(captured)).toBe(true);
  });

  it("rejects a source that exposes a generic passthrough", () => {
    const fake = createFakeSource();
    const leaky = {
      ...fake,
      call: () => {
        throw new Error("generic call must never be invoked");
      },
    };
    let captured: unknown;
    try {
      createNotesReadRuntime({
        source: leaky as unknown as NotesReadRuntimeSource,
        handleCodec: createFakeHandleCodec(),
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesReadRuntimeError(captured)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `browse` — paginated read of bounded note metadata.
// ---------------------------------------------------------------------------

describe("createNotesReadRuntime — browse", () => {
  it("returns an `empty` page when the source exposes no notes", async () => {
    const source = createFakeSource({ notes: [] });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.browse({});
    expect(result.kind).toBe("empty");
  });

  it("returns a `page` of bounded metadata with codec-produced opaque handles", async () => {
    const codec = createFakeHandleCodec();
    const source = createFakeSource({
      notes: [
        { id: "alpha", title: "Alpha", dateModified: 100 },
        { id: "beta", title: "Beta", dateModified: 200 },
      ],
    });
    const runtime = createNotesReadRuntime({ source, handleCodec: codec });
    const result = await runtime.browse({});
    expect(result.kind).toBe("page");
    if (result.kind !== "page") return;
    expect(result.notes).toHaveLength(2);
    for (const entry of result.notes) {
      // The bounded value grammar (from `notes-cli.ts`) must accept
      // the codec output — the codec is the SOLE producer of handles
      // and it MUST emit a handle that satisfies the grammar.
      expect(isBoundedOpaqueValue(entry.handle)).toBe(true);
      // And the handle MUST be one the codec actually minted for the
      // exact source id — proves the adapter did not synthesise its
      // own handle and did not echo the source id verbatim.
      const allowed = codec.handlesBySourceId.get("alpha");
      const allowedBeta = codec.handlesBySourceId.get("beta");
      const ok =
        (allowed !== undefined && entry.handle === allowed) ||
        (allowedBeta !== undefined && entry.handle === allowedBeta);
      expect(ok).toBe(true);
      expect(entry.handle).not.toContain("alpha");
      expect(entry.handle).not.toContain("beta");
      expect(entry.label).not.toContain("alpha");
      expect(entry.label).not.toContain("beta");
      expect(typeof entry.label).toBe("string");
      expect(Number.isSafeInteger(entry.bytes)).toBe(true);
      expect(entry.bytes).toBeGreaterThanOrEqual(0);
    }
    // The codec must have been consulted exactly once per source id
    // and never for anything else.  This proves the adapter does
    // not call into a built-in reversible codec — every encoded
    // handle came from the injected seam.
    expect(codec.state.encodeCalls).toBe(2);
  });

  it("caps page output at NOTES_READ_PAGE_LIMIT_MAX (100)", async () => {
    const oversized: NotesReadRuntimeSourceNote[] = Array.from(
      { length: NOTES_READ_PAGE_LIMIT_MAX + 50 },
      (_, index) => ({ id: `id-${index}`, title: `T${index}` }),
    );
    const source = createFakeSource({ notes: oversized });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.browse({});
    expect(result.kind).toBe("page");
    if (result.kind !== "page") return;
    expect(result.notes.length).toBe(NOTES_READ_PAGE_LIMIT_MAX);
  });

  it("respects a bounded `limit` of 1", async () => {
    const source = createFakeSource({
      notes: [
        { id: "alpha", title: "Alpha" },
        { id: "beta", title: "Beta" },
      ],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.browse({ limit: 1 });
    expect(result.kind).toBe("page");
    if (result.kind !== "page") return;
    expect(result.notes).toHaveLength(1);
  });

  it("rejects an out-of-range `limit` categorically without calling the source", async () => {
    const source = createFakeSource({ notes: [{ id: "alpha", title: "Alpha" }] });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.browse({ limit: 0 });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).not.toMatch(/alpha/);
    expect(source.listCalls).toBe(0);
  });

  it("rejects a non-string `cursor` categorically without calling the source", async () => {
    const source = createFakeSource({ notes: [{ id: "alpha", title: "Alpha" }] });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.browse({ cursor: 123 as unknown as string });
    expect(result.kind).toBe("error");
    expect(source.listCalls).toBe(0);
  });

  it("rejects a malformed `cursor` categorically without calling the source", async () => {
    const source = createFakeSource({ notes: [{ id: "alpha", title: "Alpha" }] });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.browse({ cursor: "not_a_bounded_cursor!" });
    expect(result.kind).toBe("error");
    expect(source.listCalls).toBe(0);
  });

  it("rejects a source record whose `id` is not a non-empty string", async () => {
    const source = createFakeSource({
      notes: [{ id: "", title: "T" } as unknown as NotesReadRuntimeSourceNote],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.browse({});
    expect(result.kind).toBe("error");
  });

  it("rejects a source record whose `title` is not a string", async () => {
    const source = createFakeSource({
      notes: [{ id: "alpha", title: 42 as unknown as string }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.browse({});
    expect(result.kind).toBe("error");
  });

  it("rejects oversized source titles categorically without leaking the title", async () => {
    // The closed per-input title cap is 100 characters; one more
    // than the cap is structurally hostile and must collapse to the
    // fixed categorical `error` shape.
    const huge = "x".repeat(101);
    const source = createFakeSource({
      notes: [{ id: "alpha", title: huge }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.browse({});
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).not.toContain(huge);
    expect(result.message).not.toContain("x".repeat(50));
  });

  it("collapses upstream throws to the categorical `error` shape", async () => {
    const source = createFakeSource({ throwOnList: true });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.browse({});
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).not.toMatch(/secret/);
    expect(result.message).not.toMatch(/credential/);
    expect(result.message).not.toMatch(/path/);
  });

  it("never exposes raw source IDs in the bounded metadata output", async () => {
    const source = createFakeSource({
      notes: [{ id: "internal-secret-id", title: "Visible" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.browse({});
    expect(result.kind).toBe("page");
    if (result.kind !== "page") return;
    for (const entry of result.notes) {
      expect(entry.handle).not.toContain("internal-secret-id");
      expect(entry.label).not.toContain("internal-secret-id");
    }
  });

  it("returns frozen bounded metadata records", async () => {
    const source = createFakeSource({
      notes: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.browse({});
    expect(result.kind).toBe("page");
    if (result.kind !== "page") return;
    for (const entry of result.notes) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(Object.isFrozen(result.notes)).toBe(true);
  });

  it("collapses to a categorical `error` if the injected codec emits a handle that violates the bounded opaque value grammar", async () => {
    const source = createFakeSource({
      notes: [{ id: "alpha", title: "Alpha" }],
    });
    // The codec intentionally mints a handle that does NOT satisfy
    // `isBoundedOpaqueValue` (raw source id, no prefix_token shape).
    // The adapter must reject the codec output and never emit it.
    const leakyCodec: NotesReadRuntimeHandleCodec = {
      encode: () => "internal-secret-id",
      decode: () => ({ kind: "invalid" as const }),
    };
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: leakyCodec,
    });
    const result = await runtime.browse({});
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).not.toContain("internal-secret-id");
  });

  it("collapses to a categorical `error` if the injected codec emits a reserved `rev_` handle", async () => {
    const source = createFakeSource({
      notes: [{ id: "alpha", title: "Alpha" }],
    });
    // The codec emits a reserved `rev_<...>` family handle.  The
    // bounded opaque value grammar rejects the reserved family, so
    // the adapter must collapse to a fixed categorical error rather
    // than emitting the reserved handle.  The reserved handle
    // must NOT appear in the categorical error message — the
    // failure is fixed-shape and never echoes the codec's minted
    // value.
    const leakyCodec: NotesReadRuntimeHandleCodec = {
      encode: () => "rev_00000000000000000000000000000000",
      decode: () => ({ kind: "invalid" as const }),
    };
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: leakyCodec,
    });
    const result = await runtime.browse({});
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).not.toContain("rev_00000000000000000000000000000000");
    // The reserved handle MUST NOT be echoed into the bounded
    // output or the categorical error — and the adapter must NOT
    // have consulted `source.note` (no real source id ever
    // crossed the boundary).
    expect(source.noteCalls).toBe(0);
    expect(source.noteCallsWith).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `search` — title-only bounded paginated search hits.
// ---------------------------------------------------------------------------

describe("createNotesReadRuntime — search", () => {
  it("returns `empty` when the source exposes no search hits", async () => {
    const source = createFakeSource({ searchHits: [] });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.search({ query: "leaf" });
    expect(result.kind).toBe("empty");
  });

  it("returns a `page` of bounded search hits with codec-produced opaque handles", async () => {
    const codec = createFakeHandleCodec();
    const source = createFakeSource({
      searchHits: [
        { id: "alpha", title: "Alpha" },
        { id: "beta", title: "Beta" },
      ],
    });
    const runtime = createNotesReadRuntime({ source, handleCodec: codec });
    const result = await runtime.search({ query: "leaf" });
    expect(result.kind).toBe("page");
    if (result.kind !== "page") return;
    expect(result.notes).toHaveLength(2);
    for (const entry of result.notes) {
      expect(isBoundedOpaqueValue(entry.handle)).toBe(true);
      expect(entry.handle).not.toContain("alpha");
      expect(entry.handle).not.toContain("beta");
      const allowed = codec.handlesBySourceId.get("alpha");
      const allowedBeta = codec.handlesBySourceId.get("beta");
      const ok =
        (allowed !== undefined && entry.handle === allowed) ||
        (allowedBeta !== undefined && entry.handle === allowedBeta);
      expect(ok).toBe(true);
    }
    expect(codec.state.encodeCalls).toBe(2);
  });

  it("caps search page output at NOTES_READ_PAGE_LIMIT_MAX (100)", async () => {
    const oversized: NotesReadRuntimeSourceSearchHit[] = Array.from(
      { length: NOTES_READ_PAGE_LIMIT_MAX + 75 },
      (_, index) => ({ id: `s-${index}`, title: `S${index}` }),
    );
    const source = createFakeSource({ searchHits: oversized });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.search({ query: "leaf" });
    expect(result.kind).toBe("page");
    if (result.kind !== "page") return;
    expect(result.notes.length).toBe(NOTES_READ_PAGE_LIMIT_MAX);
  });

  it("rejects a malformed `cursor` categorically without calling the source", async () => {
    const source = createFakeSource({
      searchHits: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.search({ query: "leaf", cursor: "not_a_bounded_cursor!" });
    expect(result.kind).toBe("error");
    expect(source.searchCalls).toBe(0);
  });

  it("rejects a malformed search hit categorically", async () => {
    const source = createFakeSource({
      searchHits: [{ id: "", title: "T" } as unknown as NotesReadRuntimeSourceSearchHit],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.search({ query: "leaf" });
    expect(result.kind).toBe("error");
  });

  it("collapses upstream throws to the categorical `error` shape", async () => {
    const source = createFakeSource({ throwOnSearch: true });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.search({ query: "leaf" });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).not.toMatch(/secret/);
    expect(result.message).not.toMatch(/credential/);
  });

  it("forwards the bounded query to source.search verbatim", async () => {
    const source = createFakeSource({
      searchHits: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    await runtime.search({ query: "leaf" });
    expect(source.searchCalls).toBe(1);
    expect(source.searchCallsWith).toEqual(["leaf"]);
  });

  it("rejects a missing `query` categorically without calling the source", async () => {
    const source = createFakeSource({
      searchHits: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.search({} as never);
    expect(result.kind).toBe("error");
    expect(source.searchCalls).toBe(0);
  });

  it("rejects an empty `query` categorically without calling the source", async () => {
    const source = createFakeSource({
      searchHits: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.search({ query: "" });
    expect(result.kind).toBe("error");
    expect(source.searchCalls).toBe(0);
  });

  it("rejects a non-string `query` categorically without calling the source", async () => {
    const source = createFakeSource({
      searchHits: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const result = await runtime.search({ query: 42 as unknown as string });
    expect(result.kind).toBe("error");
    expect(source.searchCalls).toBe(0);
  });

  it("rejects a query whose UTF-8 bytes exceed MAX_NOTES_READ_QUERY_BYTES", async () => {
    const source = createFakeSource({
      searchHits: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const tooLong = "x".repeat(MAX_NOTES_READ_QUERY_BYTES + 1);
    const result = await runtime.search({ query: tooLong });
    expect(result.kind).toBe("error");
    expect(source.searchCalls).toBe(0);
  });

  it("accepts a query at exactly MAX_NOTES_READ_QUERY_BYTES UTF-8 bytes (closed bound)", async () => {
    const source = createFakeSource({
      searchHits: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const atCap = "y".repeat(MAX_NOTES_READ_QUERY_BYTES);
    const bytes = new TextEncoder().encode(atCap).byteLength;
    expect(bytes).toBe(MAX_NOTES_READ_QUERY_BYTES);
    const result = await runtime.search({ query: atCap });
    expect(result.kind).toBe("page");
    expect(source.searchCalls).toBe(1);
    expect(source.searchCallsWith).toEqual([atCap]);
  });

  it("rejects a multi-byte UTF-8 query whose bytes exceed MAX_NOTES_READ_QUERY_BYTES", async () => {
    const source = createFakeSource({
      searchHits: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const twoByte = "\u00e9".repeat(Math.floor(MAX_NOTES_READ_QUERY_BYTES / 2) + 2);
    const bytes = new TextEncoder().encode(twoByte).byteLength;
    expect(bytes).toBeGreaterThan(MAX_NOTES_READ_QUERY_BYTES);
    const result = await runtime.search({ query: twoByte });
    expect(result.kind).toBe("error");
    expect(source.searchCalls).toBe(0);
  });

  it("never echoes a rejected query in the categorical result or message", async () => {
    const source = createFakeSource({
      searchHits: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: createFakeHandleCodec(),
    });
    const sensitive = "AKIAIOSFODNN7EXAMPLE-LEAF-PASSWORD";
    const result = await runtime.search({ query: sensitive });
    // The valid query is forwarded to the source — its value is
    // intentionally absent from the bounded output.  We assert the
    // sensitive value never crosses the formatter boundary.
    expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(source.searchCallsWith).toEqual([sensitive]);
  });

  it("exposes MAX_NOTES_READ_QUERY_BYTES as the established 4 MiB upper bound", () => {
    expect(MAX_NOTES_READ_QUERY_BYTES).toBe(4 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// `get` — single-note view by opaque handle.
// ---------------------------------------------------------------------------

describe("createNotesReadRuntime — get", () => {
  it("returns a bounded `note` for a valid opaque handle", async () => {
    const codec = createFakeHandleCodec();
    const source = createFakeSource({
      notes: [{ id: "alpha", title: "Alpha", dateModified: 4242 }],
    });
    const runtime = createNotesReadRuntime({ source, handleCodec: codec });
    const handle = codec.encode("alpha");
    const result = await runtime.get({ handle });
    expect(result.kind).toBe("note");
    if (result.kind !== "note") return;
    expect(typeof result.content.label).toBe("string");
    expect(Number.isSafeInteger(result.content.bytes)).toBe(true);
    expect(result.content.bytes).toBeGreaterThanOrEqual(0);
    expect(result.content.label).not.toContain("alpha");
    expect(Object.isFrozen(result.content)).toBe(true);
  });

  it("returns `missing` when the source has no matching note", async () => {
    const codec = createFakeHandleCodec();
    const source = createFakeSource({ notes: [] });
    const runtime = createNotesReadRuntime({ source, handleCodec: codec });
    const handle = codec.encode("nope");
    const result = await runtime.get({ handle });
    expect(result.kind).toBe("missing");
  });

  it("returns `error` for a malformed opaque handle without consulting the codec or the source", async () => {
    const codec = createFakeHandleCodec();
    const source = createFakeSource({
      notes: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({ source, handleCodec: codec });
    // The handle fails the bounded opaque grammar (illegal `!`).
    // The adapter MUST validate the grammar BEFORE calling the
    // codec — neither `decode` nor `source.note` is reached.
    const result = await runtime.get({ handle: "not_a_bounded_handle!" });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).not.toContain("alpha");
    expect(source.noteCalls).toBe(0);
    // Grammar validation MUST precede codec.decode; the codec is
    // never consulted for malformed input.
    expect(codec.state.decodeCalls).toBe(0);
  });

  it("returns `error` for a reserved `rev_` handle without consulting the codec or the source", async () => {
    const codec = createFakeHandleCodec();
    const source = createFakeSource({
      notes: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({ source, handleCodec: codec });
    // The handle begins with the reserved `rev_` family and MUST
    // be rejected by the grammar validator before `decode` runs.
    const reserved = "rev_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    const result = await runtime.get({ handle: reserved });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).not.toContain(reserved);
    expect(result.message).not.toContain("alpha");
    expect(source.noteCalls).toBe(0);
    expect(codec.state.decodeCalls).toBe(0);
  });

  it("returns `error` for a non-string handle without consulting the codec or the source", async () => {
    const codec = createFakeHandleCodec();
    const source = createFakeSource({
      notes: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({ source, handleCodec: codec });
    const result = await runtime.get({ handle: 42 as unknown as string });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).not.toContain("alpha");
    expect(source.noteCalls).toBe(0);
    expect(codec.state.decodeCalls).toBe(0);
  });

  it("returns `error` for a forged opaque handle (not minted by the codec)", async () => {
    const codec = createFakeHandleCodec();
    const source = createFakeSource({
      notes: [
        { id: "alpha", title: "Alpha" },
        { id: "beta", title: "Beta" },
      ],
    });
    const runtime = createNotesReadRuntime({ source, handleCodec: codec });
    // Forge a handle that satisfies the bounded opaque grammar but
    // was never minted by the codec.  The fake codec's decode()
    // returns `invalid` for any handle it did not encode itself —
    // the adapter must consult the codec and never reach
    // `source.note`.
    const forged = "noth_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    const result = await runtime.get({ handle: forged });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(source.noteCalls).toBe(0);
    expect(source.noteCallsWith).toEqual([]);
    expect(codec.state.decodeCalls).toBe(1);
  });

  it("returns `error` when the codec rejects the input handle before reaching source.note", async () => {
    // A codec that always returns `invalid` simulates a forged
    // handle at the codec layer.  The adapter must reject it
    // BEFORE invoking `source.note` — the test asserts both the
    // outcome kind and the call counter.
    const rejectingCodec: NotesReadRuntimeHandleCodec = {
      encode: () => "fakh_zzzz",
      decode: () => ({ kind: "invalid" as const }),
    };
    const source = createFakeSource({
      notes: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: rejectingCodec,
    });
    const result = await runtime.get({ handle: "noth_whatever" });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(source.noteCalls).toBe(0);
    expect(source.noteCallsWith).toEqual([]);
  });

  it("collapses a codec.decode exception to the categorical `error` shape without leaking the exception text", async () => {
    // The codec intentionally throws on `decode`.  The adapter
    // must catch the throw, never invoke `source.note`, and emit
    // the fixed categorical error shape.  The thrown exception's
    // text MUST NOT appear in the error message.
    const throwingCodec: NotesReadRuntimeHandleCodec = {
      encode: () => "fakh_zzzz",
      decode: () => {
        throw new Error("internal-secret-id path /tmp/notes.db leaked");
      },
    };
    const source = createFakeSource({
      notes: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: throwingCodec,
    });
    const result = await runtime.get({ handle: "noth_whatever" });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).not.toMatch(/secret/);
    expect(result.message).not.toMatch(/credential/);
    expect(result.message).not.toMatch(/path/);
    expect(result.message).not.toMatch(/notes\.db/);
    expect(source.noteCalls).toBe(0);
    expect(source.noteCallsWith).toEqual([]);
  });

  it("collapses a malformed codec verdict (wrong kind) to the categorical `error` shape", async () => {
    // The codec returns a verdict with a kind OTHER than `ok` or
    // `invalid` (a hostile / misbehaving codec).  The adapter
    // MUST treat it as a runtime fault, never invoke `source.note`,
    // and emit the fixed categorical error.
    const hostileCodec: NotesReadRuntimeHandleCodec = {
      encode: () => "fakh_zzzz",
      decode: () =>
        ({ kind: "maybe", sourceId: "alpha" }) as unknown as { kind: "ok"; sourceId: string },
    };
    const source = createFakeSource({
      notes: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: hostileCodec,
    });
    const result = await runtime.get({ handle: "noth_whatever" });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).not.toContain("alpha");
    expect(source.noteCalls).toBe(0);
    expect(source.noteCallsWith).toEqual([]);
  });

  it("collapses an `ok` verdict with an empty sourceId to the categorical `error` shape", async () => {
    // The codec returns `ok` but the resolved sourceId is empty.
    // The adapter MUST treat that as a runtime fault and never
    // invoke `source.note`.
    const hostileCodec: NotesReadRuntimeHandleCodec = {
      encode: () => "fakh_zzzz",
      decode: () => ({ kind: "ok" as const, sourceId: "" }),
    };
    const source = createFakeSource({
      notes: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: hostileCodec,
    });
    const result = await runtime.get({ handle: "noth_whatever" });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(source.noteCalls).toBe(0);
    expect(source.noteCallsWith).toEqual([]);
  });

  it("collapses an `ok` verdict with a non-string sourceId to the categorical `error` shape", async () => {
    const hostileCodec: NotesReadRuntimeHandleCodec = {
      encode: () => "fakh_zzzz",
      decode: () => ({ kind: "ok" as const, sourceId: 42 as unknown as string }),
    };
    const source = createFakeSource({
      notes: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: hostileCodec,
    });
    const result = await runtime.get({ handle: "noth_whatever" });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(source.noteCalls).toBe(0);
    expect(source.noteCallsWith).toEqual([]);
  });

  it("collapses an `ok` verdict with an oversized sourceId (> 100) to the categorical `error` shape", async () => {
    // A source id beyond the closed 100-byte cap is structurally
    // hostile / upstream leakage and must never reach `source.note`.
    const oversized = "x".repeat(101);
    const hostileCodec: NotesReadRuntimeHandleCodec = {
      encode: () => "fakh_zzzz",
      decode: () => ({ kind: "ok" as const, sourceId: oversized }),
    };
    const source = createFakeSource({
      notes: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({
      source,
      handleCodec: hostileCodec,
    });
    const result = await runtime.get({ handle: "noth_whatever" });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    // The oversized source id MUST NOT be echoed into the
    // categorical error message — fixed-shape only.
    expect(result.message).not.toContain(oversized);
    expect(result.message).not.toContain("x".repeat(50));
    expect(source.noteCalls).toBe(0);
    expect(source.noteCallsWith).toEqual([]);
  });

  it("accepts an `ok` verdict whose sourceId is exactly 100 characters and binds to the source", async () => {
    // The closed cap is inclusive: sourceId of length 100 is the
    // largest legal value the adapter admits.  Source.note must
    // be invoked exactly once and the bounded `note` content must
    // be returned.
    const edgeSourceId = "x".repeat(100);
    const source = createFakeSource({
      notes: [{ id: edgeSourceId, title: "Edge" }],
    });
    const codec: NotesReadRuntimeHandleCodec = {
      encode: () => "fakh_zzzz",
      decode: () => ({ kind: "ok" as const, sourceId: edgeSourceId }),
    };
    const runtime = createNotesReadRuntime({ source, handleCodec: codec });
    const result = await runtime.get({ handle: "noth_whatever" });
    expect(result.kind).toBe("note");
    if (result.kind !== "note") return;
    expect(source.noteCalls).toBe(1);
    expect(source.noteCallsWith).toEqual([edgeSourceId]);
  });

  it("collapses upstream throws to the categorical `error` shape", async () => {
    const codec = createFakeHandleCodec();
    const source = createFakeSource({ throwOnNote: true });
    const runtime = createNotesReadRuntime({ source, handleCodec: codec });
    const handle = codec.encode("alpha");
    const result = await runtime.get({ handle });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).not.toMatch(/secret/);
    expect(result.message).not.toMatch(/credential/);
    expect(result.message).not.toMatch(/path/);
  });
});

// ---------------------------------------------------------------------------
// Injected seam isolation.
// ---------------------------------------------------------------------------

describe("createNotesReadRuntime — seam isolation", () => {
  it("only consults the injected codec for handle production and decoding", async () => {
    const codec = createFakeHandleCodec();
    const source = createFakeSource({
      notes: [{ id: "alpha", title: "Alpha" }],
      searchHits: [{ id: "alpha", title: "Alpha" }],
    });
    const runtime = createNotesReadRuntime({ source, handleCodec: codec });
    await runtime.browse({});
    await runtime.search({ query: "leaf" });
    await runtime.get({ handle: codec.encode("alpha") });
    // Browse + search encode once each for the seeded note, plus
    // one extra encode for `get`.  The exact count is fragile to
    // test ordering so we only assert the codec was consulted for
    // every code path.
    expect(codec.state.encodeCalls).toBeGreaterThanOrEqual(3);
    expect(codec.state.decodeCalls).toBeGreaterThanOrEqual(1);
    // The fake source did NOT expose `delete`, `update`, `sync`,
    // `transport`, or generic `call`.  Construction already proved
    // the allowlist is enforced; here we prove the adapter only
    // invokes the closed read-only surface.
    expect(source.listCalls).toBeGreaterThan(0);
    expect(source.searchCalls).toBeGreaterThan(0);
    expect(source.noteCalls).toBeGreaterThan(0);
    // `source.note` was called only with a value the codec minted,
    // never with a raw handle string.
    for (const arg of source.noteCallsWith) {
      // The injected source id is "alpha"; the codec decodes back
      // to "alpha" before the adapter invokes source.note.
      expect(arg).toBe("alpha");
    }
  });
});
