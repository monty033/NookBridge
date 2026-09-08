/**
 * Stage 10 Task 7 — enforce settings decisions at the RPC handler boundary.
 */

import { describe, expect, it, vi } from "vitest";

import { buildNotebookIndex } from "../src/settings/notebook-index.js";
import type { SettingsOperation } from "../src/settings/settings-types.js";
import {
  createReadWriteNoDeleteServicePolicy,
  type ServicePolicySettingsContext,
} from "../src/service/service-policy.js";
import { handleRpcRequest, type RpcHandlerRuntimeLike } from "../src/service/rpc-handler.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";
import type {
  AppendNoteResult,
  CreateNoteResult,
  UpdateNoteResult,
} from "../src/core/notesnook-write-adapter.js";

const REVISION = "rev_0123456789abcdef0123456789abcdef";

function makeIndex() {
  return buildNotebookIndex([
    { id: "root", title: "Personal" },
    { id: "child", title: "Projects", parentId: "root" },
  ]);
}

function makeEvaluator(
  allowed: boolean | ((op: SettingsOperation, ctx: ServicePolicySettingsContext) => boolean),
) {
  const calls: Array<{ op: SettingsOperation; ctx: ServicePolicySettingsContext }> = [];
  const evaluator = (op: SettingsOperation, ctx: ServicePolicySettingsContext) => {
    calls.push({ op, ctx });
    return { allowed: typeof allowed === "function" ? allowed(op, ctx) : allowed };
  };
  return { calls, evaluator };
}

function makeRuntime(overrides: Partial<RpcHandlerRuntimeLike> = {}): RpcHandlerRuntimeLike {
  return {
    search: async () => [{ title: "visible" }],
    status: async () => ({ lastSynced: 0, hasUnsyncedChanges: false }),
    listNotebooks: async () => [{ id: "root", title: "Personal" }],
    noteMetadata: async (id) => ({ id, title: "Roadmap", notebookId: "child" }),
    ...overrides,
  };
}

function request(method: RpcRequest["method"], params: Record<string, unknown>): RpcRequest {
  return { id: `${method}-1`, method, params } as RpcRequest;
}

function createResult(): CreateNoteResult {
  return {
    operation: "create",
    id: "new-note",
    titleBytes: 1,
    contentBytes: 1,
    localCommitted: true,
    remoteSynced: false,
    pendingSync: true,
  };
}

function appendResult(): AppendNoteResult {
  return {
    operation: "append",
    id: "note-1",
    contentBytes: 1,
    localCommitted: true,
    remoteSynced: false,
    pendingSync: true,
  };
}

function updateResult(): UpdateNoteResult {
  return {
    operation: "update",
    id: "note-1",
    appliedFields: ["title"],
    localCommitted: true,
    remoteSynced: false,
    pendingSync: true,
  };
}

describe("Stage 10 Task 7 — RPC handler settings enforcement", () => {
  it("evaluates global read methods with an empty context", async () => {
    const { calls, evaluator } = makeEvaluator(true);
    const response = await handleRpcRequest(
      request("notes.status", {}),
      makeRuntime(),
      createReadWriteNoDeleteServicePolicy(evaluator),
    );

    expect(response.ok).toBe(true);
    expect(calls).toEqual([{ op: "read", ctx: {} }]);
  });

  it("resolves a note and its parent notebook before authorizing notes.get", async () => {
    const { calls, evaluator } = makeEvaluator(true);
    const noteMetadata = vi.fn(async () => ({
      id: "note-1",
      title: "Roadmap",
      notebookId: "child",
    }));
    const response = await handleRpcRequest(
      request("notes.get", { id: "note-1" }),
      makeRuntime({ noteMetadata, notebookIndex: makeIndex() }),
      createReadWriteNoDeleteServicePolicy(evaluator),
    );

    expect(response.ok).toBe(true);
    expect(noteMetadata).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      { op: "read", ctx: { notebookPath: "Personal/Projects", noteTitle: "Roadmap" } },
    ]);
  });

  it("resolves notebookId through the trusted index before authorizing notes.create", async () => {
    const { calls, evaluator } = makeEvaluator(true);
    const createNote = vi.fn(async () => createResult());
    const response = await handleRpcRequest(
      request("notes.create", { title: "New", content: "Body", notebookId: "child" }),
      makeRuntime({ createNote, notebookIndex: makeIndex() }),
      createReadWriteNoDeleteServicePolicy(evaluator),
    );

    expect(response.ok).toBe(true);
    expect(createNote).toHaveBeenCalledOnce();
    expect(calls).toEqual([{ op: "create", ctx: { notebookPath: "Personal/Projects" } }]);
  });

  it("resolves note context before a denied notes.get and emits no context data", async () => {
    const { calls, evaluator } = makeEvaluator(false);
    const noteMetadata = vi.fn(async () => ({
      id: "note-1",
      title: "Roadmap",
      notebookId: "child",
    }));
    const response = await handleRpcRequest(
      request("notes.get", { id: "note-1" }),
      makeRuntime({ noteMetadata, notebookIndex: makeIndex() }),
      createReadWriteNoDeleteServicePolicy(evaluator),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(noteMetadata).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      { op: "read", ctx: { notebookPath: "Personal/Projects", noteTitle: "Roadmap" } },
    ]);
    expect(JSON.stringify(response)).not.toContain("Personal/Projects");
    expect(JSON.stringify(response)).not.toContain("Roadmap");
    expect(JSON.stringify(response)).not.toContain("note-1");
  });

  it("resolves note context before authorizing append and update", async () => {
    const { calls, evaluator } = makeEvaluator(true);
    const runtime = makeRuntime({
      notebookIndex: makeIndex(),
      appendNote: vi.fn(async () => appendResult()),
      updateNote: vi.fn(async () => updateResult()),
    });

    await expect(
      handleRpcRequest(
        request("notes.append", {
          id: "note-1",
          markdownFragment: "x",
          expectedRevision: REVISION,
        }),
        runtime,
        createReadWriteNoDeleteServicePolicy(evaluator),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      handleRpcRequest(
        request("notes.update", {
          id: "note-1",
          expectedRevision: REVISION,
          patch: { title: "Updated" },
        }),
        runtime,
        createReadWriteNoDeleteServicePolicy(evaluator),
      ),
    ).resolves.toMatchObject({ ok: true });

    expect(calls).toEqual([
      { op: "edit", ctx: { notebookPath: "Personal/Projects", noteTitle: "Roadmap" } },
      { op: "edit", ctx: { notebookPath: "Personal/Projects", noteTitle: "Roadmap" } },
    ]);
  });

  it("does not mutate when the evaluator denies a resolved write", async () => {
    const { calls, evaluator } = makeEvaluator(false);
    const createNote = vi.fn(async () => createResult());
    const response = await handleRpcRequest(
      request("notes.create", { title: "New", content: "Body", notebookId: "child" }),
      makeRuntime({ createNote, notebookIndex: makeIndex() }),
      createReadWriteNoDeleteServicePolicy(evaluator),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(createNote).not.toHaveBeenCalled();
    expect(calls).toEqual([{ op: "create", ctx: { notebookPath: "Personal/Projects" } }]);
  });

  it("fails closed when a requested notebook cannot be resolved", async () => {
    const { evaluator } = makeEvaluator(true);
    const createNote = vi.fn(async () => createResult());
    const response = await handleRpcRequest(
      request("notes.create", { title: "New", content: "Body", notebookId: "unknown" }),
      makeRuntime({ createNote, notebookIndex: makeIndex() }),
      createReadWriteNoDeleteServicePolicy(evaluator),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(createNote).not.toHaveBeenCalled();
  });

  it("fails closed when a note's trusted parent notebook cannot be resolved", async () => {
    const { evaluator } = makeEvaluator(true);
    const appendNote = vi.fn(async () => appendResult());
    const response = await handleRpcRequest(
      request("notes.append", {
        id: "note-1",
        markdownFragment: "x",
        expectedRevision: REVISION,
      }),
      makeRuntime({
        appendNote,
        notebookIndex: makeIndex(),
        noteMetadata: async () => ({
          id: "note-1",
          title: "Roadmap",
          notebookId: "unknown",
        }),
      }),
      createReadWriteNoDeleteServicePolicy(evaluator),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(appendNote).not.toHaveBeenCalled();
  });

  it("keeps the evaluator optional for existing handler construction", async () => {
    const response = await handleRpcRequest(request("notes.get", { id: "note-1" }), makeRuntime());

    expect(response.ok).toBe(true);
  });
});
