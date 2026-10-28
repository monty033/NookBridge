/**
 * Security findings 1-3 — multi-notebook authorization.
 *
 * These reproduce the defects recorded in
 * `docs/engineering/stages/stage-9-security-review.md` (§13.24 / §13.25 of
 * the implementation plan):
 *
 *   1. `notes.delete` authorizes the caller-supplied path and then deletes
 *      the resolved note without re-authorizing against it.
 *   2. A note directly attached to several notebooks is judged by whichever
 *      notebook enumerates first.
 *   3. `notes.update` with `patch.notebookId` authorizes the source note's
 *      context and never evaluates the destination notebook.
 *
 * The tests assert the required behaviour (deny-wins, fail-closed). They are
 * expected to FAIL on the pre-fix tree; each failure is the defect.
 */

import { describe, expect, it, vi } from "vitest";

import { buildNotebookIndex } from "../src/settings/notebook-index.js";
import type { SettingsOperation } from "../src/settings/settings-types.js";
import {
  createCustomServicePolicy,
  type ServicePolicySettingsContext,
} from "../src/service/service-policy.js";
import { handleRpcRequest, type RpcHandlerRuntimeLike } from "../src/service/rpc-handler.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";
import type { DeleteNoteResult, UpdateNoteResult } from "../src/core/notesnook-write-adapter.js";

const REVISION = "rev_0123456789abcdef0123456789abcdef";
const DENIED = "Personal/Secret";

/** Personal (root) -> Projects, Secret. Titles are the paths' last segment. */
function makeIndex() {
  return buildNotebookIndex([
    { id: "root", title: "Personal" },
    { id: "projects", title: "Projects", parentId: "root" },
    { id: "secret", title: "Secret", parentId: "root" },
  ]);
}

/** Deny-win policy: the Secret notebook refuses everything. */
function makeDenySecretEvaluator() {
  const calls: Array<{ op: SettingsOperation; ctx: ServicePolicySettingsContext }> = [];
  const evaluator = (op: SettingsOperation, ctx: ServicePolicySettingsContext) => {
    calls.push({ op, ctx });
    return { allowed: ctx.notebookPath !== DENIED };
  };
  return { calls, evaluator };
}

function request(method: RpcRequest["method"], params: Record<string, unknown>): RpcRequest {
  return { id: `${method}-1`, method, params } as RpcRequest;
}

function deleteResult(id: string): DeleteNoteResult {
  return {
    operation: "delete",
    id,
    localCommitted: true,
    remoteSynced: false,
    pendingSync: true,
  };
}

function updateResult(id: string): UpdateNoteResult {
  return {
    operation: "update",
    id,
    appliedFields: ["notebookId"],
    localCommitted: true,
    remoteSynced: false,
    pendingSync: true,
  };
}

describe("finding 1 — notes.delete must re-authorize the resolved note", () => {
  it("refuses when the caller's path is allowed but the note's actual notebook is denied", async () => {
    const { evaluator } = makeDenySecretEvaluator();
    const deleteNote = vi.fn(async () => deleteResult("note-1"));
    const runtime = {
      search: async () => [{ title: "Roadmap" }],
      notebookIndex: makeIndex(),
      // The caller claims Personal/Roadmap, which the policy allows.
      resolveNotePath: async () => ({ id: "note-1", expectedRevision: REVISION }),
      // The note actually lives in Personal/Secret, which the policy denies.
      noteMetadata: async (id: string) => ({ id, title: "Roadmap", notebookId: "secret" }),
      deleteNote,
    } as unknown as RpcHandlerRuntimeLike;

    const response = await handleRpcRequest(
      request("notes.delete", { path: "Personal/Roadmap" }),
      runtime,
      createCustomServicePolicy(["notes.search", "notes.get", "notes.delete"], evaluator),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(deleteNote).not.toHaveBeenCalled();
  });
});

describe("finding 2 — deny-wins across every directly-attached notebook", () => {
  it("refuses an allowed first notebook when another attached notebook denies", async () => {
    const { evaluator } = makeDenySecretEvaluator();
    const deleteNote = vi.fn(async () => deleteResult("note-1"));
    const runtime = {
      search: async () => [{ title: "Roadmap" }],
      notebookIndex: makeIndex(),
      resolveNotePath: async () => ({ id: "note-1", expectedRevision: REVISION }),
      // Attached to Projects (allowed) AND Secret (denied). Today only the
      // first/single `notebookId` is consulted, so the denial is never seen.
      noteMetadata: async (id: string) =>
        ({
          id,
          title: "Roadmap",
          notebookId: "projects",
          notebookIds: ["projects", "secret"],
        }) as never,
      deleteNote,
    } as unknown as RpcHandlerRuntimeLike;

    const response = await handleRpcRequest(
      request("notes.delete", { path: "Personal/Projects/Roadmap" }),
      runtime,
      createCustomServicePolicy(["notes.search", "notes.get", "notes.delete"], evaluator),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(deleteNote).not.toHaveBeenCalled();
  });
});

describe("finding 3 — notes.update must authorize the destination notebook", () => {
  it("refuses moving a note into a notebook that denies the write", async () => {
    const { evaluator } = makeDenySecretEvaluator();
    const updateNote = vi.fn(async () => updateResult("note-1"));
    const runtime = {
      search: async () => [{ title: "Roadmap" }],
      notebookIndex: makeIndex(),
      // Source context is allowed: the note sits in Personal/Projects.
      noteMetadata: async (id: string) => ({ id, title: "Roadmap", notebookId: "projects" }),
      updateNote,
    } as unknown as RpcHandlerRuntimeLike;

    const response = await handleRpcRequest(
      request("notes.update", {
        id: "note-1",
        expectedRevision: REVISION,
        patch: { notebookId: "secret" },
      }),
      runtime,
      createCustomServicePolicy(["notes.search", "notes.get", "notes.update"], evaluator),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(updateNote).not.toHaveBeenCalled();
  });
});

describe("control — single-notebook notes keep working", () => {
  it("still deletes a note whose only notebook allows the operation", async () => {
    const { evaluator } = makeDenySecretEvaluator();
    const deleteNote = vi.fn(async () => deleteResult("note-1"));
    const runtime = {
      search: async () => [{ title: "Roadmap" }],
      notebookIndex: makeIndex(),
      resolveNotePath: async () => ({ id: "note-1", expectedRevision: REVISION }),
      noteMetadata: async (id: string) => ({ id, title: "Roadmap", notebookId: "projects" }),
      deleteNote,
    } as unknown as RpcHandlerRuntimeLike;

    const response = await handleRpcRequest(
      request("notes.delete", { path: "Personal/Projects/Roadmap" }),
      runtime,
      createCustomServicePolicy(["notes.search", "notes.get", "notes.delete"], evaluator),
    );

    expect(response).toMatchObject({ ok: true });
    expect(deleteNote).toHaveBeenCalledTimes(1);
  });
});

describe("membership that cannot be trusted fails closed", () => {
  it("refuses a present but malformed notebook set instead of falling back to the scalar id", async () => {
    const { evaluator } = makeDenySecretEvaluator();
    const deleteNote = vi.fn(async () => deleteResult("note-1"));
    const runtime = {
      search: async () => [{ title: "Roadmap" }],
      notebookIndex: makeIndex(),
      resolveNotePath: async () => ({ id: "note-1", expectedRevision: REVISION }),
      // Present but not an array: the projection widened the set for a reason,
      // so this must refuse rather than quietly authorize the scalar alone.
      noteMetadata: async (id: string) =>
        ({ id, title: "Roadmap", notebookId: "projects", notebookIds: "secret" }) as never,
      deleteNote,
    } as unknown as RpcHandlerRuntimeLike;

    const response = await handleRpcRequest(
      request("notes.delete", { path: "Personal/Projects/Roadmap" }),
      runtime,
      createCustomServicePolicy(["notes.search", "notes.get", "notes.delete"], evaluator),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "service_unavailable" } });
    expect(deleteNote).not.toHaveBeenCalled();
  });

  it("refuses when the enumeration was truncated at the notebook cap", async () => {
    const { evaluator } = makeDenySecretEvaluator();
    const deleteNote = vi.fn(async () => deleteResult("note-1"));
    const runtime = {
      search: async () => [{ title: "Roadmap" }],
      notebookIndex: makeIndex(),
      resolveNotePath: async () => ({ id: "note-1", expectedRevision: REVISION }),
      noteMetadata: async (id: string) =>
        ({
          id,
          title: "Roadmap",
          notebookId: "projects",
          notebookMembershipComplete: false,
        }) as never,
      deleteNote,
    } as unknown as RpcHandlerRuntimeLike;

    const response = await handleRpcRequest(
      request("notes.delete", { path: "Personal/Projects/Roadmap" }),
      runtime,
      createCustomServicePolicy(["notes.search", "notes.get", "notes.delete"], evaluator),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "service_unavailable" } });
    expect(deleteNote).not.toHaveBeenCalled();
  });
});
