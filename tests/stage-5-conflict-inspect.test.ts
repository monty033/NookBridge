/**
 * Stage 5 slice D — the operator-only, read-only `notes.inspect-conflict`.
 *
 * Pins the daemon contract for inspection:
 *
 *   - admission: operator vocabulary and the target-read list, never MCP;
 *   - the closed request and response shapes, with extra fields refused;
 *   - the runtime projection: only categorical facts leave, and a locked note
 *     is refused before the inspector runs;
 *   - read-only: a guarded database proves the live builder reads only the
 *     note lookup and the pure content get, and never writes.
 */

import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import type {
  NotesnookConflictInspection,
  NotesnookLocalConflictInspector,
} from "../src/core/notesnook-local-conflict-projection.js";
import { buildOptionalLiveLocalConflictInspector } from "../src/core/notesnook-live-factory.js";
import { createOperatorConflictInspectRuntime } from "../src/service/notes-conflict-inspect-runtime.js";
import { OPERATOR_TARGET_READ_METHODS } from "../src/service/operator-authorizer.js";
import { OPERATOR_METHODS } from "../src/service/operator-methods.js";
import { handleRpcRequest } from "../src/service/rpc-handler.js";
import {
  parseRpcFrame,
  serializeRpcResponse,
  type RpcRequest,
} from "../src/service/rpc-protocol.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";

const HANDLE = "handle-note-1";
const BINDING = "c".repeat(64);
const SECRET = "PRIVATE-INSPECT-SECRET-3e8b";
const LOCAL_BODY = '<p data-block-id="l1">local body</p>';
const REMOTE_BODY = '<p data-block-id="r1">remote body</p>';
const PEER = { uid: 1, gid: 2, groups: [] as string[] };
const SIDE = { present: true, unlocked: true, tiptap: true, byteSize: 42 };
const SIDE_LOCKED = { present: true, unlocked: false, tiptap: false, byteSize: null };

/** Reads the live builder is allowed to make. Anything else is a violation. */
const ALLOWED_READS: ReadonlySet<string> = new Set([
  "notes",
  "notes.conflicted",
  "notes.conflicted.ids",
  "notes.note",
  "content",
  "content.collection",
  "content.collection.get",
]);

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

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function runtimeWith(options: {
  inspect?: () => Promise<NotesnookConflictInspection>;
  lock?: () => Promise<"locked" | "unlocked">;
}) {
  const inspectConflict = vi.fn(
    options.inspect ?? (async () => ({ outcome: "not-conflicted" as const })),
  );
  const readNoteLockState = vi.fn(options.lock ?? (async () => "unlocked" as const));
  const inspector: NotesnookLocalConflictInspector = { inspectConflict };
  const runtime = createOperatorConflictInspectRuntime({
    inspector,
    readNoteLockState,
    resolveHandle: (handle: string) => (handle === HANDLE ? "note-1" : undefined),
  });
  return { runtime, inspectConflict, readNoteLockState };
}

describe("Stage 5 slice D — admission and the MCP refusal", () => {
  it("admits notes.inspect-conflict on the operator vocabulary", () => {
    expect(OPERATOR_METHODS).toContain("notes.inspect-conflict");
  });

  it("lists notes.inspect-conflict as a target read, so it needs no mutation grant", () => {
    expect(OPERATOR_TARGET_READ_METHODS).toContain("notes.inspect-conflict");
  });

  it("refuses notes.inspect-conflict on the MCP listener without running anything", async () => {
    const response = await handleRpcRequest(
      {
        id: "mcp-i-1",
        method: "notes.inspect-conflict",
        params: { id: HANDLE },
      } as unknown as RpcRequest,
      {} as never,
      createReadWriteNoDeleteServicePolicy(),
    );

    expect(response.ok).toBe(false);
    expect((response as unknown as { error: { code: string } }).error.code).toBe("invalid_request");
    expect(response).not.toHaveProperty("result");
  });
});

describe("Stage 5 slice D — request and response protocol", () => {
  it("parses the closed request shape with the handle alone", () => {
    const request = parseRpcFrame(
      frameOf({ id: "i-1", method: "notes.inspect-conflict", params: { id: HANDLE } }),
    );
    expect(request).toMatchObject({ method: "notes.inspect-conflict", params: { id: HANDLE } });
  });

  it.each([
    ["a binding", { id: HANDLE, binding: BINDING }],
    ["a body", { id: HANDLE, body: SECRET }],
    ["an empty handle", { id: "" }],
    ["a missing handle", {}],
    ["a control character in the handle", { id: "handle\u0007" }],
  ])("rejects a request with %s", (_label, params) => {
    expect(() =>
      parseRpcFrame(frameOf({ id: "i-2", method: "notes.inspect-conflict", params })),
    ).toThrow();
  });

  it("serializes each closed outcome", () => {
    const side = { ...SIDE };
    const cases: ReadonlyArray<Record<string, unknown>> = [
      { kind: "conflict-inspection", outcome: "not-conflicted" },
      { kind: "conflict-inspection", outcome: "not-found" },
      {
        kind: "conflict-inspection",
        outcome: "unreadable",
        local: SIDE_LOCKED,
        remote: side,
      },
      {
        kind: "conflict-inspection",
        outcome: "inspected",
        local: side,
        remote: side,
        sidesEqual: true,
        remoteHasAttachments: false,
        binding: BINDING,
      },
    ];
    for (const result of cases) {
      const frame = serializeRpcResponse({ id: "i-3", ok: true, result: result as never });
      expect(bodyOf(frame)).toEqual({ id: "i-3", ok: true, result });
    }
  });

  it.each([
    [
      "an extra field on a side",
      {
        kind: "conflict-inspection",
        outcome: "unreadable",
        local: { ...SIDE_LOCKED, text: SECRET },
        remote: SIDE,
      },
    ],
    [
      "a negative size",
      {
        kind: "conflict-inspection",
        outcome: "unreadable",
        local: { ...SIDE_LOCKED, byteSize: -1 },
        remote: SIDE,
      },
    ],
    [
      "a fractional size",
      {
        kind: "conflict-inspection",
        outcome: "unreadable",
        local: { ...SIDE_LOCKED, byteSize: 1.5 },
        remote: SIDE,
      },
    ],
    [
      "a side missing tiptap",
      {
        kind: "conflict-inspection",
        outcome: "unreadable",
        local: { present: true, unlocked: true, byteSize: 1 },
        remote: SIDE,
      },
    ],
    [
      "an upper-case binding",
      {
        kind: "conflict-inspection",
        outcome: "inspected",
        local: SIDE,
        remote: SIDE,
        sidesEqual: true,
        remoteHasAttachments: false,
        binding: "C".repeat(64),
      },
    ],
    [
      "a short binding",
      {
        kind: "conflict-inspection",
        outcome: "inspected",
        local: SIDE,
        remote: SIDE,
        sidesEqual: true,
        remoteHasAttachments: false,
        binding: "c".repeat(63),
      },
    ],
    [
      "a non-boolean sidesEqual",
      {
        kind: "conflict-inspection",
        outcome: "inspected",
        local: SIDE,
        remote: SIDE,
        sidesEqual: "yes",
        remoteHasAttachments: false,
        binding: BINDING,
      },
    ],
    [
      "sides on a not-found result",
      { kind: "conflict-inspection", outcome: "not-found", local: SIDE },
    ],
    ["an unknown outcome", { kind: "conflict-inspection", outcome: "deleted" }],
  ])("refuses to serialize a result with %s", (_label, result) => {
    expect(() => serializeRpcResponse({ id: "i-4", ok: true, result: result as never })).toThrow();
  });
});

describe("Stage 5 slice D — the runtime projection", () => {
  it("passes a not-conflicted or not-found outcome through as the closed result", async () => {
    for (const outcome of ["not-conflicted", "not-found"] as const) {
      const { runtime } = runtimeWith({ inspect: async () => ({ outcome }) });
      await expect(runtime.inspectConflict({ id: HANDLE }, PEER)).resolves.toEqual({
        kind: "conflict-inspection",
        outcome,
      });
    }
  });

  it("projects an inspected outcome to four facts per side and drops every other field", async () => {
    const leakyInspection = {
      outcome: "inspected",
      local: { ...SIDE, text: LOCAL_BODY, id: "raw-local-id" },
      remote: { ...SIDE, text: REMOTE_BODY, id: "raw-remote-id" },
      sidesEqual: false,
      remoteHasAttachments: true,
      binding: BINDING,
      note: SECRET,
    };
    const { runtime } = runtimeWith({ inspect: async () => leakyInspection as never });

    const result = await runtime.inspectConflict({ id: HANDLE }, PEER);

    expect(result).toEqual({
      kind: "conflict-inspection",
      outcome: "inspected",
      local: SIDE,
      remote: SIDE,
      sidesEqual: false,
      remoteHasAttachments: true,
      binding: BINDING,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(LOCAL_BODY);
    expect(serialized).not.toContain(REMOTE_BODY);
    expect(serialized).not.toContain("raw-local-id");
    expect(serialized).not.toContain(SECRET);
  });

  it("projects an unreadable outcome to its two sides only", async () => {
    const { runtime } = runtimeWith({
      inspect: async () => ({ outcome: "unreadable", local: SIDE_LOCKED, remote: SIDE }),
    });
    await expect(runtime.inspectConflict({ id: HANDLE }, PEER)).resolves.toEqual({
      kind: "conflict-inspection",
      outcome: "unreadable",
      local: SIDE_LOCKED,
      remote: SIDE,
    });
  });

  it("refuses a locked note as vault_locked and never runs the inspector", async () => {
    const { runtime, inspectConflict } = runtimeWith({ lock: async () => "locked" });

    const error = await failureOf(runtime.inspectConflict({ id: HANDLE }, PEER));

    expect(error).toMatchObject({ code: "vault_locked" });
    expect(inspectConflict).not.toHaveBeenCalled();
  });

  it("answers service_unavailable when the lock state cannot be read, with no inspection", async () => {
    const { runtime, inspectConflict } = runtimeWith({
      lock: async () => {
        throw new Error(SECRET);
      },
    });

    const error = await failureOf(runtime.inspectConflict({ id: HANDLE }, PEER));

    expect(error).toMatchObject({ code: "service_unavailable" });
    expect(String((error as Error).message)).not.toContain(SECRET);
    expect(inspectConflict).not.toHaveBeenCalled();
  });

  it("refuses an unknown handle as not_found before any lock read or inspection", async () => {
    const { runtime, inspectConflict, readNoteLockState } = runtimeWith({});

    const error = await failureOf(runtime.inspectConflict({ id: "handle-unknown" }, PEER));

    expect(error).toMatchObject({ code: "not_found" });
    expect(readNoteLockState).not.toHaveBeenCalled();
    expect(inspectConflict).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-string handle", 7],
    ["an empty handle", ""],
    ["an over-long handle", "h".repeat(257)],
  ])("refuses %s as invalid_request before any lookup", async (_label, id) => {
    const { runtime, inspectConflict, readNoteLockState } = runtimeWith({});

    const error = await failureOf(runtime.inspectConflict({ id: id as unknown as string }, PEER));

    expect(error).toMatchObject({ code: "invalid_request" });
    expect(readNoteLockState).not.toHaveBeenCalled();
    expect(inspectConflict).not.toHaveBeenCalled();
  });

  it("answers service_unavailable when the inspector throws, with no cause forwarded", async () => {
    const { runtime } = runtimeWith({
      inspect: async () => {
        throw new Error(SECRET);
      },
    });

    const error = await failureOf(runtime.inspectConflict({ id: HANDLE }, PEER));

    expect(error).toMatchObject({ code: "service_unavailable" });
    expect(String((error as Error).message)).not.toContain(SECRET);
  });
});

/**
 * What a guarded database saw: every allowed read, every forbidden access, and
 * each lookup actually invoked. Construction reads the lookups as references,
 * so only `calls` says whether content was read.
 */
type Access = { touched: string[]; violations: string[]; calls: string[] };
type Tree = Record<string, unknown>;

/**
 * Wrap a plain tree so that any property read outside the allowlist, and any
 * write, define, or delete, is recorded. A forbidden read returns `undefined`.
 */
function guarded(target: Tree, prefix: string, access: Access): Tree {
  return new Proxy(target, {
    get(source, key) {
      const path = prefix === "" ? String(key) : `${prefix}.${String(key)}`;
      if (!ALLOWED_READS.has(path)) {
        access.violations.push(`get ${path}`);
        return undefined;
      }
      access.touched.push(path);
      const value = Reflect.get(source, key);
      return typeof value === "object" && value !== null
        ? guarded(value as Tree, path, access)
        : value;
    },
    set(_source, key) {
      access.violations.push(`set ${String(key)}`);
      return false;
    },
    defineProperty(_source, key) {
      access.violations.push(`define ${String(key)}`);
      return false;
    },
    deleteProperty(_source, key) {
      access.violations.push(`delete ${String(key)}`);
      return false;
    },
  });
}

function liveDatabase(access: Access): Tree {
  const notes = new Map<string, Tree>([
    ["note-1", { id: "note-1", title: "Field notes", contentId: "content-1", conflicted: true }],
  ]);
  const contents = new Map<string, Tree>([
    [
      "content-1",
      {
        id: "content-1",
        noteId: "note-1",
        type: "tiptap",
        locked: false,
        data: LOCAL_BODY,
        dateModified: 1_000,
        conflicted: {
          id: "content-1",
          noteId: "note-1",
          type: "tiptap",
          locked: false,
          data: REMOTE_BODY,
          dateModified: 2_000,
        },
      },
    ],
  ]);
  return guarded(
    {
      notes: {
        conflicted: { ids: async () => ["note-1"] },
        note: async (id: string) => {
          access.calls.push("notes.note");
          return notes.get(id);
        },
      },
      content: {
        collection: {
          get: async (id: string) => {
            access.calls.push("content.collection.get");
            return contents.get(id);
          },
        },
      },
    },
    "",
    access,
  );
}

describe("Stage 5 slice D — read-only against the live builder", () => {
  it("guard records a forbidden read, so the read-only assertion cannot pass vacuously", () => {
    const access: Access = { touched: [], violations: [], calls: [] };
    const db = liveDatabase(access);
    const content = db.content as Tree;
    expect(content.get).toBeUndefined();
    expect(access.violations).toEqual(["get content.get"]);
  });

  it("inspects through the live builder with no write and no forbidden read", async () => {
    const access: Access = { touched: [], violations: [], calls: [] };
    const inspector = buildOptionalLiveLocalConflictInspector(liveDatabase(access), () => {});
    expect(inspector).toBeDefined();
    const runtime = createOperatorConflictInspectRuntime({
      inspector: inspector as NotesnookLocalConflictInspector,
      readNoteLockState: async () => "unlocked",
      resolveHandle: (handle: string) => (handle === HANDLE ? "note-1" : undefined),
    });

    const result = await runtime.inspectConflict({ id: HANDLE }, PEER);

    expect(result).toMatchObject({
      kind: "conflict-inspection",
      outcome: "inspected",
      local: {
        present: true,
        unlocked: true,
        tiptap: true,
        byteSize: Buffer.byteLength(LOCAL_BODY),
      },
      remote: {
        present: true,
        unlocked: true,
        tiptap: true,
        byteSize: Buffer.byteLength(REMOTE_BODY),
      },
      sidesEqual: false,
      remoteHasAttachments: false,
    });
    expect((result as { binding: string }).binding).toMatch(/^[0-9a-f]{64}$/);
    expect(access.violations).toEqual([]);
    expect(access.calls).toEqual(["notes.note", "content.collection.get"]);
    expect(JSON.stringify(result)).not.toContain(LOCAL_BODY);
  });

  it("refuses a locked note before the live builder invokes any lookup", async () => {
    const access: Access = { touched: [], violations: [], calls: [] };
    const inspector = buildOptionalLiveLocalConflictInspector(liveDatabase(access), () => {});
    const runtime = createOperatorConflictInspectRuntime({
      inspector: inspector as NotesnookLocalConflictInspector,
      readNoteLockState: async () => "locked",
      resolveHandle: (handle: string) => (handle === HANDLE ? "note-1" : undefined),
    });

    const error = await failureOf(runtime.inspectConflict({ id: HANDLE }, PEER));

    expect(error).toMatchObject({ code: "vault_locked" });
    expect(access.calls).toEqual([]);
    expect(access.violations).toEqual([]);
  });
});
