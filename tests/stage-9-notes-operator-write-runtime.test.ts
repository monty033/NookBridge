import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

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
const PEER = { uid: 1000, gid: 1000, groups: ["nookbridge-operators"] };
const OTHER = { uid: 1001, gid: 1000, groups: ["nookbridge-operators"] };

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
          create: (
            params: { title: string; content: string },
            peer?: unknown,
          ) => Promise<{
            operationHandle: string;
          }>;
        }
      : never;
    const result = await rt.create({ title: "Title", content: "Content" }, PEER);
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
          create: (params: { title: string; content: string }, peer?: unknown) => Promise<unknown>;
        }
      : never;
    await expect(rt.create({ title: "Title", content: "Content" }, PEER)).rejects.toMatchObject({
      code: "service_unavailable",
    });
    expect((await f.store.list())[0]?.state).toBe("unresolved");
  });

  it("captures a trusted preimage without writing", async () => {
    const f = await fixture();
    const view = await runtime(f).editPreimage({ id: HANDLE }, PEER);
    expect(view.kind).toBe("preimage");
    expect(view.id).toBe(HANDLE);
    expect(view.revision).toBe(REVISION_1);
    expect(view.markdown).toContain("before");
    expect(f.state.writes).toBe(0);
  });

  it("keeps the preimage strict for content the tolerant read fallback can view", async () => {
    // D6-2 lock: the operator get-view may approximate content the strict
    // decoder refuses, but a preimage is an edit baseline.  It must still
    // refuse that content rather than hand back an approximation.
    const f = await fixture({ native: '<p style="color:red">before</p>' });
    await expect(runtime(f).editPreimage({ id: HANDLE }, PEER)).rejects.toMatchObject({
      code: "service_unavailable",
    });
    expect(f.state.writes).toBe(0);
  });

  it("refuses an edit whose expected revision is stale, without writing", async () => {
    const f = await fixture();
    f.state.revision = REVISION_3;
    await expect(
      runtime(f).applyEdit({ id: HANDLE, expectedRevision: REVISION_1, markdown: "x" }, PEER),
    ).rejects.toMatchObject({ code: "stale_revision" });
    expect(f.state.writes).toBe(0);
  });

  it("treats an unchanged document as a no-op with no journal entry", async () => {
    const f = await fixture();
    const rt = runtime(f, { audit: (_event: string) => void 0 });
    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    const result = await rt.applyEdit(
      {
        id: HANDLE,
        expectedRevision: preimage.revision,
        markdown: preimage.markdown,
      },
      PEER,
    );
    expect(result.kind).toBe("edit");
    expect(result.revision).toBe(REVISION_1);
    expect(f.state.writes).toBe(0);
    expect(await f.store.list()).toEqual([]);
  });

  it("commits an edit, records a committed operation, and returns the actual revision", async () => {
    const f = await fixture();
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    const markdown = preimage.markdown.replace("before", "after");
    const result = await rt.applyEdit(
      {
        id: HANDLE,
        expectedRevision: REVISION_1,
        markdown,
      },
      PEER,
    );
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
    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    expect(preimage.markdown).toContain("nookbridge opaque");
    const result = await rt.applyEdit(
      {
        id: HANDLE,
        expectedRevision: REVISION_1,
        markdown: preimage.markdown.replace("before", "after"),
      },
      PEER,
    );
    expect(result.kind).toBe("edit");
    expect(f.state.writes).toBe(1);
  });

  it("baseline: edits text while preserving image, attachment, and embed blocks byte-for-byte", async () => {
    const image = '<img src="https://example.com/image.png" alt="image" data-note="image-opaque">';
    const attachment =
      '<div data-type="attachment" data-id="attachment-opaque"><a href="https://example.com/file.bin">file.bin</a></div>';
    const embed =
      '<div data-type="embed" data-url="https://example.com/embed"><p>embedded payload</p></div>';
    const originalData = `<p>before</p>${image}${attachment}${embed}`;
    const f = await fixture({ native: originalData });
    const rt = runtime(f);

    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    const placeholders = preimage.markdown.match(
      /^:::nookbridge opaque [A-Za-z][A-Za-z0-9_-]*\nref:1:(?:native-html|native-tiptap):[A-Za-z0-9_-]+\n:::$/gm,
    );
    expect(placeholders).toHaveLength(3);
    expect(preimage.markdown).not.toContain("example.com");
    expect(preimage.markdown).not.toContain("attachment-opaque");
    expect(preimage.markdown).not.toContain("image-opaque");

    const result = await rt.applyEdit(
      {
        id: HANDLE,
        expectedRevision: preimage.revision,
        markdown: preimage.markdown.replace("before", "after"),
      },
      PEER,
    );

    expect(result.kind).toBe("edit");
    expect(Buffer.from(f.state.content.data, "utf8")).toEqual(
      Buffer.from(wrap(`<p>after</p>${image}${attachment}${embed}`).data, "utf8"),
    );
    expect(Buffer.from(f.state.content.data, "utf8").includes(Buffer.from(image))).toBe(true);
    expect(Buffer.from(f.state.content.data, "utf8").includes(Buffer.from(attachment))).toBe(true);
    expect(Buffer.from(f.state.content.data, "utf8").includes(Buffer.from(embed))).toBe(true);
  });

  it.each([
    [
      "moved",
      (refs: readonly string[], markdown: string) =>
        markdown
          .replace(refs[0]!, "TEMP")
          .replace(refs[1]!, refs[0]!)
          .replace("TEMP", refs[1]!),
    ],
    [
      "deleted",
      (refs: readonly string[], markdown: string) => markdown.replace(`\n\n${refs[1]!}`, ""),
    ],
    [
      "duplicated",
      (refs: readonly string[], markdown: string) =>
        markdown.replace(refs[1]!, `${refs[1]}\n\n${refs[1]}`),
    ],
    [
      "altered nodeType",
      (refs: readonly string[], markdown: string) =>
        markdown.replace(refs[0]!, refs[0]!.replace("opaque img", "opaque altered-node")),
    ],
    [
      "altered sentinel",
      (refs: readonly string[], markdown: string) =>
        markdown.replace(
          refs[0]!,
          refs[0]!.replace(
            /ref:1:native-html:[A-Za-z0-9_-]+/,
            "ref:1:native-tiptap:altered-sentinel",
          ),
        ),
    ],
    [
      "forged",
      (_refs: readonly string[], markdown: string) =>
        `${markdown}\n:::nookbridge opaque forged\nref:1:native-html:forged-placeholder\n:::\n`,
    ],
  ] as const)("refuses a %s opaque placeholder before any mutation", async (_name, mutate) => {
    const image = '<img src="https://example.com/image.png" alt="image" data-note="image-opaque">';
    const attachment =
      '<div data-type="attachment" data-id="attachment-opaque"><a href="https://example.com/file.bin">file.bin</a></div>';
    const embed =
      '<div data-type="embed" data-url="https://example.com/embed"><p>embedded payload</p></div>';
    const f = await fixture({ native: `<p>before</p>${image}${attachment}${embed}` });
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    const refs = preimage.markdown.match(/:::nookbridge opaque [\s\S]*?:::/g) ?? [];
    const before = Buffer.from(f.state.content.data, "utf8");

    await expect(
      rt.applyEdit(
        {
          id: HANDLE,
          expectedRevision: REVISION_1,
          markdown: mutate(refs, preimage.markdown),
        },
        PEER,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.state.writes).toBe(0);
    expect(Buffer.from(f.state.content.data, "utf8")).toEqual(before);
    expect(await f.store.list()).toEqual([]);
  });

  it("refuses a valid opaque placeholder from an older revision before any mutation", async () => {
    // Mutation target: removing the revision from the native sentinel hash
    // makes this stale Markdown pass the parser and causes a second write.
    const image = '<img src="https://example.com/image.png" alt="image" data-note="image-opaque">';
    const attachment =
      '<div data-type="attachment" data-id="attachment-opaque"><a href="https://example.com/file.bin">file.bin</a></div>';
    const embed =
      '<div data-type="embed" data-url="https://example.com/embed"><p>embedded payload</p></div>';
    const f = await fixture({ native: `<p>before</p>${image}${attachment}${embed}` });
    const rt = runtime(f);
    const oldPreimage = await rt.editPreimage({ id: HANDLE }, PEER);
    await rt.applyEdit(
      {
        id: HANDLE,
        expectedRevision: REVISION_1,
        markdown: oldPreimage.markdown.replace("before", "after"),
      },
      PEER,
    );
    const after = Buffer.from(f.state.content.data, "utf8");
    const records = await f.store.list();

    await expect(
      rt.applyEdit(
        { id: HANDLE, expectedRevision: REVISION_2, markdown: oldPreimage.markdown },
        PEER,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.state.writes).toBe(1);
    expect(Buffer.from(f.state.content.data, "utf8")).toEqual(after);
    expect(await f.store.list()).toEqual(records);
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
    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    await expect(
      rt.applyEdit(
        {
          id: HANDLE,
          expectedRevision: REVISION_1,
          markdown: preimage.markdown.replace("before", "after"),
        },
        PEER,
      ),
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
    await expect(rt.editPreimage({ id: HANDLE }, PEER)).rejects.toMatchObject({
      code: "vault_locked",
    });
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
    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    await rt.applyEdit(
      {
        id: HANDLE,
        expectedRevision: REVISION_1,
        markdown: preimage.markdown.replace("before", "after"),
      },
      PEER,
    );
    const [record] = await f.store.list();
    locked = true;
    await expect(
      rt.applyEdit(
        {
          id: HANDLE,
          expectedRevision: REVISION_2,
          markdown: preimage.markdown,
        },
        PEER,
      ),
    ).rejects.toMatchObject({ code: "vault_locked" });
    await expect(
      rt.applyUndo(
        {
          id: HANDLE,
          operationHandle: record!.handle,
          expectedRevision: REVISION_2,
        },
        PEER,
      ),
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
    await expect(rt.editPreimage({ id: HANDLE }, PEER)).rejects.toMatchObject({
      code: "service_unavailable",
    });
  });

  it("undoes a committed edit by restoring the stored preimage", async () => {
    const f = await fixture();
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    await rt.applyEdit(
      {
        id: HANDLE,
        expectedRevision: REVISION_1,
        markdown: preimage.markdown.replace("before", "after"),
      },
      PEER,
    );
    const [record] = await f.store.list();
    const undone = await rt.applyUndo(
      {
        id: HANDLE,
        operationHandle: record!.handle,
        expectedRevision: REVISION_2,
      },
      PEER,
    );
    expect(undone.kind).toBe("undo");
    expect(undone.revision).toBe(REVISION_3);
    expect(f.state.content.data).toContain("before");
    await expect(f.store.get(record!.handle)).resolves.toMatchObject({ state: "undone" });
  });

  it("undoes an opaque-block edit to the exact original native bytes", async () => {
    const image = '<img src="https://example.com/image.png" alt="image" data-note="image-opaque">';
    const attachment =
      '<div data-type="attachment" data-id="attachment-opaque"><a href="https://example.com/file.bin">file.bin</a></div>';
    const embed =
      '<div data-type="embed" data-url="https://example.com/embed"><p>embedded payload</p></div>';
    const f = await fixture({ native: `<p>before</p>${image}${attachment}${embed}` });
    const original = Buffer.from(f.state.content.data, "utf8");
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    await rt.applyEdit(
      {
        id: HANDLE,
        expectedRevision: REVISION_1,
        markdown: preimage.markdown.replace("before", "after"),
      },
      PEER,
    );
    const [record] = await f.store.list();
    await rt.applyUndo(
      { id: HANDLE, operationHandle: record!.handle, expectedRevision: REVISION_2 },
      PEER,
    );
    expect(Buffer.from(f.state.content.data, "utf8")).toEqual(original);
  });

  it("refuses undo after a concurrent change and retains the record", async () => {
    const f = await fixture();
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    await rt.applyEdit(
      {
        id: HANDLE,
        expectedRevision: REVISION_1,
        markdown: preimage.markdown.replace("before", "after"),
      },
      PEER,
    );
    const [record] = await f.store.list();
    f.state.revision = `rev_${"f".repeat(32)}`;
    await expect(
      rt.applyUndo(
        { id: HANDLE, operationHandle: record!.handle, expectedRevision: REVISION_2 },
        PEER,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(f.store.get(record!.handle)).resolves.toMatchObject({ state: "committed" });
  });

  it("marks undo unresolved when the source outcome is uncertain", async () => {
    const f = await fixture();
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    await rt.applyEdit(
      {
        id: HANDLE,
        expectedRevision: REVISION_1,
        markdown: preimage.markdown.replace("before", "after"),
      },
      PEER,
    );
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
      uncertain.applyUndo(
        {
          id: HANDLE,
          operationHandle: record!.handle,
          expectedRevision: REVISION_2,
        },
        PEER,
      ),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    await expect(f.store.get(record!.handle)).resolves.toMatchObject({ state: "unresolved" });
  });

  it("rejects a forged opaque sentinel before any mutation", async () => {
    const f = await fixture();
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    const forged = `${preimage.markdown}\n:::nookbridge opaque unknownNode\nref:1:native-html:FORGED\n:::\n`;
    await expect(
      rt.applyEdit({ id: HANDLE, expectedRevision: REVISION_1, markdown: forged }, PEER),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.state.writes).toBe(0);
    expect(await f.store.list()).toEqual([]);
  });

  it("exposes only bounded operation summaries", async () => {
    const f = await fixture();
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    await rt.applyEdit(
      {
        id: HANDLE,
        expectedRevision: REVISION_1,
        markdown: preimage.markdown.replace("before", "after"),
      },
      PEER,
    );
    const [record] = await f.store.list();
    const status = await rt.operationStatus({ operationHandle: record!.handle }, PEER);
    expect(status).toEqual({
      kind: "operation-status",
      operationHandle: record!.handle,
      state: "committed",
    });
    const list = await rt.operationList(PEER);
    expect(list).toEqual({
      kind: "operation-list",
      handles: [record!.handle],
      unresolvedHandles: [],
    });
  });
});

describe("D3-2 — undefined operator peers are rejected", () => {
  const OP = `op_${"a".repeat(64)}`;

  async function guarded() {
    const f = await fixture();
    const resolveHandle = vi.fn((handle: string) => (handle === HANDLE ? NOTE_ID : undefined));
    const read = vi.fn(f.source.read);
    const update = vi.fn(f.source.update);
    const createSource = vi.fn(async () => ({ id: NOTE_ID, titleBytes: 5, contentBytes: 7 }));
    const mintHandle = vi.fn(() => HANDLE);
    const insert = vi.fn(f.store.insert);
    const get = vi.fn(f.store.get);
    const list = vi.fn(f.store.list);
    const transition = vi.fn(f.store.transition);
    const rt = createOperatorWriteRuntime({
      source: { read, update, create: createSource },
      store: { insert, get, list, transition },
      resolveHandle,
      mintHandle,
      now: () => 1000,
      ttlMs: 60_000,
    });
    const spies = [
      resolveHandle,
      read,
      update,
      createSource,
      mintHandle,
      insert,
      get,
      list,
      transition,
    ];
    const calls = (peer: unknown) => {
      const p = peer as never;
      return {
        create: () => rt.create!({ title: "Title", content: "Content" }, p),
        editPreimage: () => rt.editPreimage({ id: HANDLE }, p),
        applyEdit: () =>
          rt.applyEdit({ id: HANDLE, expectedRevision: REVISION_1, markdown: "x" }, p),
        applyUndo: () => rt.applyUndo({ operationHandle: OP }, p),
        operationStatus: () => rt.operationStatus({ operationHandle: OP }, p),
        operationList: () => rt.operationList(p),
      };
    };
    return { f, rt, spies, calls };
  }

  const BAD = [
    undefined,
    null,
    {},
    { uid: -1, gid: 1, groups: [] },
    { uid: 1, gid: 1, groups: "x" },
  ];
  const ENTRY = [
    "create",
    "editPreimage",
    "applyEdit",
    "applyUndo",
    "operationStatus",
    "operationList",
  ] as const;

  it.each(BAD)("rejects every entry point for peer %j", async (peer) => {
    const { calls } = await guarded();
    for (const name of ENTRY) {
      await expect(calls(peer)[name]()).rejects.toMatchObject({ code: "permission_denied" });
    }
  });

  it.each(BAD)("touches no resolver, source, store or minter for peer %j", async (peer) => {
    const { calls, spies } = await guarded();
    for (const name of ENTRY) {
      await calls(peer)
        [name]()
        .catch(() => undefined);
      for (const spy of spies) expect(spy).toHaveBeenCalledTimes(0);
    }
  });

  it("leaves records owned by the removed legacy owner unreachable", async () => {
    const { f, rt } = await guarded();
    const fields = {
      owner: "legacy",
      noteId: NOTE_ID,
      revision: REVISION_1,
      content: wrap("<p>before</p>"),
    };
    const payload = JSON.stringify({ ...fields, postRevision: REVISION_2, createdAt: 1000 });
    const record = await f.store.insert({
      kind: "edit",
      payload: JSON.stringify(fields),
      ttlMs: 60_000,
    });
    await f.store.transition(record.handle, "prepared", "committing", undefined, "legacy");
    await f.store.transition(record.handle, "committing", "committed", payload, "legacy");
    expect((await rt.operationList(PEER)).handles).not.toContain(record.handle);
    await expect(
      rt.operationStatus({ operationHandle: record.handle }, PEER),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps operations scoped to the peer that created them", async () => {
    const { rt } = await guarded();
    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    await rt.applyEdit(
      {
        id: HANDLE,
        expectedRevision: REVISION_1,
        markdown: preimage.markdown.replace("before", "after"),
      },
      PEER,
    );
    const [handle] = (await rt.operationList(PEER)).handles;
    expect(handle).toBeDefined();
    await expect(rt.operationStatus({ operationHandle: handle! }, OTHER)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await rt.operationList(OTHER)).handles).not.toContain(handle);
  });

  it("does not mention the legacy owner in the runtime source", () => {
    const source = readFileSync("src/service/notes-operator-write-runtime.ts", "utf8");
    expect(source).not.toContain("legacy");
  });
});
