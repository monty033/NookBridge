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

  it("refresh-resolves a notebookId when the startup index is stale", async () => {
    const { calls, evaluator } = makeEvaluator(true);
    const createNote = vi.fn(async () => createResult());
    const resolveNotebookPath = vi.fn(async (notebookId: string) =>
      notebookId === "fresh-child" ? "Outdoors/Canoe" : undefined,
    );
    const response = await handleRpcRequest(
      request("notes.create", { title: "New", content: "Body", notebookId: "fresh-child" }),
      makeRuntime({ createNote, notebookIndex: makeIndex(), resolveNotebookPath }),
      createReadWriteNoDeleteServicePolicy(evaluator),
    );

    expect(response.ok).toBe(true);
    expect(resolveNotebookPath).toHaveBeenCalledWith("fresh-child");
    expect(createNote).toHaveBeenCalledOnce();
    expect(calls).toEqual([{ op: "create", ctx: { notebookPath: "Outdoors/Canoe" } }]);
  });

  it("forwards listKind='simple-checklist' through the handler into createNote", async () => {
    const createNote = vi.fn(async () => createResult());
    const response = await handleRpcRequest(
      request("notes.create", {
        title: "New",
        content: "- [x] done",
        listKind: "simple-checklist",
      }),
      makeRuntime({ createNote }),
      createReadWriteNoDeleteServicePolicy(makeEvaluator(true).evaluator),
    );
    expect(response.ok).toBe(true);
    expect(createNote).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "New",
        content: "- [x] done",
        listKind: "simple-checklist",
      }),
    );
  });

  it("forwards listKind='task-list' through the handler into appendNote", async () => {
    const appendNote = vi.fn(async () => appendResult());
    const response = await handleRpcRequest(
      request("notes.append", {
        id: "0123456789abcdef0123456789abcdef",
        markdownFragment: "- [x] done",
        expectedRevision: "rev_00000000000000000000000000000000",
        listKind: "task-list",
      }),
      makeRuntime({ appendNote, notebookIndex: makeIndex() }),
      createReadWriteNoDeleteServicePolicy(makeEvaluator(true).evaluator),
    );
    expect(response.ok).toBe(true);
    expect(appendNote).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "0123456789abcdef0123456789abcdef",
        markdownFragment: "- [x] done",
        expectedRevision: "rev_00000000000000000000000000000000",
        listKind: "task-list",
      }),
    );
  });

  it("forwards listKind='task-list' through the handler into updateNote patch", async () => {
    const updateNote = vi.fn(async () => updateResult());
    const response = await handleRpcRequest(
      request("notes.update", {
        id: "0123456789abcdef0123456789abcdef",
        expectedRevision: "rev_00000000000000000000000000000000",
        patch: { content: "- [x] done", listKind: "task-list" },
      }),
      makeRuntime({ updateNote, notebookIndex: makeIndex() }),
      createReadWriteNoDeleteServicePolicy(makeEvaluator(true).evaluator),
    );
    expect(response.ok).toBe(true);
    expect(updateNote).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "0123456789abcdef0123456789abcdef",
        expectedRevision: "rev_00000000000000000000000000000000",
        patch: expect.objectContaining({
          content: "- [x] done",
          listKind: "task-list",
        }),
      }),
    );
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

  it("passes exact delete path context to settings authorization before resolving or mutating", async () => {
    const { calls, evaluator } = makeEvaluator((_op, ctx) =>
      ctx.notebookPath === "Personal/Projects" && ctx.noteTitle === "Roadmap" ? false : true,
    );
    const resolveNotePath = vi.fn(async () => {
      throw new Error("delete resolver must not run after policy denial");
    });
    const deleteNote = vi.fn(async () => {
      throw new Error("delete mutation must not run after policy denial");
    });
    const response = await handleRpcRequest(
      request("notes.delete", { path: "Personal/Projects/Roadmap" }),
      makeRuntime({ resolveNotePath, deleteNote }),
      createReadWriteNoDeleteServicePolicy(evaluator),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(calls).toEqual([
      { op: "delete", ctx: { notebookPath: "Personal/Projects", noteTitle: "Roadmap" } },
    ]);
    expect(resolveNotePath).not.toHaveBeenCalled();
    expect(deleteNote).not.toHaveBeenCalled();
  });

  it("passes explicit notebook and slash-containing title context to authorization", async () => {
    const { calls, evaluator } = makeEvaluator((_op, ctx) =>
      ctx.notebookPath === "Personal/Projects" && ctx.noteTitle === "Roadmap/A" ? false : true,
    );
    const resolveNotePath = vi.fn(async () => {
      throw new Error("delete resolver must not run after policy denial");
    });
    const deleteNote = vi.fn(async () => {
      throw new Error("delete mutation must not run after policy denial");
    });
    const response = await handleRpcRequest(
      request("notes.delete", { notebookPath: "Personal/Projects", noteTitle: "Roadmap/A" }),
      makeRuntime({ resolveNotePath, deleteNote }),
      createReadWriteNoDeleteServicePolicy(evaluator),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(calls).toEqual([
      { op: "delete", ctx: { notebookPath: "Personal/Projects", noteTitle: "Roadmap/A" } },
    ]);
    expect(resolveNotePath).not.toHaveBeenCalled();
    expect(deleteNote).not.toHaveBeenCalled();
  });

  it("preserves a vault_locked delete refusal at the RPC boundary", async () => {
    const { evaluator } = makeEvaluator(true);
    const resolveNotePath = vi.fn(async () => ({
      id: "locked-note",
      expectedRevision: REVISION,
    }));
    const deleteNote = vi.fn(async () => {
      const error = new Error("upstream locked detail must stay internal");
      Object.defineProperty(error, "code", { value: "vault_locked" });
      throw error;
    });

    const response = await handleRpcRequest(
      request("notes.delete", { path: "General/Bernie Test Locked" }),
      makeRuntime({ resolveNotePath, deleteNote }),
      createReadWriteNoDeleteServicePolicy(evaluator),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "vault_locked" } });
    expect(resolveNotePath).toHaveBeenCalledWith("General/Bernie Test Locked");
    expect(deleteNote).toHaveBeenCalledWith({
      id: "locked-note",
      expectedRevision: REVISION,
    });
    expect(JSON.stringify(response)).not.toContain("locked detail");
  });

  it("resolves the root-note context shape when a delete is allowed", async () => {
    const { calls, evaluator } = makeEvaluator(true);
    const resolveNotePath = vi.fn(async () => ({
      id: "note-1",
      expectedRevision: REVISION,
    }));
    const deleteNote = vi.fn(
      async () =>
        ({
          operation: "delete",
          id: "note-1",
          localCommitted: true,
          remoteSynced: false,
          pendingSync: true,
        }) as const,
    );
    const response = await handleRpcRequest(
      request("notes.delete", { path: "Roadmap" }),
      makeRuntime({ resolveNotePath, deleteNote }),
      createReadWriteNoDeleteServicePolicy(evaluator),
    );

    expect(response).toMatchObject({ ok: true, result: { kind: "delete", id: "note-1" } });
    expect(calls).toEqual([{ op: "delete", ctx: { noteTitle: "Roadmap" } }]);
    expect(resolveNotePath).toHaveBeenCalledWith("Roadmap");
    expect(deleteNote).toHaveBeenCalledWith({ id: "note-1", expectedRevision: REVISION });
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

  it("forwards multiline Markdown create content to the runtime", async () => {
    // Defence-in-depth structural validator: a live canary body with
    // headings, newlines, tabs, four-space nested task lists, and
    // checked/unchecked task markers must reach `createNote` unchanged.
    const { evaluator } = makeEvaluator(true);
    const createNote = vi.fn(async () => createResult());
    const content =
      "# Heading\n\nbody\n- [ ] unchecked\n- [x] checked\n    - [ ] nested child\n        - [ ] grandchild 4-space\n";
    const response = await handleRpcRequest(
      request("notes.create", { title: "New", content }),
      makeRuntime({ createNote }),
      createReadWriteNoDeleteServicePolicy(evaluator),
    );
    expect(response.ok).toBe(true);
    expect(createNote).toHaveBeenCalledWith(expect.objectContaining({ title: "New", content }));
  });

  it("rejects NUL and other ASCII control bytes in create content at the handler structural layer", async () => {
    const { evaluator } = makeEvaluator(true);
    const createNote = vi.fn(async () => createResult());
    for (const content of ["line\u0000null", "bell\u0007bad", "esc\u001bbad"]) {
      const response = await handleRpcRequest(
        request("notes.create", { title: "New", content }),
        makeRuntime({ createNote }),
        createReadWriteNoDeleteServicePolicy(evaluator),
      );
      expect(response).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
    expect(createNote).not.toHaveBeenCalled();
  });
});
