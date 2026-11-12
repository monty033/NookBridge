/**
 * Stage 5 slice B — the operator-only `notes.resolve-conflict` transaction.
 *
 * The seam is an in-memory double of the six slots, as in slice A, with every
 * slot call logged. The operation store is the real encrypted store over an
 * in-memory filesystem, and the journal is the real in-memory journal, so the
 * recovery and bound behaviour are exercised rather than stubbed.
 *
 * Refusal tests assert that no content write ran (`notesAddVerbatim`,
 * `contentResolve`, `noteClearConflict`) and that the original rows are
 * unchanged. A result alone never passes a refusal test.
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { createNotesnookLocalConflictInspector } from "../src/core/notesnook-local-conflict-projection.js";
import type { NotesnookConflictResolveSeam } from "../src/core/notesnook-conflict-resolve-wiring.js";
import {
  buildLiveConflictResolveSeam,
  buildOptionalLiveConflictResolveCapability,
  type LiveConflictResolveCapability,
} from "../src/core/notesnook-conflict-resolve-live.js";
import {
  createNotesnookRecoveryMarker,
  MemoryNotesnookRecoveryJournal,
  NOTESNOOK_RECOVERY_JOURNAL_MAX_MARKERS,
} from "../src/core/notesnook-recovery-journal.js";
import { createOperatorConflictResolveRuntime } from "../src/service/notes-conflict-resolve-runtime.js";
import { createNotesUndoStore, type OperationStoreFs } from "../src/service/notes-undo-store.js";
import { createOperatorDiscoveryHandler } from "../src/service/operator-discovery-handler.js";
import { OPERATOR_METHODS } from "../src/service/operator-methods.js";
import { handleRpcRequest } from "../src/service/rpc-handler.js";
import {
  parseRpcFrame,
  serializeRpcResponse,
  type RpcRequest,
} from "../src/service/rpc-protocol.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";

const LOCAL_BODY = '<p data-block-id="l1">local edit</p>';
const REMOTE_BODY = '<p data-block-id="r1">remote edit</p>';
const REMOTE_DATE = 2_000;
const ZERO_BINDING = "0".repeat(64);
const HANDLE = "handle-note-1";
const SECRET = "PRIVATE-OPERATOR-RESOLVE-SECRET-9c41";
const MEMBERSHIPS = [
  { type: "notebook" as const, id: "nb-work" },
  { type: "tag" as const, id: "tag-a" },
];
const PEER_A = { uid: 1, gid: 2, groups: [] as string[] };
const PEER_B = { uid: 3, gid: 4, groups: [] as string[] };

type Slot =
  | "noteMeta"
  | "contentWithConflicted"
  | "notesAddVerbatim"
  | "contentResolve"
  | "noteClearConflict"
  | "noteRelate";
type Row = Record<string, unknown>;

const WRITE_SLOTS: ReadonlyArray<Slot> = [
  "notesAddVerbatim",
  "noteRelate",
  "contentResolve",
  "noteClearConflict",
];

interface Fake {
  readonly seam: NotesnookConflictResolveSeam;
  readonly calls: Slot[];
  readonly notes: Map<string, Row>;
  readonly contents: Map<string, Row>;
  /** Slots that throw on their next call only. */
  readonly failOnce: Set<Slot>;
  /** Slots that throw on every call. */
  readonly failAlways: Set<Slot>;
}

/** What the content row's `conflicted` marker reads as after the resolve writes it. */
type ResolvedMarker = "null" | "absent" | "false" | "true" | "text";

function applyResolvedMarker(row: Row, marker: ResolvedMarker): void {
  switch (marker) {
    case "absent":
      delete row.conflicted;
      return;
    case "null":
      row.conflicted = null;
      return;
    case "false":
      row.conflicted = false;
      return;
    case "true":
      row.conflicted = true;
      return;
    case "text":
      row.conflicted = "x";
      return;
  }
}

function createFake(
  memberships: ReadonlyArray<Row> = MEMBERSHIPS,
  resolvedMarker: ResolvedMarker = "null",
): Fake {
  const notes = new Map<string, Row>([
    [
      "note-1",
      {
        id: "note-1",
        title: "Field notes",
        contentId: "content-1",
        conflicted: true,
        memberships: memberships.map((membership) => ({ ...membership })),
      },
    ],
  ]);
  const contents = new Map<string, Row>([
    [
      "content-1",
      {
        id: "content-1",
        noteId: "note-1",
        type: "tiptap",
        locked: false,
        data: LOCAL_BODY,
        dateModified: 1_000,
        dateResolved: null,
        conflicted: {
          id: "content-1",
          noteId: "note-1",
          type: "tiptap",
          locked: false,
          data: REMOTE_BODY,
          dateModified: REMOTE_DATE,
        },
      },
    ],
  ]);
  const calls: Slot[] = [];
  const failOnce = new Set<Slot>();
  const failAlways = new Set<Slot>();
  const enter = (slot: Slot): void => {
    calls.push(slot);
    if (failAlways.has(slot) || failOnce.delete(slot)) throw new Error(SECRET);
  };
  const copy = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

  const seam: NotesnookConflictResolveSeam = {
    noteMeta: async (id) => {
      enter("noteMeta");
      const note = notes.get(id);
      return note === undefined ? undefined : (copy(note) as Row);
    },
    contentWithConflicted: async (contentId) => {
      enter("contentWithConflicted");
      const row = contents.get(contentId);
      return row === undefined ? undefined : (copy(row) as Row);
    },
    notesAddVerbatim: async (input) => {
      enter("notesAddVerbatim");
      contents.set("content-copy-1", {
        id: "content-copy-1",
        noteId: "note-copy-1",
        type: input.content.type,
        locked: false,
        data: input.content.data,
        dateModified: 3_000,
        dateResolved: null,
        conflicted: null,
      });
      notes.set("note-copy-1", {
        id: "note-copy-1",
        title: input.title,
        contentId: "content-copy-1",
        conflicted: false,
        memberships: [],
      });
      return "note-copy-1";
    },
    contentResolve: async (input) => {
      enter("contentResolve");
      const row = contents.get(input.id);
      if (row === undefined) throw new Error("missing content");
      row.data = input.data;
      applyResolvedMarker(row, resolvedMarker);
      row.dateResolved = input.dateResolved;
    },
    noteClearConflict: async (id) => {
      enter("noteClearConflict");
      const note = notes.get(id);
      if (note === undefined) throw new Error("missing note");
      note.conflicted = false;
    },
    noteRelate: async (input) => {
      enter("noteRelate");
      const note = notes.get(input.noteId);
      if (note === undefined) throw new Error("missing note");
      const current = Array.isArray(note.memberships) ? note.memberships : [];
      note.memberships = [...current, { ...input.to }];
    },
  };

  return { seam, calls, notes, contents, failOnce, failAlways };
}

function writesOf(fake: Fake): Slot[] {
  return fake.calls.filter((slot) => WRITE_SLOTS.includes(slot));
}

function originalOf(fake: Fake): unknown {
  return JSON.parse(
    JSON.stringify({ note: fake.notes.get("note-1"), content: fake.contents.get("content-1") }),
  );
}

/** The binding the Stage 0 inspector reports now; the call log is cleared after it. */
async function bindingOf(fake: Fake): Promise<string> {
  const inspector = createNotesnookLocalConflictInspector({
    notes: { note: (id: string) => fake.seam.noteMeta(id) },
    contentWithConflicted: { get: (id: string) => fake.seam.contentWithConflicted(id) },
  });
  const result = await inspector.inspectConflict("note-1");
  fake.calls.length = 0;
  if (result.outcome !== "inspected") throw new Error("expected an inspected conflict");
  return result.binding;
}

class MemoryFs implements OperationStoreFs {
  files = new Map<string, Uint8Array>();
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

async function harness(fake: Fake) {
  const journal = new MemoryNotesnookRecoveryJournal();
  const pending: string[] = [];
  const capability: LiveConflictResolveCapability = {
    seam: fake.seam,
    journal,
    runExclusive: async <T>(_label: string, fn: () => T | PromiseLike<T>): Promise<T> => await fn(),
    markPending: (noteId: string) => {
      pending.push(noteId);
    },
  };
  const store = await createNotesUndoStore({
    fs: new MemoryFs(),
    daemonKey: new Uint8Array(32).fill(7),
    now: () => 1_000,
  });
  const runtime = createOperatorConflictResolveRuntime({
    capability,
    store,
    resolveHandle: (handle: string) => (handle === HANDLE ? "note-1" : undefined),
  });
  return { runtime, store, journal, pending };
}

async function operationsOf(store: Awaited<ReturnType<typeof createNotesUndoStore>>) {
  return (await store.list()).filter((record) => record.kind === "resolve");
}

function frameOf(value: unknown): Uint8Array {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function bodyOf(frame: Uint8Array): unknown {
  return JSON.parse(Buffer.from(frame.subarray(4)).toString("utf8"));
}

describe("Stage 5 slice B — admission and the MCP refusal", () => {
  it("admits notes.resolve-conflict on the operator vocabulary", () => {
    expect(OPERATOR_METHODS).toContain("notes.resolve-conflict");
  });

  it("refuses notes.resolve-conflict on the MCP listener without running anything", async () => {
    const response = await handleRpcRequest(
      {
        id: "mcp-1",
        method: "notes.resolve-conflict",
        params: { id: HANDLE, binding: ZERO_BINDING },
      } as unknown as RpcRequest,
      {} as never,
      createReadWriteNoDeleteServicePolicy(),
    );

    expect(response.ok).toBe(false);
    expect((response as unknown as { error: { code: string } }).error.code).toMatch(
      /^invalid_request$/,
    );
    expect(response).not.toHaveProperty("result");
  });
});

describe("Stage 5 slice B — request and response protocol", () => {
  it("parses the closed request shape", () => {
    const request = parseRpcFrame(
      frameOf({
        id: "c-1",
        method: "notes.resolve-conflict",
        params: { id: HANDLE, binding: "a".repeat(64) },
      }),
    );

    expect(request).toMatchObject({
      method: "notes.resolve-conflict",
      params: { id: HANDLE, binding: "a".repeat(64) },
    });
  });

  it.each([
    ["an extra field", { id: HANDLE, binding: "a".repeat(64), body: "x" }],
    ["a missing binding", { id: HANDLE }],
    ["an upper-case binding", { id: HANDLE, binding: "A".repeat(64) }],
    ["a short binding", { id: HANDLE, binding: "a".repeat(63) }],
    ["an empty handle", { id: "", binding: "a".repeat(64) }],
  ])("rejects a request with %s", (_label, params) => {
    expect(() =>
      parseRpcFrame(frameOf({ id: "c-2", method: "notes.resolve-conflict", params })),
    ).toThrow();
  });

  it("serializes each closed outcome and nothing else", () => {
    const resolved = serializeRpcResponse({
      id: "c-3",
      ok: true,
      result: {
        kind: "conflict-resolve",
        outcome: "resolved",
        originalTitle: "Field notes",
        copyTitle: "Field notes (bridge copy)",
      },
    });
    expect(bodyOf(resolved)).toEqual({
      id: "c-3",
      ok: true,
      result: {
        kind: "conflict-resolve",
        outcome: "resolved",
        originalTitle: "Field notes",
        copyTitle: "Field notes (bridge copy)",
      },
    });

    expect(
      bodyOf(
        serializeRpcResponse({
          id: "c-4",
          ok: true,
          result: { kind: "conflict-resolve", outcome: "stale_revision", copyCreated: false },
        }),
      ),
    ).toMatchObject({ result: { outcome: "stale_revision", copyCreated: false } });
  });

  it.each([
    [
      "an extra field on resolved",
      {
        kind: "conflict-resolve",
        outcome: "resolved",
        originalTitle: "a",
        copyTitle: "b",
        noteId: "note-1",
      },
    ],
    [
      "copyCreated on resolved",
      {
        kind: "conflict-resolve",
        outcome: "resolved",
        originalTitle: "a",
        copyTitle: "b",
        copyCreated: true,
      },
    ],
    ["a body on a refusal", { kind: "conflict-resolve", outcome: "read_failed", body: SECRET }],
    ["an unknown outcome", { kind: "conflict-resolve", outcome: "deleted" }],
    [
      "a non-boolean copyCreated",
      {
        kind: "conflict-resolve",
        outcome: "stale_revision",
        copyCreated: "yes",
      },
    ],
  ])("refuses to serialize a result with %s", (_label, result) => {
    expect(() => serializeRpcResponse({ id: "c-5", ok: true, result })).toThrow();
  });
});

describe("Stage 5 slice B — the operator transaction", () => {
  it("resolves keep-both, marks the note pending, and commits the operation", async () => {
    const fake = createFake();
    const { runtime, store, journal, pending } = await harness(fake);
    const binding = await bindingOf(fake);

    const result = await runtime.resolveConflict({ id: HANDLE, binding }, PEER_A);

    expect(result).toEqual({
      kind: "conflict-resolve",
      outcome: "resolved",
      originalTitle: "Field notes",
      copyTitle: "Field notes (bridge copy)",
    });
    expect(JSON.stringify(result)).not.toContain(REMOTE_BODY);
    expect(JSON.stringify(result)).not.toContain("note-copy-1");
    expect(writesOf(fake)).toEqual([
      "notesAddVerbatim",
      "noteRelate",
      "noteRelate",
      "contentResolve",
      "noteClearConflict",
    ]);
    expect(fake.contents.get("content-1")).toMatchObject({ data: REMOTE_BODY, conflicted: null });
    expect(fake.notes.get("note-1")).toMatchObject({ conflicted: false });
    expect(pending).toEqual(["note-1"]);
    const [operation] = await operationsOf(store);
    expect(operation?.state).toBe("committed");
    expect(journal.snapshot()).toEqual([]);
  });

  it("commits a resolve whose content marker is absent, as cleared", async () => {
    const fake = createFake(MEMBERSHIPS, "absent");
    const { runtime, store, pending } = await harness(fake);
    const binding = await bindingOf(fake);

    const result = await runtime.resolveConflict({ id: HANDLE, binding }, PEER_A);

    expect(result).toEqual({
      kind: "conflict-resolve",
      outcome: "resolved",
      originalTitle: "Field notes",
      copyTitle: "Field notes (bridge copy)",
    });
    expect(fake.contents.get("content-1")).not.toHaveProperty("conflicted");
    expect(fake.notes.get("note-1")).toMatchObject({ conflicted: false });
    expect(pending).toEqual(["note-1"]);
    const [operation] = await operationsOf(store);
    expect(operation?.state).toBe("committed");
  });

  it.each([
    ["true", "true"],
    ["a text value", "text"],
  ] as const)(
    "does not commit or mark pending when the content marker still reads %s",
    async (_label, marker) => {
      const fake = createFake(MEMBERSHIPS, marker);
      const { runtime, store, pending } = await harness(fake);
      const binding = await bindingOf(fake);

      const result = await runtime.resolveConflict({ id: HANDLE, binding }, PEER_A);

      expect(result).toMatchObject({ kind: "conflict-resolve", outcome: "post_write_unverified" });
      expect(pending).toEqual([]);
      const [operation] = await operationsOf(store);
      expect(operation?.state).not.toBe("committed");
    },
  );

  it("refuses a stale binding before any write and records no operation", async () => {
    const fake = createFake();
    const { runtime, store, pending } = await harness(fake);
    const before = originalOf(fake);

    const result = await runtime.resolveConflict({ id: HANDLE, binding: ZERO_BINDING }, PEER_A);

    expect(result).toEqual({
      kind: "conflict-resolve",
      outcome: "stale_revision",
      copyCreated: false,
    });
    expect(writesOf(fake)).toEqual([]);
    expect(originalOf(fake)).toEqual(before);
    expect(await operationsOf(store)).toEqual([]);
    expect(pending).toEqual([]);
  });

  it("refuses an unknown handle as not_found with no writes", async () => {
    const fake = createFake();
    const { runtime } = await harness(fake);

    await expect(
      runtime.resolveConflict({ id: "handle-unknown", binding: ZERO_BINDING }, PEER_A),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(fake.calls).toEqual([]);
  });

  it("refuses a membership of an unsupported type as read_failed with no writes", async () => {
    const fake = createFake([{ type: "folder", id: "f-1" }]);
    const { runtime, store } = await harness(fake);
    const binding = await bindingOf(fake);

    const result = await runtime.resolveConflict({ id: HANDLE, binding }, PEER_A);

    expect(result).toEqual({ kind: "conflict-resolve", outcome: "read_failed" });
    expect(writesOf(fake)).toEqual([]);
    expect(await operationsOf(store)).toEqual([]);
  });

  it("reports relation_failed before the content write, and leaves the original untouched", async () => {
    const fake = createFake();
    fake.failAlways.add("noteRelate");
    const { runtime, store, pending } = await harness(fake);
    const binding = await bindingOf(fake);
    const before = originalOf(fake);

    const result = await runtime.resolveConflict({ id: HANDLE, binding }, PEER_A);

    expect(result).toEqual({ kind: "conflict-resolve", outcome: "relation_failed" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(writesOf(fake)).toEqual(["notesAddVerbatim", "noteRelate"]);
    expect(fake.calls).not.toContain("contentResolve");
    expect(fake.calls).not.toContain("noteClearConflict");
    expect(originalOf(fake)).toEqual(before);
    expect(pending).toEqual([]);
    const [operation] = await operationsOf(store);
    expect(operation?.state).toBe("unresolved");
  });

  it("reports the half-done state, then recovers it on a re-run by the same owner", async () => {
    const fake = createFake();
    fake.failOnce.add("noteClearConflict");
    const { runtime, store, journal, pending } = await harness(fake);
    const binding = await bindingOf(fake);

    const first = await runtime.resolveConflict({ id: HANDLE, binding }, PEER_A);

    expect(first).toEqual({ kind: "conflict-resolve", outcome: "resolved_flag_pending" });
    expect(fake.contents.get("content-1")).toMatchObject({ data: REMOTE_BODY, conflicted: null });
    expect(fake.notes.get("note-1")).toMatchObject({ conflicted: true });
    expect(pending).toEqual([]);
    expect((await operationsOf(store))[0]?.state).toBe("unresolved");
    expect(journal.snapshot().map((marker) => marker.stage)).toContain("resolve-content");

    const second = await runtime.resolveConflict({ id: HANDLE, binding }, PEER_A);

    expect(second).toEqual({
      kind: "conflict-resolve",
      outcome: "resolved",
      originalTitle: "Field notes",
      copyTitle: "Field notes (bridge copy)",
    });
    // The re-run clears only the flag: no second copy and no second content write.
    expect(writesOf(fake).filter((slot) => slot === "notesAddVerbatim")).toHaveLength(1);
    expect(writesOf(fake).filter((slot) => slot === "contentResolve")).toHaveLength(1);
    expect(writesOf(fake).filter((slot) => slot === "noteClearConflict")).toHaveLength(2);
    expect(fake.notes.get("note-1")).toMatchObject({ conflicted: false });
    expect(pending).toEqual(["note-1"]);
    expect((await operationsOf(store))[0]?.state).toBe("committed");
    expect(journal.snapshot()).toEqual([]);
  });

  it("blocks a resolve while another owner has an unfinished one for the same note", async () => {
    const fake = createFake();
    fake.failOnce.add("noteClearConflict");
    const { runtime, pending } = await harness(fake);
    const binding = await bindingOf(fake);
    await runtime.resolveConflict({ id: HANDLE, binding }, PEER_A);
    const writesBefore = writesOf(fake).length;

    await expect(runtime.resolveConflict({ id: HANDLE, binding }, PEER_B)).rejects.toMatchObject({
      code: "service_unavailable",
    });
    expect(writesOf(fake)).toHaveLength(writesBefore);
    expect(pending).toEqual([]);
  });

  it("admits a fresh run when the journal has 61 markers, and refuses it at 62", async () => {
    const boundary = NOTESNOOK_RECOVERY_JOURNAL_MAX_MARKERS - 3;

    const roomy = createFake();
    const roomyRun = await harness(roomy);
    for (let index = 0; index < boundary; index += 1) {
      roomyRun.journal.record(
        createNotesnookRecoveryMarker("update", `other-${index}`, "append-date"),
      );
    }
    const roomyBinding = await bindingOf(roomy);
    expect(
      (await roomyRun.runtime.resolveConflict({ id: HANDLE, binding: roomyBinding }, PEER_A))
        .outcome,
    ).toBe("resolved");

    const full = createFake();
    const fullRun = await harness(full);
    for (let index = 0; index < boundary + 1; index += 1) {
      fullRun.journal.record(
        createNotesnookRecoveryMarker("update", `other-${index}`, "append-date"),
      );
    }
    const fullBinding = await bindingOf(full);
    await expect(
      fullRun.runtime.resolveConflict({ id: HANDLE, binding: fullBinding }, PEER_A),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    expect(writesOf(full)).toEqual([]);
    expect(await operationsOf(fullRun.store)).toEqual([]);
  });
});

describe("Stage 5 slice B — live seam and capability builders", () => {
  function liveDatabase(overrides: Record<string, unknown> = {}) {
    const relationAdds: unknown[] = [];
    const database = {
      notes: {
        note: async (id: string) => ({ id, title: "T", contentId: "c-1", conflicted: false }),
        add: async () => "note-copy-1",
      },
      content: {
        collection: { get: async (id: string) => ({ id, noteId: "note-1", data: "" }) },
        add: async () => undefined,
      },
      relations: {
        add: async (...args: unknown[]) => {
          relationAdds.push(args);
        },
        from: () => ({
          get: async () => [
            { fromId: "note-1", fromType: "note", toId: "nb-work", toType: "notebook" },
            { fromId: "note-1", fromType: "note", toId: "color-1", toType: "color" },
          ],
        }),
      },
      ...overrides,
    };
    return { database, relationAdds };
  }

  it("builds the seam from a full surface and reads only notebook and tag memberships", async () => {
    const { database } = liveDatabase();
    const seam = buildLiveConflictResolveSeam(database, () => undefined);

    expect(seam).toBeDefined();
    const note = await seam!.noteMeta("note-1");
    expect(note).toMatchObject({ id: "note-1", contentId: "c-1" });
    expect((note as unknown as { memberships: unknown }).memberships).toEqual([
      { type: "notebook", id: "nb-work" },
    ]);
  });

  it("refuses a relation to any type other than a notebook or tag, without calling relations.add", async () => {
    const { database, relationAdds } = liveDatabase();
    const seam = buildLiveConflictResolveSeam(database, () => undefined);

    await expect(
      seam!.noteRelate({ noteId: "note-copy-1", to: { type: "folder", id: "f-1" } } as never),
    ).rejects.toThrow();
    expect(relationAdds).toEqual([]);
  });

  it("is absent when any required slot is missing", () => {
    const { database } = liveDatabase();
    const withoutRelationAdd = {
      ...database,
      relations: { from: database.relations.from },
    };

    expect(buildLiveConflictResolveSeam({}, () => undefined)).toBeUndefined();
    expect(buildLiveConflictResolveSeam(withoutRelationAdd, () => undefined)).toBeUndefined();
  });

  it("is absent when the journal cannot discard or the coordinator is missing", () => {
    const { database } = liveDatabase();
    const journal = new MemoryNotesnookRecoveryJournal();
    const coordinator = { recordLocalCommit: () => undefined } as never;

    expect(
      buildOptionalLiveConflictResolveCapability({
        database,
        ensureOpen: () => undefined,
        journal: { record: () => undefined, snapshot: () => [] },
        coordinator,
      }),
    ).toBeUndefined();
    expect(
      buildOptionalLiveConflictResolveCapability({
        database,
        ensureOpen: () => undefined,
        journal,
        coordinator: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("Stage 5 slice B — the operator discovery dispatch", () => {
  const request = {
    id: "d-1",
    method: "notes.resolve-conflict",
    params: { id: HANDLE, binding: ZERO_BINDING },
  } as unknown as RpcRequest;

  it("answers service_unavailable when the capability is absent", async () => {
    const handler = createOperatorDiscoveryHandler({} as never);

    const response = await handler(request, PEER_A);

    expect(response).toMatchObject({ ok: false, error: { code: "service_unavailable" } });
  });

  it("returns the closed result from the runtime", async () => {
    const handler = createOperatorDiscoveryHandler({
      resolveConflict: async () => ({
        kind: "conflict-resolve",
        outcome: "not-conflicted",
      }),
    } as never);

    const response = await handler(request, PEER_A);

    expect(response).toEqual({
      id: "d-1",
      ok: true,
      result: { kind: "conflict-resolve", outcome: "not-conflicted" },
    });
  });
});
