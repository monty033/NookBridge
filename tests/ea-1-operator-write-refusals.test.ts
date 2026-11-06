/**
 * EA-1 round 3 — operator `notes.create` / `notes.edit` refusals, end to end.
 *
 * The chain under test is the real one from the daemon's write capability to
 * the CLI's categorical result:
 *
 *   operator{Create,Update}Note (throws the contract error)
 *     -> createOperatorWriteSource        (src/nookd.ts)
 *     -> createOperatorWriteRuntime       (operation records)
 *     -> createOperatorDiscoveryHandler   (RPC envelope)
 *     -> createNotesCommandRuntimeFromOperatorSocket -> NotesCategoricalResult
 *
 * Before the fix both codes collapsed to `service_unavailable` inside the
 * daemon and every refusal left an `unresolved` operation record. Fixtures
 * are synthetic; no note content from any real store appears here.
 */

import { describe, expect, it } from "vitest";

import { createOperatorWriteSource } from "../src/nookd.js";
import { NotesnookWriteContractError } from "../src/core/notesnook-write-contract.js";
import type { NotesCategoricalResult } from "../src/operator/notes-cli.js";
import { createNotesCommandRuntimeFromOperatorSocket } from "../src/operator/notes-production-runtime.js";
import type { OperatorSocketResult } from "../src/operator/operator-socket-client.js";
import type { DiscoveryVisibility } from "../src/service/discovery-visibility.js";
import { createOperatorDiscoveryHandler } from "../src/service/operator-discovery-handler.js";
import {
  createOperatorDiscoveryRuntime,
  createOperatorHandleRegistry,
} from "../src/service/operator-discovery-runtime.js";
import { createOperatorWriteRuntime } from "../src/service/notes-operator-write-runtime.js";
import { createNotesUndoStore, type OperationStoreFs } from "../src/service/notes-undo-store.js";
import { isRpcErrorCode, type RpcRequest } from "../src/service/rpc-protocol.js";
import type { ServiceRuntime } from "../src/service/service-runtime.js";

const NOTE_ID = "note-refusal-1";
const REVISION = `rev_${"1".repeat(32)}`;
const PEER = { uid: 1000, gid: 1000, groups: ["nookbridge-operators"] };

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

/** What the daemon's write capability throws; the harness decides per test. */
type Thrown = () => unknown;

async function compose(thrown: Thrown, succeedingUpdates = 0) {
  let updatesLeft = succeedingUpdates;
  const content = {
    type: "tiptap" as const,
    data: '<div data-type="document"><p>before</p></div>',
  };
  const readOnly = {
    async listNotes() {
      return [{ id: NOTE_ID, title: "Refusal note" }];
    },
    async search() {
      return [];
    },
    async noteMetadata() {
      return { id: NOTE_ID, title: "Refusal note", revision: REVISION };
    },
    async readNoteSnapshot() {
      return { metadata: { id: NOTE_ID, title: "Refusal note", revision: REVISION }, content };
    },
  } as unknown as ServiceRuntime["readOnly"];

  const visibility: DiscoveryVisibility = {
    listNotes: () => readOnly.listNotes(),
    searchHits: (query: string) => readOnly.search(query),
    filterNotebooks: async <T extends Readonly<{ id: string }>>(
      notebooks: ReadonlyArray<T>,
    ): Promise<ReadonlyArray<T>> => Object.freeze([...notebooks]),
  };

  const writes: string[] = [];
  const source = createOperatorWriteSource({
    operatorCreateNote: (async () => {
      writes.push("create");
      throw thrown();
    }) as never,
    operatorUpdateNote: (async () => {
      writes.push("update");
      if (updatesLeft > 0) {
        updatesLeft -= 1;
        return { operation: "update" };
      }
      throw thrown();
    }) as never,
    readOnly,
  });
  if (source === undefined) throw new Error("operator write source unavailable");

  const store = await createNotesUndoStore({
    fs: new MemoryFs(),
    daemonKey: new Uint8Array(32).fill(5),
    now: () => 1000,
  });
  const registry = createOperatorHandleRegistry();
  const discovery = createOperatorDiscoveryRuntime(
    { readOnly } as ServiceRuntime,
    registry,
    visibility,
  );
  const write = createOperatorWriteRuntime({
    source,
    store,
    resolveHandle: (handle, peer) => registry.resolve(handle, peer),
    mintHandle: () => "unused-handle",
    now: () => 1000,
    ttlMs: 60_000,
  });
  const handler = createOperatorDiscoveryHandler({ ...discovery, ...write });

  // The CLI client's request seam, backed by the real handler envelope.
  let seq = 0;
  const request = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<OperatorSocketResult> => {
    const envelope = (await handler(
      { id: `r${seq++}`, method, params } as unknown as RpcRequest,
      PEER,
    )) as
      | { ok: true; result: never }
      | { ok: false; error: { code: string; operationHandle?: string } };
    if (envelope.ok) return { ok: true, result: envelope.result };
    if (!isRpcErrorCode(envelope.error.code)) throw new Error("uncategorised error code");
    return { ok: false, code: envelope.error.code };
  };
  const cli = createNotesCommandRuntimeFromOperatorSocket({ request } as never, {
    editBody: async (markdown: string) => ({
      kind: "edited",
      markdown: markdown.replace("before", "after"),
    }),
    createBody: async () => ({ kind: "edited", markdown: "# Refused title\n\nbody" }),
  });

  const browse = await cli.browse({});
  if (browse.kind !== "page") throw new Error(`expected page, got ${browse.kind}`);
  const handle = browse.notes[0]!.handle;
  /** The opaque handle of the single committed edit, as `notes operations` lists it. */
  const operationHandle = async (): Promise<string> => {
    const listed = await cli.operations();
    if (listed.kind !== "operations" || listed.handles.length !== 1) {
      throw new Error("expected exactly one operation");
    }
    return listed.handles[0]!;
  };
  return { cli, store, writes, handle, operationHandle };
}

async function states(store: Awaited<ReturnType<typeof compose>>["store"]): Promise<string[]> {
  return (await store.list()).map((record) => record.state);
}

const REFUSALS = [
  ["sync_required", "sync-required"],
  ["unsupported_content", "unsupported-content"],
] as const;

describe("operator write refusals reach the CLI with their own kind", () => {
  describe.each(REFUSALS)("%s", (code, kind) => {
    it("notes.create surfaces the refusal and aborts the operation record", async () => {
      const f = await compose(() => new NotesnookWriteContractError(code));
      const result: NotesCategoricalResult = await f.cli.create({});
      expect(result).toEqual({ kind });
      expect(f.writes).toEqual(["create"]);
      // A pre-mutation refusal is not a lost write.
      expect(await states(f.store)).toEqual(["aborted"]);
    });

    it("notes.edit surfaces the refusal and aborts the operation record", async () => {
      const f = await compose(() => new NotesnookWriteContractError(code));
      const result: NotesCategoricalResult = await f.cli.edit({ handle: f.handle });
      expect(result).toEqual({ kind });
      expect(f.writes).toEqual(["update"]);
      expect(await states(f.store)).toEqual(["aborted"]);
    });

    it("notes.apply-undo surfaces the refusal and leaves the edit committed", async () => {
      const f = await compose(() => new NotesnookWriteContractError(code), 1);
      expect(await f.cli.edit({ handle: f.handle })).toEqual({ kind: "updated" });
      expect(await states(f.store)).toEqual(["committed"]);

      const result: NotesCategoricalResult = await f.cli.undo({
        operationHandle: await f.operationHandle(),
      });
      expect(result).toEqual({ kind });
      expect(f.writes).toEqual(["update", "update"]);
      // Nothing was restored, so the edit stays committed and undoable once the
      // remedy (sync, then retry) has been applied; it is not a lost write.
      expect(await states(f.store)).toEqual(["committed"]);
    });
  });

  describe("everything else is still an uncertain write", () => {
    // Guards the other direction: the new branch must not swallow outages.
    const OUTAGES: ReadonlyArray<readonly [string, Thrown]> = [
      ["a different contract code", () => new NotesnookWriteContractError("sync_failed")],
      ["a plain error", () => new Error("boom")],
      // Trust is by class identity, not by a `code` field on any thrown object.
      [
        "a lookalike carrying the code",
        () => Object.assign(new Error("x"), { code: "sync_required" }),
      ],
    ];

    it.each(OUTAGES)(
      "create after %s stays unresolved and reports an outage",
      async (_n, thrown) => {
        const f = await compose(thrown);
        const result = await f.cli.create({});
        expect(result).toMatchObject({ kind: "error", reason: "service_unavailable" });
        expect(await states(f.store)).toEqual(["unresolved"]);
      },
    );

    it.each(OUTAGES)("edit after %s stays unresolved and reports an outage", async (_n, thrown) => {
      const f = await compose(thrown);
      const result = await f.cli.edit({ handle: f.handle });
      expect(result).toMatchObject({ kind: "error", reason: "service_unavailable" });
      expect(await states(f.store)).toEqual(["unresolved"]);
    });

    it.each(OUTAGES)("undo after %s stays unresolved and reports an outage", async (_n, thrown) => {
      const f = await compose(thrown, 1);
      expect(await f.cli.edit({ handle: f.handle })).toEqual({ kind: "updated" });
      const result = await f.cli.undo({ operationHandle: await f.operationHandle() });
      expect(result).toMatchObject({ kind: "error", reason: "service_unavailable" });
      expect(await states(f.store)).toEqual(["unresolved"]);
    });
  });
});
