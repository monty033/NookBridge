import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOperatorDiscoveryRuntime,
  createOperatorHandleRegistry,
  operatorPeerKey,
} from "../src/service/operator-discovery-runtime.js";
import { createOperatorDiscoveryHandler } from "../src/service/operator-discovery-handler.js";
import { NotesnookReadOnlyProjectionError } from "../src/core/notesnook-readonly-projection.js";
import { serializeRpcResponse } from "../src/service/rpc-protocol.js";
import type { OperatorPeer } from "../src/service/operator-server.js";
import type { DiscoveryVisibility } from "../src/service/discovery-visibility.js";

const PEER_A: OperatorPeer = Object.freeze({
  uid: 1001,
  gid: 100,
  groups: ["nookbridge-operators"],
});
const PEER_B: OperatorPeer = Object.freeze({
  uid: 1002,
  gid: 100,
  groups: ["nookbridge-operators"],
});

/**
 * A `DiscoveryVisibility` double whose answers deliberately DISAGREE with
 * the raw service surface stubbed into the same runtime.  With both wired,
 * the labels that come back can only have come from the filter.
 */
function visibilityDouble(
  options: Readonly<{
    readonly listNotes: DiscoveryVisibility["listNotes"];
    readonly searchHits: DiscoveryVisibility["searchHits"];
  }>,
): DiscoveryVisibility {
  return {
    listNotes: options.listNotes,
    searchHits: options.searchHits,
    filterNotebooks: async <T extends Readonly<{ id: string }>>(
      notebooks: ReadonlyArray<T>,
    ): Promise<ReadonlyArray<T>> => Object.freeze([...notebooks]),
  };
}

type Service = Parameters<typeof createOperatorDiscoveryRuntime>[0];

/** Build a runtime whose allow-all filter delegates to the stubbed raw surface. */
function runtimeFor(readOnly: Record<string, unknown>) {
  const raw = readOnly as unknown as Service["readOnly"];
  return createOperatorDiscoveryRuntime(
    { readOnly: raw } as Service,
    undefined,
    visibilityDouble({
      listNotes: () => raw.listNotes(),
      searchHits: (query: string) => raw.search(query),
    }),
  );
}

const REVISION = `rev_${"1".repeat(32)}`;

/**
 * Stored content the strict native decoder refuses: the `javascript:` URL is
 * outside its safe URL allowlist.  The read-only renderer can still
 * approximate it (unsafe link dropped, images/attachments summarised).
 */
const STRICT_REJECTED_CONTENT = Object.freeze({
  type: "html",
  data:
    '<p><a href="javascript:alert(1)">Hello <strong>world</strong></a></p>' +
    '<p><img src="https://example.com/x.png" alt="x"></p>' +
    '<div data-type="attachment" data-id="ref-local-1" data-name="report.pdf">x</div>',
});

/** Browse one note so a real peer-scoped handle can address it, then read it. */
async function viewFixture(reader: (id: string) => Promise<unknown>) {
  const runtime = runtimeFor({
    listNotes: async () => [{ id: "raw-note", title: "Body" }],
    noteMetadata: async () => ({ id: "raw-note", title: "Body", revision: REVISION }),
    readOperatorNoteContent: reader,
  });
  const page = await runtime.browse({ limit: 1 }, PEER_A);
  const handle = page.notes[0]?.handle;
  if (handle === undefined) throw new Error("missing test handle");
  return { runtime, handle };
}

describe("daemon operator discovery runtime", () => {
  it("expires opaque handles after their configured TTL", () => {
    let clock = 1000;
    const registry = createOperatorHandleRegistry({ ttlMs: 100, now: () => clock });
    const handle = registry.mint("raw-note", PEER_A);
    expect(registry.resolve(handle, PEER_A)).toBe("raw-note");
    clock += 100;
    expect(registry.resolve(handle, PEER_A)).toBeUndefined();
  });

  it("mints opaque handles and paginates source-side", async () => {
    const runtime = runtimeFor({
      listNotes: async () => [
        { id: "raw-id-1", title: "One" },
        { id: "raw-id-2", title: "Two" },
      ],
    });
    const first = await runtime.browse({ limit: 1 }, PEER_A);
    expect(first.notes).toHaveLength(1);
    expect(first.notes[0]?.handle).toMatch(/^h_[A-Za-z0-9_-]+$/);
    expect(first.notes[0]?.handle).not.toContain("raw-id-1");
    expect(first.next).toMatch(/^cur_/);
    const second = await runtime.browse(
      {
        ...(first.next === null ? {} : { cursor: first.next }),
        limit: 1,
      },
      PEER_A,
    );
    expect(second.notes[0]?.label).toBe("Two");
    expect(second.next).toBeNull();
  });

  it("resolves an opaque handle to bounded Markdown", async () => {
    const runtime = runtimeFor({
      listNotes: async () => [{ id: "raw-note", title: "Body" }],
      noteMetadata: async () => ({
        id: "raw-note",
        title: "Body",
        revision: `rev_${"1".repeat(32)}`,
      }),
      readOperatorNoteContent: async () => ({
        type: "html",
        data: "<p>Hello <strong>world</strong></p>",
      }),
    });
    const page = await runtime.browse({ limit: 1 }, PEER_A);
    const handle = page.notes[0]?.handle;
    if (handle === undefined) throw new Error("missing test handle");
    const view = await runtime.view?.({ id: handle }, PEER_A);
    expect(view?.id).toBe(handle);
    expect(view?.markdown).toContain("Hello **world**");
    expect(view?.markdown).not.toContain("raw-note");
  });

  it("keeps get-view read-only while binding preserved-block sentinels to revision", async () => {
    let revision = REVISION;
    const content = {
      type: "html" as const,
      data:
        '<p>before</p><img src="https://example.com/image.png" alt="image" data-note="image-opaque" data-path="/private/notes/image.bin">' +
        '<div data-type="attachment" data-id="attachment-opaque" data-path="/private/notes/report.pdf"><a href="https://example.com/file.bin">file.bin</a></div>' +
        '<div data-type="embed" data-url="https://example.com/embed"><p>embedded payload</p></div>',
    };
    const opaque = [
      '<img src="https://example.com/image.png" alt="image" data-note="image-opaque" data-path="/private/notes/image.bin">',
      '<div data-type="attachment" data-id="attachment-opaque" data-path="/private/notes/report.pdf"><a href="https://example.com/file.bin">file.bin</a></div>',
      '<div data-type="embed" data-url="https://example.com/embed"><p>embedded payload</p></div>',
    ];
    const expectedToken = (revision: string, index: number): string =>
      createHash("sha256")
        .update(JSON.stringify([JSON.stringify(["raw-note", revision]), index, opaque[index]]))
        .digest("hex")
        .slice(0, 36);
    const runtime = runtimeFor({
      listNotes: async () => [{ id: "raw-note", title: "Body" }],
      noteMetadata: async () => ({ id: "raw-note", title: "Body", revision }),
      readOperatorNoteContent: async () => content,
    });
    const page = await runtime.browse({ limit: 1 }, PEER_A);
    const handle = page.notes[0]?.handle;
    if (handle === undefined) throw new Error("missing test handle");
    const first = await runtime.view?.({ id: handle }, PEER_A);
    revision = `rev_${"2".repeat(32)}`;
    const second = await runtime.view?.({ id: handle }, PEER_A);
    expect(first?.id).toBe(handle);
    expect(second?.id).toBe(handle);
    expect(first?.revision).toBe(REVISION);
    expect(second?.revision).toBe(revision);
    expect(first?.markdown).toContain("before");
    const placeholders = first?.markdown.match(/:::nookbridge opaque [\s\S]*?:::/g);
    expect(placeholders, "expected three get-view opaque sentinels").toHaveLength(3);
    if (placeholders === null || placeholders === undefined)
      throw new Error("missing get-view opaque sentinels");
    expect(placeholders?.map((placeholder) =>
      /^:::nookbridge opaque ([A-Za-z][A-Za-z0-9_-]*)\n/.exec(placeholder)?.[1],
    )).toEqual(["img", "div", "div"]);
    const divTokens = placeholders
      ?.filter((placeholder) => placeholder.startsWith(":::nookbridge opaque div\n"))
      .map((placeholder) => /native-html:([A-Za-z0-9_-]+)/.exec(placeholder)?.[1]);
    expect(divTokens).toHaveLength(2);
    expect(new Set(divTokens).size).toBe(2);
    expect(
      placeholders?.map(
        (placeholder) => /native-html:([A-Za-z0-9_-]+)/.exec(placeholder)?.[1],
      ),
    ).toEqual([0, 1, 2].map((index) => expectedToken(REVISION, index)));
    expect(placeholders?.[0]).toBe(
      ":::nookbridge opaque img\nref:1:native-html:18c406028970c0744a52089cf4fb7b38e266\n:::",
    );
    expect(second?.markdown).not.toBe(first?.markdown);
    const secondPlaceholders = second?.markdown.match(/:::nookbridge opaque [\s\S]*?:::/g);
    expect(
      secondPlaceholders?.map(
        (placeholder) => /native-html:([A-Za-z0-9_-]+)/.exec(placeholder)?.[1],
      ),
    ).toEqual([0, 1, 2].map((index) => expectedToken(`rev_${"2".repeat(32)}`, index)));
    expect(second?.markdown).toContain(
      ":::nookbridge opaque img\nref:1:native-html:d398d39ea6428ead70fc54475b5a361f4410\n:::",
    );
    expect(first?.markdown).not.toContain("example.com");
    expect(first?.markdown).not.toContain("attachment-opaque");
    expect(first?.markdown).not.toContain("image-opaque");
    expect(first?.markdown).not.toContain("/private/notes/");
    expect(Object.keys(first ?? {}).sort()).toEqual([
      "contentBytes",
      "id",
      "markdown",
      "revision",
    ]);
  });

  it("falls back to tolerant Markdown when the strict decoder rejects stored content", async () => {
    // D6-2: `javascript:` is outside the strict decoder's safe URL allowlist.
    // The view must degrade to the same read-only approximation notes.get uses
    // instead of failing the whole read.
    const { runtime, handle } = await viewFixture(async () => STRICT_REJECTED_CONTENT);
    const view = await runtime.view?.({ id: handle }, PEER_A);
    expect(view?.markdown).toBe("Hello **world**\n\n[image]\n\n[attachment: report.pdf]");
    // Approximation only: no source URLs and no opaque references escape.
    expect(view?.markdown).not.toContain("example.com");
    expect(view?.markdown).not.toContain("ref-local-1");
  });

  it("keeps the view result shape and byte accounting on the tolerant path", async () => {
    const { runtime, handle } = await viewFixture(async () => STRICT_REJECTED_CONTENT);
    const view = await runtime.view?.({ id: handle }, PEER_A);
    // No approximation flag and no extra fields: the schema is unchanged.
    expect(Object.keys(view ?? {}).sort()).toEqual(["contentBytes", "id", "markdown", "revision"]);
    expect(view?.contentBytes).toBe(Buffer.byteLength(view?.markdown ?? "", "utf8"));
  });

  it("serializes a tolerant view as a kind:view RPC result", async () => {
    const { runtime, handle } = await viewFixture(async () => STRICT_REJECTED_CONTENT);
    const response = await createOperatorDiscoveryHandler(runtime)(
      { id: "view-tolerant", method: "notes.get-view", params: { id: handle } },
      PEER_A,
    );
    expect(response).toMatchObject({ ok: true, result: { kind: "view", id: handle } });
    const frame = serializeRpcResponse(response);
    const length = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
    const parsed = JSON.parse(
      Buffer.from(frame)
        .subarray(4, length + 4)
        .toString("utf8"),
    ) as {
      readonly result: {
        readonly kind: string;
        readonly id: string;
        readonly revision: string;
        readonly markdown: string;
        readonly contentBytes: number;
      };
    };
    expect(parsed.result.kind).toBe("view");
    expect(Object.keys(parsed.result).sort()).toEqual([
      "contentBytes",
      "id",
      "kind",
      "markdown",
      "revision",
    ]);
    expect(parsed.result.contentBytes).toBe(Buffer.byteLength(parsed.result.markdown, "utf8"));
  });

  it("does not intercept a locked-note refusal with the tolerant fallback", async () => {
    // The projection raises `vault_locked` from the reader call itself.  The
    // fallback only wraps decode/serialize, so the lock still refuses the view.
    const locked = new NotesnookReadOnlyProjectionError("vault_locked");
    const { runtime, handle } = await viewFixture(async () => {
      throw locked;
    });
    await expect(runtime.view?.({ id: handle }, PEER_A)).rejects.toBe(locked);
    const response = await createOperatorDiscoveryHandler(runtime)(
      { id: "view-locked", method: "notes.get-view", params: { id: handle } },
      PEER_A,
    );
    expect(response).toMatchObject({ ok: false, error: { code: "vault_locked" } });
  });

  it("scopes note handles to the peer that discovered them", async () => {
    const runtime = runtimeFor({
      listNotes: async () => [{ id: "raw-note", title: "Body" }],
      noteMetadata: async () => ({
        id: "raw-note",
        title: "Body",
        revision: `rev_${"1".repeat(32)}`,
      }),
      readOperatorNoteContent: async () => ({ type: "html", data: "<p>Body</p>" }),
    });
    const page = await runtime.browse({ limit: 1 }, PEER_A);
    const handle = page.notes[0]?.handle;
    if (handle === undefined) throw new Error("missing test handle");
    await expect(runtime.view?.({ id: handle }, PEER_B)).rejects.toThrow("not_found");
    await expect(runtime.view?.({ id: handle }, PEER_A)).resolves.toMatchObject({ id: handle });
  });

  it("filters notebook search hits before minting note handles", async () => {
    const runtime = runtimeFor({
      search: async () => [
        { id: "notebook-1", title: "Notebook", source: "notebook" },
        { id: "note-1", title: "Note", source: "note" },
      ],
    });
    const page = await runtime.search({ query: "n", limit: 10 }, PEER_A);
    expect(page.notes.map((note) => note.label)).toEqual(["Note"]);
  });

  it("browses through the supplied visibility filter instead of the raw listing", async () => {
    // S2b: when a DiscoveryVisibility argument is supplied, every operator
    // browse title is decided by the filter.  The raw read-only listing is
    // stubbed with deliberately different rows and must not be consulted.
    const rawCalls: string[] = [];
    const runtime = createOperatorDiscoveryRuntime(
      {
        readOnly: {
          listNotes: async () => {
            rawCalls.push("listNotes");
            return [
              { id: "raw-hidden-1", title: "Raw hidden one" },
              { id: "raw-hidden-2", title: "Raw hidden two" },
            ];
          },
        },
      } as unknown as Parameters<typeof createOperatorDiscoveryRuntime>[0],
      undefined,
      visibilityDouble({
        listNotes: async () => [
          { id: "filtered-id-1", title: "Filtered one" },
          { id: "filtered-id-2", title: "Filtered two" },
        ],
        searchHits: async () => [],
      }),
    );
    const first = await runtime.browse({ limit: 1 }, PEER_A);
    expect(rawCalls).toEqual([]);
    expect(first.notes).toHaveLength(1);
    expect(first.notes[0]?.label).toBe("Filtered one");
    expect(first.notes[0]?.handle).not.toContain("filtered-id-1");
    expect(first.next).toMatch(/^cur_/);
    const second = await runtime.browse(
      {
        ...(first.next === null ? {} : { cursor: first.next }),
        limit: 1,
      },
      PEER_A,
    );
    expect(second.notes[0]?.label).toBe("Filtered two");
    expect(second.next).toBeNull();
  });

  it("searches through the supplied visibility filter and drops notebook hits", async () => {
    // S2b: a supplied filter overrides the raw search, the query is forwarded
    // to it, and notebook hits still never become operator notes.
    const rawCalls: string[] = [];
    const queries: string[] = [];
    const runtime = createOperatorDiscoveryRuntime(
      {
        readOnly: {
          search: async () => {
            rawCalls.push("search");
            return [
              { id: "raw-hidden-note", title: "Raw hidden note", source: "note" },
              { id: "raw-hidden-notebook", title: "Raw hidden notebook", source: "notebook" },
            ];
          },
        },
      } as unknown as Parameters<typeof createOperatorDiscoveryRuntime>[0],
      undefined,
      visibilityDouble({
        listNotes: async () => [],
        searchHits: async (query: string) => {
          queries.push(query);
          return [
            { id: "filtered-notebook-1", title: "Filtered notebook", source: "notebook" },
            { id: "filtered-note-1", title: "Filtered note", source: "note" },
          ];
        },
      }),
    );
    const page = await runtime.search({ query: "n", limit: 10 }, PEER_A);
    expect(rawCalls).toEqual([]);
    expect(queries).toEqual(["n"]);
    expect(page.notes.map((note) => note.label)).toEqual(["Filtered note"]);
  });

  it("mints an opaque handle instead of leaking the raw id of a created note", async () => {
    // Review finding: create returned the raw Notesnook note id, contradicting
    // the registry contract at the top of this module that raw note IDs never
    // cross the socket.  Every other surface mints a handle, so create must too -
    // and the handle must resolve, so hiding the id costs the caller nothing.
    const resolved: string[] = [];
    const runtime = createOperatorDiscoveryRuntime(
      {
        readOnly: {
          listNotes: async () => [],
          noteMetadata: async (id: string) => {
            resolved.push(id);
            return { id, title: "Created", revision: `rev_${"2".repeat(32)}` };
          },
          readOperatorNoteContent: async () => ({ type: "html", data: "<p>x</p>" }),
        },
        createNote: async () => ({ id: "raw-created-1", titleBytes: 5, contentBytes: 10 }),
      } as unknown as Parameters<typeof createOperatorDiscoveryRuntime>[0],
      undefined,
      visibilityDouble({ listNotes: async () => [], searchHits: async () => [] }),
    );
    const created = await runtime.create?.({ title: "Created", content: "<p>x</p>" }, PEER_A);
    if (created === undefined) throw new Error("missing create result");
    expect(created.id).toMatch(/^h_[A-Za-z0-9_-]+$/);
    expect(created.id).not.toContain("raw-created-1");
    await runtime.view?.({ id: created.id }, PEER_A);
    expect(resolved).toEqual(["raw-created-1"]);
  });

  describe("peerless identity is rejected (D3-1)", () => {
    const BAD_PEERS: ReadonlyArray<[string, unknown]> = [
      ["undefined", undefined],
      ["negative uid", { uid: -1, gid: 1, groups: [] }],
      ["fractional gid", { uid: 1, gid: 1.5, groups: [] }],
      ["unsafe uid", { uid: Number.MAX_SAFE_INTEGER + 1, gid: 1, groups: [] }],
      ["non-array groups", { uid: 1, gid: 1, groups: "x" }],
      ["non-string group", { uid: 1, gid: 1, groups: [1] }],
      ["null", null],
    ];

    it("operatorPeerKey keeps the owner-key format and rejects invalid peers", () => {
      expect(operatorPeerKey({ uid: 1, gid: 2, groups: ["b", "a"] })).toBe("1:2:a,b");
      expect(operatorPeerKey({ uid: 0, gid: 0, groups: [] })).toBe("0:0:");
      expect(() => operatorPeerKey(undefined)).toThrow("permission_denied");
      for (const [, bad] of BAD_PEERS)
        expect(() => operatorPeerKey(bad as OperatorPeer)).toThrow("permission_denied");
    });

    it("registry mint throws and resolve returns undefined for an invalid peer", () => {
      const registry = createOperatorHandleRegistry();
      expect(() => registry.mint("n", undefined)).toThrow("permission_denied");
      const handle = registry.mint("n", PEER_A);
      expect(registry.resolve(handle, undefined)).toBeUndefined();
      for (const [, bad] of BAD_PEERS)
        expect(registry.resolve(handle, bad as OperatorPeer)).toBeUndefined();
    });

    it("entry points reject before any downstream call", async () => {
      const calls = {
        list: 0,
        search: 0,
        meta: 0,
        content: 0,
        create: 0,
        filterList: 0,
        filterSearch: 0,
      };
      const runtime = createOperatorDiscoveryRuntime(
        {
          readOnly: {
            listNotes: async () => ((calls.list += 1), []),
            search: async () => ((calls.search += 1), []),
            noteMetadata: async () => ((calls.meta += 1), undefined),
            readOperatorNoteContent: async () => ((calls.content += 1), { type: "html", data: "" }),
          },
          createNote: async () => (
            (calls.create += 1), { id: "x", titleBytes: 0, contentBytes: 0 }
          ),
        } as unknown as Service,
        undefined,
        visibilityDouble({
          listNotes: async () => ((calls.filterList += 1), []),
          searchHits: async () => ((calls.filterSearch += 1), []),
        }),
      );
      for (const [, bad] of BAD_PEERS) {
        const peer = bad as OperatorPeer;
        await expect(runtime.browse({ limit: 1 }, peer)).rejects.toThrow("permission_denied");
        await expect(runtime.search({ query: "n", limit: 1 }, peer)).rejects.toThrow(
          "permission_denied",
        );
        await expect(runtime.view?.({ id: "h_x" }, peer)).rejects.toThrow("permission_denied");
        await expect(runtime.create?.({ title: "t", content: "c" }, peer)).rejects.toThrow(
          "permission_denied",
        );
      }
      expect(calls).toEqual({
        list: 0,
        search: 0,
        meta: 0,
        content: 0,
        create: 0,
        filterList: 0,
        filterSearch: 0,
      });
    });

    it("requires a visibility filter at the type level", () => {
      // @ts-expect-error visibility is required; there is no unfiltered factory
      const build = () => createOperatorDiscoveryRuntime({} as Service, undefined);
      expect(build).toBeTypeOf("function");
    });

    it("keeps no shared legacy identity in the source", () => {
      const source = readFileSync(
        resolve(import.meta.dirname, "../src/service/operator-discovery-runtime.ts"),
        "utf8",
      );
      expect(source).not.toContain("legacy");
    });
  });
});
