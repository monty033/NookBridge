import { describe, expect, it } from "vitest";

import { createOperatorDiscoveryHandler } from "../src/service/operator-discovery-handler.js";
import {
  createOperatorDiscoveryRuntime,
  createOperatorHandleRegistry,
} from "../src/service/operator-discovery-runtime.js";
import { createOperatorWriteRuntime } from "../src/service/notes-operator-write-runtime.js";
import { createNotesUndoStore, type OperationStoreFs } from "../src/service/notes-undo-store.js";
import type { OperatorStoredContent } from "../src/service/notes-operator-write-runtime.js";
import type { ServiceRuntime } from "../src/service/service-runtime.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";

const NOTE_ID = "note-integration-1";
const REVISION_1 = `rev_${"1".repeat(32)}`;
const REVISION_2 = `rev_${"2".repeat(32)}`;

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

/**
 * Compose the operator handler exactly the way `nookd` does: one shared
 * handle registry, discovery and mutation runtimes layered into a single
 * handler.  The point of this test is the WIRING — a handle minted by
 * `notes.browse` must be the handle the mutation methods accept.
 */
async function compose() {
  const state: { revision: string; content: OperatorStoredContent } = {
    revision: REVISION_1,
    content: wrap("<p>before</p>"),
  };
  const readOnly = {
    async listNotes() {
      return [{ id: NOTE_ID, title: "Integration note" }];
    },
    async search() {
      return [];
    },
    async noteMetadata() {
      return { id: NOTE_ID, title: "Integration note", revision: state.revision };
    },
    async readNoteContent() {
      return { ...state.content };
    },
  } as unknown as ServiceRuntime["readOnly"];

  const store = await createNotesUndoStore({
    fs: new MemoryFs(),
    daemonKey: new Uint8Array(32).fill(3),
    now: () => 1000,
  });

  const registry = createOperatorHandleRegistry();
  const discovery = createOperatorDiscoveryRuntime({ readOnly } as ServiceRuntime, registry);
  const write = createOperatorWriteRuntime({
    store,
    resolveHandle: (handle, peer) => registry.resolve(handle, peer),
    now: () => 1000,
    ttlMs: 60_000,
    source: {
      read: async (noteId) => {
        if (noteId !== NOTE_ID) return undefined;
        return { revision: state.revision, content: { ...state.content } };
      },
      update: async (command) => {
        if (command.noteId !== NOTE_ID) return { kind: "missing" as const };
        if (command.expectedRevision !== state.revision) return { kind: "conflict" as const };
        state.content = { ...command.content };
        state.revision = command.expectedRevision === REVISION_1 ? REVISION_2 : REVISION_1;
        return { kind: "updated" as const, revision: state.revision };
      },
    },
  });

  const handler = createOperatorDiscoveryHandler({ ...discovery, ...write });
  const peer = { uid: 1, gid: 2, groups: [] as string[] };
  return { handler, peer, state };
}

/** Mint a real operator handle for the fixture note the way the CLI does: browse. */
async function mintHandle(
  handler: Awaited<ReturnType<typeof compose>>["handler"],
  peer: { uid: number; gid: number; groups: string[] },
): Promise<string> {
  const page = (await handler(
    { id: "h", method: "notes.browse", params: {} } as RpcRequest,
    peer,
  )) as { ok: boolean; result: { notes: ReadonlyArray<{ handle: string }> } };
  return page.result.notes[0]!.handle;
}

describe("daemon operator mutation wiring", () => {
  it("accepts a handle minted by browse for a full edit and undo cycle", async () => {
    const { handler, peer, state } = await compose();

    const browse = (await handler(
      { id: "1", method: "notes.browse", params: {} } as RpcRequest,
      peer,
    )) as { ok: boolean; result: { notes: ReadonlyArray<{ handle: string }> } };
    expect(browse.ok).toBe(true);
    const handle = browse.result.notes[0]!.handle;
    expect(handle).toMatch(/^h_/);

    const preimage = (await handler(
      { id: "2", method: "notes.edit-preimage", params: { id: handle } } as RpcRequest,
      peer,
    )) as { ok: boolean; result: { revision: string; markdown: string } };
    expect(preimage.ok).toBe(true);
    expect(preimage.result.revision).toBe(REVISION_1);
    expect(preimage.result.markdown).toContain("before");

    const edited = (await handler(
      {
        id: "3",
        method: "notes.apply-edit",
        params: {
          id: handle,
          expectedRevision: REVISION_1,
          markdown: preimage.result.markdown.replace("before", "after"),
        },
      } as RpcRequest,
      peer,
    )) as { ok: boolean; result: { revision: string } };
    expect(edited.ok).toBe(true);
    expect(edited.result.revision).toBe(REVISION_2);
    expect(state.content.data).toContain("after");

    const listed = (await handler(
      { id: "4", method: "notes.operation-list", params: {} } as RpcRequest,
      peer,
    )) as { ok: boolean; result: { handles: ReadonlyArray<string> } };
    expect(listed.result.handles).toHaveLength(1);
    const operationHandle = listed.result.handles[0]!;

    const status = (await handler(
      { id: "5", method: "notes.operation-status", params: { operationHandle } } as RpcRequest,
      peer,
    )) as unknown as { ok: boolean; result: Record<string, unknown> };
    expect(status.result).toMatchObject({ state: "committed" });
    // The raw note id must never cross the operator socket.
    expect(Object.values(status.result)).not.toContain(NOTE_ID);

    const undone = (await handler(
      {
        id: "6",
        method: "notes.apply-undo",
        params: { id: handle, operationHandle, expectedRevision: REVISION_2 },
      } as RpcRequest,
      peer,
    )) as { ok: boolean; result: { revision: string } };
    expect(undone.ok).toBe(true);
    expect(state.content.data).toContain("before");
  });

  it("returns not_found when a different peer replays a note handle", async () => {
    const { handler, peer, state } = await compose();
    const handle = await mintHandle(handler, peer);
    const stranger = { uid: peer.uid + 1, gid: peer.gid, groups: peer.groups };
    const response = (await handler(
      {
        id: "foreign",
        method: "notes.apply-edit",
        params: {
          id: handle,
          expectedRevision: REVISION_1,
          markdown: "<p>tampered</p>",
        },
      } as RpcRequest,
      stranger,
    )) as { ok: boolean; error: { code: string; message: string } };
    expect(response).toEqual({
      ok: false,
      error: { code: "not_found", message: "Not found" },
      id: "foreign",
    });
    expect(state.content.data).toContain("before");

    const preimage = (await handler(
      { id: "owner-preimage", method: "notes.edit-preimage", params: { id: handle } } as RpcRequest,
      peer,
    )) as { result: { markdown: string; revision: string } };
    const ownerEdit = (await handler(
      {
        id: "owner-edit",
        method: "notes.apply-edit",
        params: {
          id: handle,
          expectedRevision: preimage.result.revision,
          markdown: preimage.result.markdown.replace("before", "owner edit"),
        },
      } as RpcRequest,
      peer,
    )) as { ok: boolean };
    expect(ownerEdit.ok).toBe(true);
    const ownerList = (await handler(
      { id: "owner-list", method: "notes.operation-list", params: {} } as RpcRequest,
      peer,
    )) as { result: { handles: ReadonlyArray<string> } };
    const operationHandle = ownerList.result.handles[0];
    if (operationHandle === undefined) throw new Error("missing operation handle");
    const foreignList = (await handler(
      { id: "foreign-list", method: "notes.operation-list", params: {} } as RpcRequest,
      stranger,
    )) as { ok: boolean; result: { handles: ReadonlyArray<string> } };
    expect(foreignList).toMatchObject({ ok: true, result: { handles: [] } });
    const foreignStatus = (await handler(
      {
        id: "foreign-status",
        method: "notes.operation-status",
        params: { operationHandle },
      } as RpcRequest,
      stranger,
    )) as { ok: boolean; error: { code: string; message: string } };
    expect(foreignStatus).toMatchObject({
      ok: false,
      error: { code: "not_found", message: "Not found" },
    });
    const foreignUndo = (await handler(
      { id: "foreign-undo", method: "notes.apply-undo", params: { operationHandle } } as RpcRequest,
      stranger,
    )) as { ok: boolean; error: { code: string; message: string } };
    expect(foreignUndo).toMatchObject({
      ok: false,
      error: { code: "not_found", message: "Not found" },
    });
  });

  it("refuses an unknown handle rather than mutating the wrong note", async () => {
    const { handler, peer } = await compose();
    const response = (await handler(
      { id: "1", method: "notes.edit-preimage", params: { id: "h_forged" } } as RpcRequest,
      peer,
    )) as { ok: boolean; error: { code: string; message: string } };
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("not_found");
    expect(response.error.message).toBe("Not found");
  });

  /**
   * A bare `notes undo` has an opaque operation handle and NOTHING else:
   * `notes.operation-status` deliberately omits the note reference, and
   * the raw id must never cross the socket.  So the daemon has to resolve
   * the note — and the revision it must still match — from its own stored
   * record.  Requiring the client to resend them makes undo impossible.
   */
  it("undoes from the operation handle alone", async () => {
    const { handler, peer, state } = await compose();
    const handle = await mintHandle(handler, peer);

    const preimage = (await handler(
      { id: "1", method: "notes.edit-preimage", params: { id: handle } } as RpcRequest,
      peer,
    )) as { ok: boolean; result: { markdown: string; revision: string } };
    expect(preimage.ok).toBe(true);

    const edited = (await handler(
      {
        id: "2",
        method: "notes.apply-edit",
        params: {
          id: handle,
          expectedRevision: preimage.result.revision,
          markdown: preimage.result.markdown.replace("before", "after"),
        },
      } as RpcRequest,
      peer,
    )) as { ok: boolean; result: { revision: string } };
    expect(edited.ok).toBe(true);

    const listed = (await handler(
      { id: "3", method: "notes.operation-list", params: {} } as RpcRequest,
      peer,
    )) as { ok: boolean; result: { handles: ReadonlyArray<string> } };
    const operationHandle = listed.result.handles[0]!;

    // Only the operation handle — no note reference, no revision.
    const undone = (await handler(
      { id: "4", method: "notes.apply-undo", params: { operationHandle } } as RpcRequest,
      peer,
    )) as { ok: boolean; result: { revision: string } };
    expect(undone.ok).toBe(true);
    expect(state.content.data).toContain("before");
  });

  it("retains the record and refuses when the note moved on since the edit", async () => {
    const { handler, peer, state } = await compose();
    const handle = await mintHandle(handler, peer);

    const preimage = (await handler(
      { id: "1", method: "notes.edit-preimage", params: { id: handle } } as RpcRequest,
      peer,
    )) as { ok: boolean; result: { markdown: string; revision: string } };

    await handler(
      {
        id: "2",
        method: "notes.apply-edit",
        params: {
          id: handle,
          expectedRevision: preimage.result.revision,
          markdown: preimage.result.markdown.replace("before", "after"),
        },
      } as RpcRequest,
      peer,
    );
    const listed = (await handler(
      { id: "3", method: "notes.operation-list", params: {} } as RpcRequest,
      peer,
    )) as { ok: boolean; result: { handles: ReadonlyArray<string> } };
    const operationHandle = listed.result.handles[0]!;

    // Something else edits the note after ours.
    state.revision = `rev_${"9".repeat(32)}`;

    const undone = (await handler(
      { id: "4", method: "notes.apply-undo", params: { operationHandle } } as RpcRequest,
      peer,
    )) as { ok: boolean; error: { code: string } };
    expect(undone.ok).toBe(false);
    expect(undone.error.code).toBe("conflict");
    // The undo is still available for a later attempt.
    const stillListed = (await handler(
      { id: "5", method: "notes.operation-list", params: {} } as RpcRequest,
      peer,
    )) as { ok: boolean; result: { handles: ReadonlyArray<string> } };
    expect(stillListed.result.handles).toHaveLength(1);
  });
});
