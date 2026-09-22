import { describe, expect, it } from "vitest";

import {
  createOperatorWriteRuntime,
  type OperatorStoredContent,
  type OperatorWriteSource,
} from "../src/service/notes-operator-write-runtime.js";
import { createNotesUndoStore, type OperationStoreFs } from "../src/service/notes-undo-store.js";

const HANDLE = "h_noteone";
const NOTE_ID = "note-1";
const REVISION_1 = `rev_${"1".repeat(32)}`;
const REVISION_2 = `rev_${"2".repeat(32)}`;
const REVISION_3 = `rev_${"3".repeat(32)}`;

const wrap = (s: string) => ({
  type: "tiptap" as const,
  data: `<div data-type="document">${s}</div>`,
});

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

async function fixture(options: { readonly native?: string } = {}) {
  const state: { revision: string; content: OperatorStoredContent; writes: number } = {
    revision: REVISION_1,
    content: wrap(options.native ?? "<p>before</p>") as OperatorStoredContent,
    writes: 0,
  };
  const events: string[] = [];
  const source: OperatorWriteSource = {
    async read(noteId: string) {
      if (noteId !== NOTE_ID) return undefined;
      return { revision: state.revision, content: { ...state.content } };
    },
    async update(command) {
      events.push(`update:${command.expectedRevision}`);
      if (command.noteId !== NOTE_ID) return { kind: "missing" as const };
      if (command.expectedRevision !== state.revision) return { kind: "conflict" as const };
      state.writes += 1;
      state.content = { ...command.content };
      state.revision = command.expectedRevision === REVISION_1 ? REVISION_2 : REVISION_3;
      return { kind: "updated" as const, revision: state.revision };
    },
  };
  const store = await createNotesUndoStore({
    fs: new MemoryFs(),
    daemonKey: new Uint8Array(32).fill(9),
    now: () => 1000,
  });
  return { state, events, source, store };
}

const runtime = (f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) =>
  createOperatorWriteRuntime({
    source: f.source,
    store: f.store,
    resolveHandle: (handle) => (handle === HANDLE ? NOTE_ID : undefined),
    now: () => 1000,
    ttlMs: 60_000,
    ...extra,
  });

describe("daemon operator write runtime", () => {
  it("records a durable create operation before reporting success", async () => {
    const f = await fixture();
    const source = {
      ...f.source,
      create: async () => ({ id: NOTE_ID, titleBytes: 5, contentBytes: 7 }),
    };
    const rt = runtime(f, {
      source,
      mintHandle: () => HANDLE,
    }) as typeof runtime extends (...args: never[]) => infer R
      ? R & {
          create: (params: { title: string; content: string }) => Promise<{
            operationHandle: string;
          }>;
        }
      : never;
    const result = await rt.create({ title: "Title", content: "Content" });
    expect(result.operationHandle).toMatch(/^op_/);
    expect((await f.store.list())[0]?.state).toBe("committed");
  });

  it("leaves a create operation unresolved when the source outcome is uncertain", async () => {
    const f = await fixture();
    const source = {
      ...f.source,
      create: async () => {
        throw new Error("uncertain");
      },
    };
    const rt = runtime(f, {
      source,
      mintHandle: () => HANDLE,
    }) as typeof runtime extends (...args: never[]) => infer R
      ? R & {
          create: (params: { title: string; content: string }) => Promise<unknown>;
        }
      : never;
    await expect(rt.create({ title: "Title", content: "Content" })).rejects.toMatchObject({
      code: "service_unavailable",
    });
    expect((await f.store.list())[0]?.state).toBe("unresolved");
  });

  it("captures a trusted preimage without writing", async () => {
    const f = await fixture();
    const view = await runtime(f).editPreimage({ id: HANDLE });
    expect(view.kind).toBe("preimage");
    expect(view.id).toBe(HANDLE);
    expect(view.revision).toBe(REVISION_1);
    expect(view.markdown).toContain("before");
    expect(f.state.writes).toBe(0);
  });

  it("refuses an edit whose expected revision is stale, without writing", async () => {
    const f = await fixture();
    f.state.revision = REVISION_3;
    await expect(
      runtime(f).applyEdit({ id: HANDLE, expectedRevision: REVISION_1, markdown: "x" }),
    ).rejects.toMatchObject({ code: "stale_revision" });
    expect(f.state.writes).toBe(0);
  });

  it("treats an unchanged document as a no-op with no journal entry", async () => {
    const f = await fixture();
    const rt = runtime(f, { audit: (_event: string) => void 0 });
    const preimage = await rt.editPreimage({ id: HANDLE });
    const result = await rt.applyEdit({
      id: HANDLE,
      expectedRevision: preimage.revision,
      markdown: preimage.markdown,
    });
    expect(result.kind).toBe("edit");
    expect(result.revision).toBe(REVISION_1);
    expect(f.state.writes).toBe(0);
    expect(await f.store.list()).toEqual([]);
  });

  it("commits an edit, records a committed operation, and returns the actual revision", async () => {
    const f = await fixture();
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE });
    const markdown = preimage.markdown.replace("before", "after");
    const result = await rt.applyEdit({
      id: HANDLE,
      expectedRevision: REVISION_1,
      markdown,
    });
    expect(result.revision).toBe(REVISION_2);
    expect(f.state.writes).toBe(1);
    const records = await f.store.list();
    expect(records).toHaveLength(1);
    expect(records[0]!.state).toBe("committed");
    expect(JSON.stringify(records)).not.toContain("after");
  });

  it("commits an edit to a note whose content carries an opaque block", async () => {
    // Each load() re-decodes the stored envelope, so this is the shape the
    // daemon actually runs: preimage and apply are separate decodes.
    const f = await fixture({
      native:
        '<p>before</p><div data-type="attachment" data-id="local-reference"><img src="https://example.com/image" alt="image"></div>',
    });
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE });
    expect(preimage.markdown).toContain("nookbridge opaque");
    const result = await rt.applyEdit({
      id: HANDLE,
      expectedRevision: REVISION_1,
      markdown: preimage.markdown.replace("before", "after"),
    });
    expect(result.kind).toBe("edit");
    expect(f.state.writes).toBe(1);
  });

  it("marks an uncertain write unresolved instead of claiming success", async () => {
    const f = await fixture();
    const failing: OperatorWriteSource = {
      read: f.source.read,
      async update() {
        return { kind: "error" as const };
      },
    };
    const rt = createOperatorWriteRuntime({
      source: failing,
      store: f.store,
      resolveHandle: () => NOTE_ID,
      now: () => 1000,
      ttlMs: 60_000,
    });
    const preimage = await rt.editPreimage({ id: HANDLE });
    await expect(
      rt.applyEdit({
        id: HANDLE,
        expectedRevision: REVISION_1,
        markdown: preimage.markdown.replace("before", "after"),
      }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    const records = await f.store.list();
    expect(records).toHaveLength(1);
    expect(records[0]!.state).toBe("unresolved");
  });

  it("reports a locked refusal categorically instead of a service failure", async () => {
    // The read projection raises a locked note as `vault_locked`.  Collapsing
    // that into a generic failure made a working lock indistinguishable from a
    // broken daemon on edit-preimage, apply-edit, and apply-undo.
    const f = await fixture();
    const locked: OperatorWriteSource = {
      async read(): Promise<never> {
        throw Object.assign(new Error("ERR_VAULT_LOCKED"), { code: "ERR_VAULT_LOCKED" });
      },
      update: f.source.update,
    };
    const rt = createOperatorWriteRuntime({
      source: locked,
      store: f.store,
      resolveHandle: () => NOTE_ID,
      now: () => 1000,
      ttlMs: 60_000,
    });
    await expect(rt.editPreimage({ id: HANDLE })).rejects.toMatchObject({ code: "vault_locked" });
  });

  it("reports a locked refusal on apply-edit and apply-undo too", async () => {
    // All three write paths read through `load`, so all three must carry the
    // category; finding 5 was only proven for editPreimage at first.  The source
    // is mutable so both handles are established legitimately before the vault
    // locks, which is what makes each refusal come from the lock and not from a
    // rejected request.
    const f = await fixture();
    let locked = false;
    const source: OperatorWriteSource = {
      async read(options) {
        if (locked) {
          throw Object.assign(new Error("ERR_VAULT_LOCKED"), { code: "ERR_VAULT_LOCKED" });
        }
        return f.source.read(options);
      },
      update: f.source.update,
    };
    const rt = createOperatorWriteRuntime({
      source,
      store: f.store,
      resolveHandle: () => NOTE_ID,
      now: () => 1000,
      ttlMs: 60_000,
    });
    const preimage = await rt.editPreimage({ id: HANDLE });
    await rt.applyEdit({
      id: HANDLE,
      expectedRevision: REVISION_1,
      markdown: preimage.markdown.replace("before", "after"),
    });
    const [record] = await f.store.list();
    locked = true;
    await expect(
      rt.applyEdit({
        id: HANDLE,
        expectedRevision: REVISION_2,
        markdown: preimage.markdown,
      }),
    ).rejects.toMatchObject({ code: "vault_locked" });
    await expect(
      rt.applyUndo({
        id: HANDLE,
        operationHandle: record!.handle,
        expectedRevision: REVISION_2,
      }),
    ).rejects.toMatchObject({ code: "vault_locked" });
  });

  it("keeps every other read failure generic", async () => {
    // Guard: the widened predicate must not turn an ordinary failure into a
    // categorical lock refusal.
    const f = await fixture();
    const broken: OperatorWriteSource = {
      async read(): Promise<never> {
        throw new Error("connection reset");
      },
      update: f.source.update,
    };
    const rt = createOperatorWriteRuntime({
      source: broken,
      store: f.store,
      resolveHandle: () => NOTE_ID,
      now: () => 1000,
      ttlMs: 60_000,
    });
    await expect(rt.editPreimage({ id: HANDLE })).rejects.toMatchObject({
      code: "service_unavailable",
    });
  });

  it("undoes a committed edit by restoring the stored preimage", async () => {
    const f = await fixture();
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE });
    await rt.applyEdit({
      id: HANDLE,
      expectedRevision: REVISION_1,
      markdown: preimage.markdown.replace("before", "after"),
    });
    const [record] = await f.store.list();
    const undone = await rt.applyUndo({
      id: HANDLE,
      operationHandle: record!.handle,
      expectedRevision: REVISION_2,
    });
    expect(undone.kind).toBe("undo");
    expect(undone.revision).toBe(REVISION_3);
    expect(f.state.content.data).toContain("before");
    await expect(f.store.get(record!.handle)).resolves.toMatchObject({ state: "undone" });
  });

  it("refuses undo after a concurrent change and retains the record", async () => {
    const f = await fixture();
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE });
    await rt.applyEdit({
      id: HANDLE,
      expectedRevision: REVISION_1,
      markdown: preimage.markdown.replace("before", "after"),
    });
    const [record] = await f.store.list();
    f.state.revision = `rev_${"f".repeat(32)}`;
    await expect(
      rt.applyUndo({ id: HANDLE, operationHandle: record!.handle, expectedRevision: REVISION_2 }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(f.store.get(record!.handle)).resolves.toMatchObject({ state: "committed" });
  });

  it("marks undo unresolved when the source outcome is uncertain", async () => {
    const f = await fixture();
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE });
    await rt.applyEdit({
      id: HANDLE,
      expectedRevision: REVISION_1,
      markdown: preimage.markdown.replace("before", "after"),
    });
    const [record] = await f.store.list();
    const uncertain = createOperatorWriteRuntime({
      source: {
        read: f.source.read,
        async update() {
          return { kind: "error" as const };
        },
      },
      store: f.store,
      resolveHandle: () => NOTE_ID,
      now: () => 1000,
      ttlMs: 60_000,
    });
    await expect(
      uncertain.applyUndo({
        id: HANDLE,
        operationHandle: record!.handle,
        expectedRevision: REVISION_2,
      }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    await expect(f.store.get(record!.handle)).resolves.toMatchObject({ state: "unresolved" });
  });

  it("rejects a forged opaque sentinel before any mutation", async () => {
    const f = await fixture();
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE });
    const forged = `${preimage.markdown}\n:::nookbridge opaque unknownNode\nref:1:native-html:FORGED\n:::\n`;
    await expect(
      rt.applyEdit({ id: HANDLE, expectedRevision: REVISION_1, markdown: forged }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.state.writes).toBe(0);
    expect(await f.store.list()).toEqual([]);
  });

  it("exposes only bounded operation summaries", async () => {
    const f = await fixture();
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE });
    await rt.applyEdit({
      id: HANDLE,
      expectedRevision: REVISION_1,
      markdown: preimage.markdown.replace("before", "after"),
    });
    const [record] = await f.store.list();
    const status = await rt.operationStatus({ operationHandle: record!.handle });
    expect(status).toEqual({
      kind: "operation-status",
      operationHandle: record!.handle,
      state: "committed",
    });
    const list = await rt.operationList();
    expect(list).toEqual({
      kind: "operation-list",
      handles: [record!.handle],
      unresolvedHandles: [],
    });
  });
});
