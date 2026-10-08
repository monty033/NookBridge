/**
 * Public `notes.create` versioned-document parity.
 *
 * Canonical v1 Markdown (`---\nnookbridge-format: 1\n---\n` header) must reach
 * the persisted content row through the strict canonical parser and the native
 * serializer, so the public `notes.get` projection reads back the exact bytes
 * that were written. Any reserved-version claim that is not exactly canonical
 * must refuse before the first mutator and never fall back to the legacy
 * Markdown codec.
 *
 * The fake write seam PERSISTS content, and every read goes through the real
 * public handler and the real read-only projection, so these tests prove the
 * round trip rather than inspecting adapter arguments.
 */
import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import {
  createNotesnookWriteAdapter,
  type NotesnookStoredContent,
  type NotesnookWriteDatabase,
  type NotesnookWriteMarkdownCodec,
} from "../src/core/notesnook-write-adapter.js";
import { createDeterministicMarkdownCodec } from "../src/core/notesnook-write-codec.js";
import { createNotesnookReadOnlyAdapter } from "../src/core/notesnook-readonly-adapter.js";
import { flattenLiveDatabaseToReadOnly } from "../src/core/notesnook-readonly-projection.js";
import type { NotesnookLiveDatabase } from "../src/core/notesnook-core-adapter.js";
import { decodeNoteDocumentNative } from "../src/core/note-document-native.js";
import { serializeNoteDocumentMarkdown } from "../src/core/note-document-markdown.js";
import { handleRpcRequest } from "../src/service/rpc-handler.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";

const HEADER = "---\nnookbridge-format: 1\n---\n";
const canonical = (body: string): string => `${HEADER}\n${body}\n`;

interface StoredRow {
  readonly id: string;
  readonly title: string;
  readonly dateEdited: number;
  readonly content: NotesnookStoredContent;
}

const MUTATORS = [
  "notesAdd",
  "notesUpdate",
  "notesDelete",
  "notesTouch",
  "contentAdd",
  "contentUpdateByNoteId",
  "notebookAddNote",
  "notebookRemoveNote",
  "tagAdd",
  "relationAdd",
  "relationRemove",
] as const;

function createWorld(
  options: {
    readonly notebooks?: readonly string[];
    readonly codec?: NotesnookWriteMarkdownCodec;
  } = {},
) {
  const rows = new Map<string, StoredRow>();
  const knownNotebooks = new Set(options.notebooks ?? []);
  let counter = 0;
  const spies = {
    notesAdd: vi.fn(
      async (input: { title: string; content: NotesnookStoredContent }): Promise<string> => {
        counter += 1;
        const id = `0123456789abcdef0123456789ab${String(counter).padStart(4, "0")}`;
        rows.set(id, {
          id,
          title: input.title,
          dateEdited: 1_700_000_000_000 + counter,
          content: { type: input.content.type, data: input.content.data },
        });
        return id;
      },
    ),
    notesUpdate: vi.fn(async () => undefined),
    notesDelete: vi.fn(async () => undefined),
    notesTouch: vi.fn(async () => undefined),
    contentAdd: vi.fn(async () => "content-id"),
    contentUpdateByNoteId: vi.fn(async () => undefined),
    notebookAddNote: vi.fn(async () => undefined),
    notebookRemoveNote: vi.fn(async () => undefined),
    tagAdd: vi.fn(async () => "tag-id"),
    relationAdd: vi.fn(async () => undefined),
    relationRemove: vi.fn(async () => undefined),
  };
  const database = {
    ...spies,
    note: vi.fn(async (id: string) => {
      const row = rows.get(id);
      return row === undefined
        ? undefined
        : {
            id,
            title: row.title,
            pinned: false,
            favorite: false,
            conflicted: false,
            locked: false,
            dateEdited: row.dateEdited,
          };
    }),
    contentFindByNoteId: vi.fn(async (id: string) => {
      const row = rows.get(id);
      return row === undefined
        ? undefined
        : { id: `content-${id}`, noteId: id, type: row.content.type, data: row.content.data };
    }),
    notebookExists: vi.fn(async (id: string) => knownNotebooks.has(id)),
    notebookNotes: vi.fn(async () => [] as readonly string[]),
    tagExists: vi.fn(async (id: string) => id === "known-tag"),
    relationListForNote: vi.fn(async () => [] as readonly unknown[]),
  } as unknown as NotesnookWriteDatabase;

  const live = {
    setup: vi.fn(),
    host: vi.fn(),
    init: vi.fn(async () => undefined),
    user: {},
    tokenManager: {},
    kv: vi.fn(() => ({})),
    syncer: { start: vi.fn(async () => true) },
    notebooks: {
      all: { ids: async () => [] as string[] },
      notebook: async () => undefined,
      notes: async () => [] as string[],
    },
    notes: {
      all: { ids: async () => [...rows.keys()] },
      note: async (id: string) => {
        const row = rows.get(id);
        return row === undefined
          ? undefined
          : { id, title: row.title, dateEdited: row.dateEdited, contentId: `content-${id}` };
      },
    },
    content: {
      findByNoteId: async (id: string) => {
        const row = rows.get(id);
        return row === undefined ? undefined : { locked: false, ...row.content };
      },
    },
    relations: { from: vi.fn(() => ({ has: () => Promise.resolve(false) })) },
    lookup: {
      notes: async () => ({ ids: async () => [] as string[] }),
      notebooks: async () => ({ ids: async () => [] as string[] }),
    },
    lastSynced: async () => 0,
    hasUnsyncedChanges: async () => false,
  } as unknown as NotesnookLiveDatabase;

  const adapter = createNotesnookWriteAdapter({
    source: database,
    codec: options.codec ?? createDeterministicMarkdownCodec(),
  });
  const reader = createNotesnookReadOnlyAdapter({ source: flattenLiveDatabaseToReadOnly(live) });
  const runtime = {
    search: reader.search.bind(reader),
    noteMetadata: reader.noteMetadata.bind(reader),
    createNote: (command: Parameters<typeof adapter.createNote>[0]) => adapter.createNote(command),
    readOnly: { readOperatorNoteContent: reader.readOperatorNoteContent.bind(reader) },
  };
  const policy = createReadWriteNoDeleteServicePolicy();
  const mutationCount = (): number =>
    MUTATORS.reduce((sum, name) => sum + spies[name].mock.calls.length, 0);

  let requestId = 0;
  return {
    rows,
    adapter,
    mutationCount,
    spies,
    async publicCreate(params: {
      title: string;
      content: string;
      notebookId?: string;
      listKind?: "simple-checklist" | "task-list";
    }) {
      requestId += 1;
      return handleRpcRequest(
        { id: `create-${requestId}`, method: "notes.create", params },
        runtime,
        policy,
      );
    },
    async publicGet(id: string) {
      requestId += 1;
      const response = await handleRpcRequest(
        { id: `get-${requestId}`, method: "notes.get", params: { id } },
        runtime,
        policy,
      );
      if (!response.ok || response.result.kind !== "note") throw new Error("expected note");
      return response.result;
    },
  };
}

async function createdId(
  world: ReturnType<typeof createWorld>,
  params: Parameters<ReturnType<typeof createWorld>["publicCreate"]>[0],
): Promise<string> {
  const response = await world.publicCreate(params);
  if (!response.ok || response.result.kind !== "create") throw new Error("create failed");
  return response.result.id;
}

describe("public notes.create → persisted content row → public notes.get parity", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["horizontal rule", canonical("before\n\n---\n\nafter")],
    ["blockquote", canonical("> first quoted\n>\n> second quoted")],
    ["callout", canonical(":::nookbridge callout info\ninside the callout\n:::")],
    [
      "all three together",
      canonical(
        "# Title\n\n---\n\n> quoted\n\n:::nookbridge callout warning\nheads up\n\n---\n\nafter rule\n:::",
      ),
    ],
  ];

  for (const [label, markdown] of cases) {
    it(`reads back the exact canonical Markdown for ${label}`, async () => {
      const world = createWorld();
      const id = await createdId(world, { title: `parity ${label}`, content: markdown });

      const row = world.rows.get(id);
      expect(row?.content.type).toBe("tiptap");
      expect(row?.content.data.startsWith('<div data-type="document">')).toBe(true);
      // The stored row decodes strictly and re-serializes to the input bytes.
      const decoded = decodeNoteDocumentNative(row?.content, {
        noteId: id,
        revision: "rev_" + "0".repeat(32),
      });
      expect(serializeNoteDocumentMarkdown(decoded.document)).toBe(markdown);

      const note = await world.publicGet(id);
      expect(note.contentStatus).toBe("ok");
      expect(note.markdown).toBe(markdown);
      expect(note.markdownBytes).toBe(Buffer.byteLength(markdown, "utf8"));
    });
  }

  it("stores a native horizontal rule and blockquote, not the legacy rendering", async () => {
    const world = createWorld();
    const id = await createdId(world, {
      title: "native hr",
      content: canonical("one\n\n---\n\n> two"),
    });
    const data = world.rows.get(id)?.content.data ?? "";
    expect(data).toContain("<hr style=");
    expect(data).toContain("<blockquote><p>two</p></blockquote>");
  });

  it("honours an explicit list intent for unwrapped task lists and reads it back", async () => {
    const world = createWorld();
    const id = await createdId(world, {
      title: "explicit intent",
      content: canonical("- [ ] one\n- [x] two"),
      listKind: "task-list",
    });
    expect(world.rows.get(id)?.content.data).toContain('<ul class="checklist">');
    const note = await world.publicGet(id);
    expect(note.contentStatus).toBe("ok");
    expect(note.markdown).toBe(
      canonical(":::nookbridge list task-list\n- [ ] one\n- [x] two\n:::"),
    );
  });

  it("defaults unwrapped task lists to simple-checklist", async () => {
    const world = createWorld();
    const id = await createdId(world, {
      title: "default intent",
      content: canonical("- [ ] one"),
    });
    expect(world.rows.get(id)?.content.data).toContain('<ul class="simple-checklist">');
    const note = await world.publicGet(id);
    expect(note.markdown).toBe(canonical(":::nookbridge list simple-checklist\n- [ ] one\n:::"));
  });

  it("lets a wrapped list's own kind win over the request listKind", async () => {
    const world = createWorld();
    const wrapped = canonical(":::nookbridge list simple-checklist\n- [ ] one\n:::");
    const id = await createdId(world, {
      title: "wrapper wins",
      content: wrapped,
      listKind: "task-list",
    });
    expect(world.rows.get(id)?.content.data).toContain('<ul class="simple-checklist">');
    expect((await world.publicGet(id)).markdown).toBe(wrapped);
  });

  it("still validates the title before touching the seam", async () => {
    const world = createWorld();
    const response = await world.publicCreate({ title: "", content: canonical("body") });
    expect(response.ok).toBe(false);
    expect(world.mutationCount()).toBe(0);
  });

  it("still attaches the notebook and keeps it preflighted for versioned input", async () => {
    const world = createWorld({ notebooks: ["nb-1"] });
    await createdId(world, {
      title: "with notebook",
      content: canonical("body"),
      notebookId: "nb-1",
    });
    expect(world.spies.notebookAddNote).toHaveBeenCalledTimes(1);

    const unknown = createWorld({ notebooks: ["nb-1"] });
    const refused = await unknown.publicCreate({
      title: "unknown notebook",
      content: canonical("body"),
      notebookId: "nb-missing",
    });
    expect(refused.ok).toBe(false);
    expect(unknown.mutationCount()).toBe(0);
  });
});

describe("versioned create refuses before any mutator", () => {
  const refusals: ReadonlyArray<readonly [string, string]> = [
    ["unknown version", "---\nnookbridge-format: 2\n---\n\nbody\n"],
    ["quoted key", '---\n"nookbridge-format": 1\n---\n\nbody\n'],
    ["escaped key", '---\n"nookbridge\\x2dformat": 1\n---\n\nbody\n'],
    ["inline opener", "--- {nookbridge-format: 2}\n\nbody\n"],
    ["commented opener", "--- # metadata\nnookbridge-format: 2\n---\n\nbody\n"],
    ["CRLF header", "---\r\nnookbridge-format: 1\r\n---\r\n\r\nbody\r\n"],
    ["noncanonical canonical-version spelling", "---\nnookbridge-format: '1'\n---\n\nbody\n"],
    ["trailing comment", "---\nnookbridge-format: 1 # note\n---\n\nbody\n"],
    ["extra header key", "---\nnookbridge-format: 1\nother: x\n---\n\nbody\n"],
    ["missing final newline", `${HEADER}\nbody`],
    ["extra blank line", `${HEADER}\n\nbody\n`],
    ["raw html in canonical body", canonical("<b>x</b>")],
    [
      "opaque reference without trusted preimage",
      canonical(":::nookbridge opaque div\nref:1:native-html:abc123\n:::"),
    ],
    ["unknown directive", canonical(":::nookbridge widget\nx\n:::")],
    ["merge key claim", "---\nbase: &b {nookbridge-format: 2}\n<<: *b\n---\n\nbody\n"],
    ["alias key claim", "---\n? &k nookbridge-format\n: 1\n*k : 2\n---\n\nbody\n"],
  ];

  for (const [label, content] of refusals) {
    it(`refuses ${label} with zero mutation and no legacy fallback`, async () => {
      const world = createWorld({ notebooks: ["nb-1"] });
      const response = await world.publicCreate({ title: "refused", content, notebookId: "nb-1" });
      expect(response.ok).toBe(false);
      expect(world.mutationCount()).toBe(0);
      expect(world.rows.size).toBe(0);
    });
  }

  it("maps the refusal to unsupported_content at the adapter and never calls the codec", async () => {
    const base = createDeterministicMarkdownCodec();
    const encodeMarkdown = vi.fn(base.encodeMarkdown);
    const world = createWorld({
      codec: { encodeMarkdown, appendMarkdownToStoredContent: base.appendMarkdownToStoredContent },
    });
    await expect(
      world.adapter.createNote({
        title: "x",
        content: "---\nnookbridge-format: 2\n---\n\nbody\n",
      }),
    ).rejects.toMatchObject({ code: "unsupported_content" });
    expect(encodeMarkdown).not.toHaveBeenCalled();
    expect(world.mutationCount()).toBe(0);
  });

  it("uses the native serializer, not the codec, for canonical versioned input", async () => {
    const base = createDeterministicMarkdownCodec();
    const encodeMarkdown = vi.fn(base.encodeMarkdown);
    const world = createWorld({
      codec: { encodeMarkdown, appendMarkdownToStoredContent: base.appendMarkdownToStoredContent },
    });
    await world.adapter.createNote({ title: "x", content: canonical("body") });
    expect(encodeMarkdown).not.toHaveBeenCalled();
    expect(world.spies.notesAdd).toHaveBeenCalledTimes(1);
  });

  it("attaches known tags for versioned input through the relation seam", async () => {
    const world = createWorld();
    await world.adapter.createNote({
      title: "tagged",
      content: canonical("body"),
      tags: ["known-tag"],
    });
    expect(world.spies.relationAdd).toHaveBeenCalledTimes(1);
  });

  it("refuses with an unknown tag and zero relation/tag mutation", async () => {
    const world = createWorld();
    await expect(
      world.adapter.createNote({
        title: "tagged",
        content: canonical("body"),
        tags: ["known-tag", "unknown-tag"],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(world.mutationCount()).toBe(0);
  });

  it("refuses versioned content whose native output the public reader would not return", async () => {
    // ~12k characters of ordinary paragraphs: valid canonical Markdown, but
    // the public reader degrades it to `oversize`, so create must not persist
    // a note the exact-parity contract cannot read back.
    const paragraphs = Array.from({ length: 3 }, () => "a".repeat(4_000)).join("\n\n");
    const world = createWorld();
    const response = await world.publicCreate({
      title: "too big for the reader",
      content: canonical(paragraphs),
    });
    expect(response.ok).toBe(false);
    expect(world.mutationCount()).toBe(0);
  });

  it("keeps the exact-parity contract for versioned content that the reader accepts", async () => {
    const world = createWorld();
    const body = Array.from({ length: 3 }, () => "a".repeat(1_000)).join("\n\n");
    const id = await createdId(world, { title: "fits", content: canonical(body) });
    expect((await world.publicGet(id)).markdown).toBe(canonical(body));
  });
});
