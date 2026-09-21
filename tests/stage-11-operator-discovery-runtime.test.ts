import { describe, expect, it } from "vitest";
import {
  createOperatorDiscoveryRuntime,
  createOperatorHandleRegistry,
} from "../src/service/operator-discovery-runtime.js";
import type { OperatorPeer } from "../src/service/operator-server.js";

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
    const runtime = createOperatorDiscoveryRuntime({
      readOnly: {
        listNotes: async () => [
          { id: "raw-id-1", title: "One" },
          { id: "raw-id-2", title: "Two" },
        ],
      },
    } as unknown as Parameters<typeof createOperatorDiscoveryRuntime>[0]);
    const first = await runtime.browse({ limit: 1 });
    expect(first.notes).toHaveLength(1);
    expect(first.notes[0]?.handle).toMatch(/^h_[A-Za-z0-9_-]+$/);
    expect(first.notes[0]?.handle).not.toContain("raw-id-1");
    expect(first.next).toMatch(/^cur_/);
    const second = await runtime.browse({
      ...(first.next === null ? {} : { cursor: first.next }),
      limit: 1,
    });
    expect(second.notes[0]?.label).toBe("Two");
    expect(second.next).toBeNull();
  });

  it("resolves an opaque handle to bounded Markdown", async () => {
    const runtime = createOperatorDiscoveryRuntime({
      readOnly: {
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
      },
    } as unknown as Parameters<typeof createOperatorDiscoveryRuntime>[0]);
    const page = await runtime.browse({ limit: 1 });
    const handle = page.notes[0]?.handle;
    if (handle === undefined) throw new Error("missing test handle");
    const view = await runtime.view?.({ id: handle });
    expect(view?.id).toBe(handle);
    expect(view?.markdown).toContain("Hello **world**");
    expect(view?.markdown).not.toContain("raw-note");
  });

  it("scopes note handles to the peer that discovered them", async () => {
    const runtime = createOperatorDiscoveryRuntime({
      readOnly: {
        listNotes: async () => [{ id: "raw-note", title: "Body" }],
        noteMetadata: async () => ({
          id: "raw-note",
          title: "Body",
          revision: `rev_${"1".repeat(32)}`,
        }),
        readOperatorNoteContent: async () => ({ type: "html", data: "<p>Body</p>" }),
      },
    } as unknown as Parameters<typeof createOperatorDiscoveryRuntime>[0]);
    const page = await runtime.browse({ limit: 1 }, PEER_A);
    const handle = page.notes[0]?.handle;
    if (handle === undefined) throw new Error("missing test handle");
    await expect(runtime.view?.({ id: handle }, PEER_B)).rejects.toThrow("not_found");
    await expect(runtime.view?.({ id: handle }, PEER_A)).resolves.toMatchObject({ id: handle });
  });

  it("filters notebook search hits before minting note handles", async () => {
    const runtime = createOperatorDiscoveryRuntime({
      readOnly: {
        search: async () => [
          { id: "notebook-1", title: "Notebook", source: "notebook" },
          { id: "note-1", title: "Note", source: "note" },
        ],
      },
    } as unknown as Parameters<typeof createOperatorDiscoveryRuntime>[0]);
    const page = await runtime.search({ query: "n", limit: 10 });
    expect(page.notes.map((note) => note.label)).toEqual(["Note"]);
  });

  it("mints an opaque handle instead of leaking the raw id of a created note", async () => {
    // Review finding: create returned the raw Notesnook note id, contradicting
    // the registry contract at the top of this module that raw note IDs never
    // cross the socket.  Every other surface mints a handle, so create must too -
    // and the handle must resolve, so hiding the id costs the caller nothing.
    const resolved: string[] = [];
    const runtime = createOperatorDiscoveryRuntime({
      readOnly: {
        listNotes: async () => [],
        noteMetadata: async (id: string) => {
          resolved.push(id);
          return { id, title: "Created", revision: `rev_${"2".repeat(32)}` };
        },
        readOperatorNoteContent: async () => ({ type: "html", data: "<p>x</p>" }),
      },
      createNote: async () => ({ id: "raw-created-1", titleBytes: 5, contentBytes: 10 }),
    } as unknown as Parameters<typeof createOperatorDiscoveryRuntime>[0]);
    const created = await runtime.create?.({ title: "Created", content: "<p>x</p>" });
    if (created === undefined) throw new Error("missing create result");
    expect(created.id).toMatch(/^h_[A-Za-z0-9_-]+$/);
    expect(created.id).not.toContain("raw-created-1");
    await runtime.view?.({ id: created.id });
    expect(resolved).toEqual(["raw-created-1"]);
  });
});
