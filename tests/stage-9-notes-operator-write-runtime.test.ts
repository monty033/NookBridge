import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { handleRpcRequest } from "../src/service/rpc-handler.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import {
  createOperatorWriteRuntime,
  type OperatorStoredContent,
  type OperatorWriteSource,
} from "../src/service/notes-operator-write-runtime.js";
import { createNotesUndoStore, type OperationStoreFs } from "../src/service/notes-undo-store.js";
import { decodeNoteDocumentNative } from "../src/core/note-document-native.js";
import {
  expectedPlaceholderToken,
  useFixturePlaceholderKey,
} from "./helpers/opaque-placeholder-token.js";

const HANDLE = "h_noteone";
const NOTE_ID = "note-1";
const NOTE_A = "note-a";
const NOTE_B = "note-b";
const HANDLE_A = "h_notea";
const HANDLE_B = "h_noteb";
const REVISION_1 = `rev_${"1".repeat(32)}`;
const REVISION_2 = `rev_${"2".repeat(32)}`;
const REVISION_3 = `rev_${"3".repeat(32)}`;
const PEER = { uid: 1000, gid: 1000, groups: ["nookbridge-operators"] };
const OTHER = { uid: 1001, gid: 1000, groups: ["nookbridge-operators"] };

function threeOpaqueBlocks() {
  const image =
    '<img src="https://example.com/image.png" alt="image" data-note="image-opaque" data-path="/private/notes/image.bin">';
  const attachment =
    '<div data-type="attachment" data-id="attachment-opaque"><a href="https://example.com/file.bin">file.bin</a></div>';
  const embed =
    '<div data-type="embed" data-url="https://example.com/embed"><p>embedded payload</p></div>';
  return { image, attachment, embed, native: `<p>before</p>${image}${attachment}${embed}` };
}

function refAt(refs: readonly string[], index: number): string {
  const ref = refs[index];
  if (ref === undefined) throw new Error(`missing opaque placeholder ${index}`);
  return ref;
}

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

async function twoNoteFixture() {
  const native = threeOpaqueBlocks().native;
  const states = new Map<
    string,
    { revision: string; content: OperatorStoredContent; writes: number }
  >([
    [NOTE_A, { revision: REVISION_1, content: wrap(native), writes: 0 }],
    [NOTE_B, { revision: REVISION_1, content: wrap(native), writes: 0 }],
  ]);
  const events: string[] = [];
  const source: OperatorWriteSource = {
    async read(noteId: string) {
      const state = states.get(noteId);
      return state === undefined
        ? undefined
        : { revision: state.revision, content: { ...state.content } };
    },
    async update(command) {
      events.push(`update:${command.noteId}:${command.expectedRevision}`);
      const state = states.get(command.noteId);
      if (state === undefined) return { kind: "missing" as const };
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
  return { states, events, source, store };
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

beforeAll(() => useFixturePlaceholderKey());
const keyedToken = (index: number, raw: string): string =>
  expectedPlaceholderToken(NOTE_ID, REVISION_1, index, raw);

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
    const f = await fixture({ native: '<p><a href="javascript:alert(1)">before</a></p>' });
    await expect(runtime(f).editPreimage({ id: HANDLE }, PEER)).rejects.toMatchObject({
      code: "service_unavailable",
      message: "service_unavailable",
    });
    expect(f.state.writes).toBe(0);
    expect(await f.store.list()).toEqual([]);
  });

  it("refuses an edit when only the tolerant read decoder can view the stored content", async () => {
    const f = await fixture({ native: '<p><a href="javascript:alert(1)">before</a></p>' });
    await expect(
      runtime(f).applyEdit({ id: HANDLE, expectedRevision: REVISION_1, markdown: "# after" }, PEER),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    expect(f.state.writes).toBe(0);
    expect(await f.store.list()).toEqual([]);
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

  it("accepts the Markdown and revision returned by notes.get", async () => {
    const { native } = threeOpaqueBlocks();
    const f = await fixture({ native });
    const response = await handleRpcRequest(
      { id: "rpc-get-handoff", method: "notes.get", params: { id: NOTE_ID } },
      {
        search: async () => [],
        noteMetadata: async () => ({ id: NOTE_ID, title: "Title", revision: REVISION_1 }),
        readOnly: { readOperatorNoteContent: async () => f.state.content },
      },
      createReadWriteNoDeleteServicePolicy(),
    );
    if (!response.ok || response.result.kind !== "note") throw new Error("expected note response");
    if (
      response.result.contentStatus !== "ok" ||
      typeof response.result.markdown !== "string" ||
      typeof response.result.note.revision !== "string"
    )
      throw new Error("expected apply-ready notes.get response");

    const result = await runtime(f).applyEdit(
      {
        id: HANDLE,
        expectedRevision: response.result.note.revision,
        markdown: response.result.markdown.replace("before", "after"),
      },
      PEER,
    );
    expect(result.kind).toBe("edit");
    expect(f.state.writes).toBe(1);
  });

  it("binds opaque sentinels to the exact note-id and revision preimage", async () => {
    const { image } = threeOpaqueBlocks();
    const f = await fixture({ native: image });
    const preimage = await runtime(f).editPreimage({ id: HANDLE }, PEER);
    const match = preimage.markdown.match(
      /^:::nookbridge opaque img\nref:1:native-html:([A-Za-z0-9_-]+)\n:::$/m,
    );
    if (match === null) throw new Error("missing image opaque sentinel");
    expect(match[1]).toBe(keyedToken(0, image));
    let thrown: unknown;
    try {
      decodeNoteDocumentNative(wrap(image), {
        noteId: NOTE_ID,
        revision: 1 as unknown as string,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "unsupported_content" });
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Native note content is not supported");
    expect((thrown as Error).message).not.toContain(image);
  });

  it("refuses a pre-D6-1 opaque sentinel on the edit path", async () => {
    const { image } = threeOpaqueBlocks();
    const f = await fixture({ native: `<p>before</p>${image}` });
    const preimage = await runtime(f).editPreimage({ id: HANDLE }, PEER);
    const legacy = createHash("sha256").update(`${0}\u0000${image}`).digest("hex").slice(0, 36);
    const markdown = preimage.markdown
      .replace(/ref:1:native-html:[A-Za-z0-9_-]+/, `ref:1:native-html:${legacy}`)
      .replace("before", "after");

    await expect(
      runtime(f).applyEdit({ id: HANDLE, expectedRevision: preimage.revision, markdown }, PEER),
    ).rejects.toMatchObject({ code: "invalid_request", message: "invalid_request" });
    expect(f.state.writes).toBe(0);
    expect(await f.store.list()).toEqual([]);
  });

  it("refuses opaque sentinels minted for note A when applied to note B", async () => {
    // Mutation target: dropping noteId from bindingKey must make this real
    // text edit look valid; the pinned sentinels and categorical refusal catch
    // that binding regression rather than a no-op refusal.
    const f = await twoNoteFixture();
    const rt = runtime(f, {
      resolveHandle: (handle: string) =>
        handle === HANDLE_A ? NOTE_A : handle === HANDLE_B ? NOTE_B : undefined,
    });
    const preimageA = await rt.editPreimage({ id: HANDLE_A }, PEER);
    const beforeB = Buffer.from(f.states.get(NOTE_B)!.content.data, "utf8");
    const revisionB = f.states.get(NOTE_B)!.revision;

    await expect(
      rt.applyEdit(
        {
          id: HANDLE_B,
          expectedRevision: revisionB,
          markdown: preimageA.markdown.replace("before", "after"),
        },
        PEER,
      ),
    ).rejects.toMatchObject({ code: "invalid_request", message: "invalid_request" });
    expect(f.states.get(NOTE_A)!.writes).toBe(0);
    expect(f.states.get(NOTE_B)!.writes).toBe(0);
    expect(Buffer.from(f.states.get(NOTE_B)!.content.data, "utf8")).toEqual(beforeB);
    expect(await f.store.list()).toEqual([]);
  });

  it("edits text while preserving opaque blocks nested in blockquotes and callouts", async () => {
    // Mutation target: dropping binding from either recursive decode makes the
    // pinned traversal-index sentinels disagree and refuses this edit.
    const { image, embed } = threeOpaqueBlocks();
    const native =
      `<blockquote><p>before</p>${image}</blockquote>` +
      `<div data-type="callout" data-variant="warning"><p>callout</p>${embed}</div>`;
    const f = await fixture({ native });
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    const placeholders = preimage.markdown.match(/:::nookbridge opaque [\s\S]*?:::/g);
    expect(placeholders, "expected nested opaque placeholders").toHaveLength(2);
    for (const [index, raw] of [image, embed].entries()) {
      const token = keyedToken(index, raw);
      expect(preimage.markdown, `missing nested sentinel ${index}`).toContain(
        `ref:1:native-html:${token}`,
      );
    }

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
      Buffer.from(
        wrap(
          `<blockquote><p>after</p>${image}</blockquote><div data-type="callout" data-variant="warning"><p>callout</p>${embed}</div>`,
        ).data,
        "utf8",
      ),
    );
  });

  it("baseline: edits text while preserving image, attachment, and embed blocks byte-for-byte", async () => {
    const { image, attachment, embed, native } = threeOpaqueBlocks();
    const f = await fixture({ native });
    const rt = runtime(f);

    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    const placeholders = preimage.markdown.match(
      /^:::nookbridge opaque [A-Za-z][A-Za-z0-9_-]*\nref:1:(?:native-html|native-tiptap):[A-Za-z0-9_-]+\n:::$/gm,
    );
    expect(placeholders, "expected three opaque placeholders").toHaveLength(3);
    expect(preimage.markdown).not.toContain("example.com");
    expect(preimage.markdown).not.toContain("attachment-opaque");
    expect(preimage.markdown).not.toContain("image-opaque");
    expect(preimage.markdown).not.toContain("/private/notes/");

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
  });

  it.each([
    [
      "moved",
      (refs: readonly string[], markdown: string) =>
        markdown
          .replace(refAt(refs, 0), "TEMP")
          .replace(refAt(refs, 1), refAt(refs, 0))
          .replace("TEMP", refAt(refs, 1)),
    ],
    [
      "re-nested",
      (refs: readonly string[], markdown: string) =>
        markdown.replace(
          refAt(refs, 0),
          refAt(refs, 0)
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        ),
    ],
    [
      "deleted",
      (refs: readonly string[], markdown: string) => markdown.replace(refAt(refs, 1), ""),
    ],
    [
      "duplicated",
      (refs: readonly string[], markdown: string) =>
        markdown.replace(refAt(refs, 1), `${refAt(refs, 1)}\n\n${refAt(refs, 1)}`),
    ],
    [
      "altered valid nodeType",
      (refs: readonly string[], markdown: string) =>
        markdown.replace(refAt(refs, 0), refAt(refs, 0).replace("opaque img", "opaque embed")),
    ],
    [
      "altered sentinel",
      (refs: readonly string[], markdown: string) =>
        markdown.replace(
          refAt(refs, 0),
          refAt(refs, 0).replace(/ref:1:native-html:/, "ref:1:native-tiptap:"),
        ),
    ],
    [
      "forged",
      (refs: readonly string[], markdown: string) => {
        const token = /native-html:([A-Za-z0-9_-]+)/.exec(refAt(refs, 0))?.[1];
        if (token === undefined) throw new Error("missing trusted opaque token");
        return `${markdown}\n:::nookbridge opaque forged\nref:1:native-html:${token}\n:::\n`;
      },
    ],
  ] as const)("refuses a %s opaque placeholder before any mutation", async (_name, mutate) => {
    const { native } = threeOpaqueBlocks();
    const f = await fixture({ native });
    const rt = runtime(f);
    const preimage = await rt.editPreimage({ id: HANDLE }, PEER);
    const refs = preimage.markdown.match(/:::nookbridge opaque [\s\S]*?:::/g);
    expect(refs, "expected opaque placeholders before mutation").not.toBeNull();
    if (refs === null) throw new Error("missing opaque placeholders before mutation");
    const before = Buffer.from(f.state.content.data, "utf8");

    await expect(
      rt.applyEdit(
        {
          id: HANDLE,
          expectedRevision: preimage.revision,
          markdown: mutate(refs, preimage.markdown),
        },
        PEER,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.state.writes).toBe(0);
    expect(Buffer.from(f.state.content.data, "utf8")).toEqual(before);
    expect(await f.store.list()).toEqual([]);
    const decoded = decodeNoteDocumentNative(f.state.content, {
      noteId: NOTE_ID,
      revision: REVISION_1,
    });
    const imageBlock = decoded.document.blocks.find((block) => block.type === "opaque");
    if (imageBlock?.type !== "opaque") throw new Error("stored image did not decode as opaque");
    expect(imageBlock.nodeType).toBe("img");
  });

  it("refuses a valid opaque placeholder from an older revision before any mutation", async () => {
    // Mutation target: removing the revision from the native sentinel hash
    // makes this stale Markdown pass the parser and causes a second write.
    const { native } = threeOpaqueBlocks();
    const f = await fixture({ native });
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
    const { image, attachment, embed, native } = threeOpaqueBlocks();
    const f = await fixture({ native });
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

    const fresh = await rt.editPreimage({ id: HANDLE }, PEER);
    expect(fresh.revision).toBe(REVISION_3);
    const further = await rt.applyEdit(
      {
        id: HANDLE,
        expectedRevision: fresh.revision,
        markdown: fresh.markdown.replace("before", "final"),
      },
      PEER,
    );
    expect(further.kind).toBe("edit");
    expect(f.state.writes).toBe(3);
    expect(Buffer.from(f.state.content.data, "utf8")).toEqual(
      Buffer.from(wrap(`<p>final</p>${image}${attachment}${embed}`).data, "utf8"),
    );
  });

  it("does not permit undo of an unresolved operation", async () => {
    const f = await fixture();
    f.state.revision = REVISION_2;
    const owner = `${PEER.uid}:${PEER.gid}:${PEER.groups.join(",")}`;
    const record = await f.store.insert({
      kind: "edit",
      payload: JSON.stringify({
        owner,
        noteId: NOTE_ID,
        revision: REVISION_1,
        content: f.state.content,
        postRevision: REVISION_2,
      }),
      ttlMs: 60_000,
    });
    await f.store.transition(record.handle, "prepared", "committing", undefined, owner);
    await f.store.transition(record.handle, "committing", "unresolved", undefined, owner);

    await expect(
      runtime(f).applyUndo(
        { id: HANDLE, operationHandle: record.handle, expectedRevision: REVISION_2 },
        PEER,
      ),
    ).rejects.toMatchObject({ code: "conflict", message: "conflict" });
    await expect(f.store.get(record.handle)).resolves.toMatchObject({ state: "unresolved" });
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
