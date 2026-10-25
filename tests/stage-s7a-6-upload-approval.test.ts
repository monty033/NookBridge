/**
 * S7a-6 — operator upload approval: coordinator, gate, method, CLI and docs.
 *
 * Offline and synthetic only. The upstream syncer is a spy; no test performs a
 * live sync. Rows 1-4, 6 and 7 are the 6a coverage; the 6b rows exercise the
 * injected operator and CLI seams, the MCP refusal, documentation, and the
 * unchanged sync boundaries.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createLiveRemoteSyncExecutor } from "../src/core/notesnook-live-remote-sync.js";
import {
  SyncCoordinator,
  type SyncLocalCommit,
  type SyncOperation,
  type SyncOrigin,
} from "../src/core/notesnook-sync-coordinator.js";
import { isExactFetchRequest } from "../src/core/readonly-sync-shape.js";
import { isNotesnookWriteContractError } from "../src/core/notesnook-write-contract.js";
import {
  formatNotesResult,
  parseNotesCommand,
  runNotesCommand,
  type NotesCommandRuntime,
  type UploadBlockingSummary,
} from "../src/operator/notes-cli.js";
import { createNotesCommandRuntimeFromOperatorSocket } from "../src/operator/notes-production-runtime.js";
import { createOperatorAuthorizer } from "../src/service/operator-authorizer.js";
import { createOperatorDiscoveryHandler } from "../src/service/operator-discovery-handler.js";
import { createOperatorUploadApprovalRuntime } from "../src/service/operator-upload-approval-runtime.js";
import type { OperatorPeer } from "../src/service/operator-server.js";
import { handleRpcRequest } from "../src/service/rpc-handler.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";

/** A store that round-trips through JSON, as the persistent store does. */
function jsonStore(initial?: unknown) {
  let saved: string | undefined = initial === undefined ? undefined : JSON.stringify(initial);
  return {
    load: (): unknown => (saved === undefined ? undefined : (JSON.parse(saved) as unknown)),
    save: (state: unknown): void => {
      saved = JSON.stringify(state);
    },
  };
}

function commit(operation: SyncOperation, id: string, origin?: SyncOrigin): SyncLocalCommit {
  return {
    operation,
    id,
    localCommitted: true,
    remoteSynced: false,
    pendingSync: true,
    ...(origin === undefined ? {} : { origin }),
  };
}

/** Coordinator wired to the real live executor over a spy `syncer.start`. */
function harness(store: ReturnType<typeof jsonStore> = jsonStore()) {
  const start = vi.fn(async (_options: unknown) => true);
  const executor = createLiveRemoteSyncExecutor({ syncer: { start } }, () => undefined);
  const build = () =>
    new SyncCoordinator({
      executor,
      stateStore: store,
      sleep: async () => undefined,
      now: () => 0,
      minIntervalMs: 0,
    });
  return { start, store, build, coordinator: build() };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isNotesnookWriteContractError(error)) return error.code;
  }
  throw new Error("expected categorical failure");
}

const UNAPPROVED = { status: "failed", errorCode: "unapproved_pending" };

const OPERATOR_PEER: OperatorPeer = {
  uid: 1000,
  gid: 1000,
  groups: ["nookbridge-clients", "nookbridge-operators"],
};
const READER_PEER: OperatorPeer = {
  uid: 1001,
  gid: 1001,
  groups: ["nookbridge-clients"],
};

const BLOCKING_SUMMARY = {
  total: 2,
  byOperation: { create: 1, append: 0, update: 1, delete: 0 },
  byOrigin: { operator: 1, unknown: 1 },
  highestSequence: 7,
} as const;

function cliRuntime(overrides: Partial<NotesCommandRuntime> = {}): NotesCommandRuntime {
  return {
    browse: async () => ({ kind: "empty" }),
    search: async () => ({ kind: "empty" }),
    get: async () => ({ kind: "missing" }),
    edit: async () => ({ kind: "invalid-input" }),
    create: async () => ({ kind: "invalid-input" }),
    operations: async () => ({ kind: "operations", handles: [], unresolvedHandles: [] }),
    undo: async () => ({ kind: "invalid-input" }),
    ...overrides,
  };
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const readRepositoryFile = (relativePath: string): string =>
  readFileSync(resolve(repositoryRoot, relativePath), "utf8");

describe("S7a-6a upload approval", () => {
  describe("row 1: approvePending marks operator and unknown markers through N", () => {
    it("1: approves every operator and unknown marker with sequence <= N and survives a reload", () => {
      const { coordinator, build } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator")); // 1
      coordinator.recordLocalCommit(commit("append", "note-b")); // 2 (unknown)
      coordinator.recordLocalCommit(commit("update", "note-c", "mcp")); // 3

      const result = coordinator.approvePending({ throughSequence: 3 });
      expect(result).toEqual({ approved: 2, throughSequence: 3 });

      const view = (c: SyncCoordinator) =>
        c.snapshot().pending.map((m) => [m.sequence, m.origin, m.approved] as const);
      const expected = [
        [1, "operator", true],
        [2, "unknown", true],
        [3, "mcp", undefined],
      ];
      expect(view(coordinator)).toEqual(expected);
      expect(view(build())).toEqual(expected);
      expect(build().blockingSummary().total).toBe(0);
    });

    it("1: the bound is inclusive and a repeat call approves nothing new", () => {
      const { coordinator } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator")); // 1
      coordinator.recordLocalCommit(commit("update", "note-b", "operator")); // 2

      expect(coordinator.approvePending({ throughSequence: 1 }).approved).toBe(1);
      expect(coordinator.snapshot().pending.map((m) => m.approved)).toEqual([true, undefined]);
      expect(coordinator.approvePending({ throughSequence: 1 }).approved).toBe(0);
    });

    it("1: rejects a bound that is not a positive safe integer", () => {
      const { coordinator } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator"));
      const invalid = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1", null];
      for (const throughSequence of invalid) {
        const request = { throughSequence } as unknown as { throughSequence: number };
        expect(codeOf(() => coordinator.approvePending(request))).toBe("invalid_input");
      }
      expect(codeOf(() => coordinator.approvePending(undefined as never))).toBe("invalid_input");
      expect(coordinator.snapshot().pending[0]?.approved).toBeUndefined();
    });

    it("1: a failed save leaves the queue unapproved", () => {
      let failing = false;
      const inner = jsonStore();
      const store = {
        load: inner.load,
        save: (state: unknown) => {
          if (failing) throw new Error("disk");
          inner.save(state);
        },
      };
      const { coordinator } = harness(store as ReturnType<typeof jsonStore>);
      coordinator.recordLocalCommit(commit("update", "note-a", "operator"));

      failing = true;
      expect(codeOf(() => coordinator.approvePending({ throughSequence: 1 }))).toBe("sync_failed");
      expect(coordinator.snapshot().pending[0]?.approved).toBeUndefined();
      expect(coordinator.blockingSummary().total).toBe(1);
    });

    it("1: blockingSummary counts only unapproved non-mcp markers, by operation and origin", () => {
      const { coordinator } = harness();
      expect(coordinator.blockingSummary()).toEqual({
        total: 0,
        byOperation: { create: 0, append: 0, update: 0, delete: 0 },
        byOrigin: { operator: 0, unknown: 0 },
        highestSequence: null,
      });

      coordinator.recordLocalCommit(commit("create", "note-a", "operator")); // 1
      coordinator.recordLocalCommit(commit("update", "note-b", "mcp")); // 2, never blocks
      coordinator.recordLocalCommit(commit("update", "note-c")); // 3 unknown
      coordinator.recordLocalCommit(commit("delete", "note-d", "operator")); // 4
      coordinator.approvePending({ throughSequence: 1 });

      expect(coordinator.blockingSummary()).toEqual({
        total: 2,
        byOperation: { create: 0, append: 0, update: 1, delete: 1 },
        byOrigin: { operator: 1, unknown: 1 },
        highestSequence: 4,
      });
    });

    it("1: blockingSummary carries no note id", () => {
      const { coordinator } = harness();
      coordinator.recordLocalCommit(commit("update", "sentinel-note-id", "operator"));
      expect(JSON.stringify(coordinator.blockingSummary())).not.toContain("sentinel-note-id");
    });
  });

  describe("row 2: markers above N stay unapproved", () => {
    it("2: the gate still refuses and upstream is never called", async () => {
      const { coordinator, start } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator")); // 1
      coordinator.recordLocalCommit(commit("update", "note-b", "operator")); // 2
      coordinator.recordLocalCommit(commit("append", "note-c")); // 3 written after the listing

      coordinator.approvePending({ throughSequence: 2 });

      expect(coordinator.snapshot().pending.map((m) => m.approved)).toEqual([
        true,
        true,
        undefined,
      ]);
      expect(coordinator.blockingSummary().highestSequence).toBe(3);
      expect(await coordinator.requestSync()).toMatchObject(UNAPPROVED);
      expect(start).not.toHaveBeenCalled();
      expect(coordinator.snapshot().pending).toHaveLength(3);
    });
  });

  describe("row 3: a new write to an approved note is unapproved again", () => {
    it("3: a replacing marker is unapproved, keeps its origin rank, and the gate refuses", async () => {
      const { coordinator, start } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator")); // 1
      coordinator.approvePending({ throughSequence: 1 });

      // Same operation and note replaces marker 1; an mcp request cannot lower it.
      coordinator.recordLocalCommit(commit("update", "note-a", "mcp"));

      const [marker, ...rest] = coordinator.snapshot().pending;
      expect(rest).toEqual([]);
      expect(marker).toMatchObject({ noteId: "note-a", sequence: 2, origin: "operator" });
      expect(marker?.approved).toBeUndefined();
      expect(await coordinator.requestSync()).toMatchObject(UNAPPROVED);
      expect(start).not.toHaveBeenCalled();
    });

    it("3: a new intent is unapproved, keeps its origin rank, and the gate refuses", async () => {
      const { coordinator, start } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator")); // 1
      coordinator.recordLocalCommit(commit("update", "note-b")); // 2 unknown
      coordinator.approvePending({ throughSequence: 2 });

      const intentA = coordinator.recordIntent({
        operation: "append",
        noteId: "note-a",
        origin: "mcp",
      });
      const intentB = coordinator.recordIntent({
        operation: "delete",
        noteId: "note-b",
        origin: "mcp",
      });

      expect(intentA).toMatchObject({ origin: "operator" });
      expect(intentB).toMatchObject({ origin: "unknown" });
      expect(intentA.approved).toBeUndefined();
      expect(intentB.approved).toBeUndefined();
      expect(coordinator.blockingSummary().total).toBe(2);
      expect(await coordinator.requestSync()).toMatchObject(UNAPPROVED);
      expect(start).not.toHaveBeenCalled();
    });

    it("3: the older approved marker stays approved; only the new write blocks", () => {
      const { coordinator } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator")); // 1
      coordinator.approvePending({ throughSequence: 1 });
      coordinator.recordIntent({ operation: "append", noteId: "note-a", origin: "operator" }); // 2

      expect(coordinator.snapshot().pending.map((m) => [m.sequence, m.approved])).toEqual([
        [1, true],
        [2, undefined],
      ]);
      expect(coordinator.blockingSummary()).toMatchObject({ total: 1, highestSequence: 2 });
    });

    it("3: resolving a create intent writes a fresh, unapproved marker", async () => {
      const { coordinator, start } = harness();
      const token = coordinator.recordCreateIntent({ origin: "operator" }); // 1
      coordinator.approvePending({ throughSequence: 1 });
      expect(coordinator.snapshot().pending[0]?.approved).toBe(true);

      coordinator.resolveCreateIntent(token, "note-new");

      const [marker, ...rest] = coordinator.snapshot().pending;
      expect(rest).toEqual([]);
      expect(marker).toMatchObject({ noteId: "note-new", origin: "operator" });
      expect(marker?.approved).toBeUndefined();
      expect(await coordinator.requestSync()).toMatchObject(UNAPPROVED);
      expect(start).not.toHaveBeenCalled();
    });
  });

  describe("row 4: loading is strict", () => {
    const base = { operation: "update", noteId: "note-a", sequence: 1, origin: "operator" };
    const stored = (marker: Record<string, unknown>) => ({ pending: [{ ...base, ...marker }] });

    it("4: a marker with no approved field loads as unapproved and the gate refuses", async () => {
      const { coordinator, start } = harness(jsonStore(stored({})));
      expect(coordinator.snapshot().pending[0]?.approved).toBeUndefined();
      expect(coordinator.blockingSummary().total).toBe(1);
      expect(await coordinator.requestSync()).toMatchObject(UNAPPROVED);
      expect(start).not.toHaveBeenCalled();
    });

    it("4: a marker with no origin and no approved field loads as unknown, unapproved", () => {
      const { coordinator } = harness(
        jsonStore({ pending: [{ operation: "update", noteId: "note-a", sequence: 1 }] }),
      );
      expect(coordinator.snapshot().pending[0]).toMatchObject({ origin: "unknown" });
      expect(coordinator.blockingSummary().byOrigin).toEqual({ operator: 0, unknown: 1 });
    });

    it("4: approved:false loads as unapproved; approved:true loads as approved", () => {
      expect(
        harness(jsonStore(stored({ approved: false }))).coordinator.blockingSummary().total,
      ).toBe(1);
      expect(
        harness(jsonStore(stored({ approved: true }))).coordinator.blockingSummary().total,
      ).toBe(0);
    });

    it("4: a non-boolean approved is invalid_input", () => {
      for (const approved of ["true", "yes", 1, 0, null, {}, []]) {
        // `harness` builds the coordinator, so the strict load throws here.
        expect(codeOf(() => harness(jsonStore(stored({ approved }))))).toBe("invalid_input");
      }
    });
  });

  describe("row 6: all-mcp and empty queues still run full", () => {
    it("6: an all-mcp queue runs full exactly once and is cleared", async () => {
      const { coordinator, start } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "mcp"));
      coordinator.recordLocalCommit(commit("append", "note-b", "mcp"));

      expect(await coordinator.requestSync()).toMatchObject({ status: "synced" });
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith({ type: "full" });
      expect(coordinator.snapshot().pending).toEqual([]);
    });

    it("6: an empty queue runs full exactly once", async () => {
      const { coordinator, start } = harness();

      expect(await coordinator.requestSync()).toMatchObject({ status: "synced" });
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith({ type: "full" });
    });

    it("5 (approved half): approved operator and unknown markers run full once", async () => {
      const { coordinator, start } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator"));
      coordinator.recordLocalCommit(commit("append", "note-b"));
      coordinator.recordLocalCommit(commit("update", "note-c", "mcp"));
      coordinator.approvePending({ throughSequence: 3 });

      expect(await coordinator.requestSync()).toMatchObject({ status: "synced" });
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith({ type: "full" });
      expect(coordinator.snapshot().pending).toEqual([]);
    });

    it("5 (refusal half): an unapproved operator or unknown marker refuses full", async () => {
      const { coordinator, start } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator"));
      coordinator.recordLocalCommit(commit("append", "note-b"));

      expect(await coordinator.requestSync()).toMatchObject(UNAPPROVED);
      expect(start).not.toHaveBeenCalled();
      expect(coordinator.snapshot().pending).toHaveLength(2);
    });
  });

  describe("row 7: approval removes nothing and calls nothing upstream", () => {
    it("7: every marker is still queued and start was never called", () => {
      const { coordinator, start, build } = harness();
      coordinator.recordLocalCommit(commit("create", "note-a", "operator"));
      coordinator.recordLocalCommit(commit("update", "note-b"));
      coordinator.recordLocalCommit(commit("delete", "note-c", "mcp"));
      const before = coordinator
        .snapshot()
        .pending.map((m) => [m.operation, m.noteId, m.sequence, m.origin]);

      coordinator.approvePending({ throughSequence: 3 });

      const after = (c: SyncCoordinator) =>
        c.snapshot().pending.map((m) => [m.operation, m.noteId, m.sequence, m.origin]);
      expect(after(coordinator)).toEqual(before);
      expect(after(build())).toEqual(before);
      expect(start).not.toHaveBeenCalled();
    });
  });

  describe("row 8: operator approval method authorization and peer typing", () => {
    it("8: operator role passes, reader role is denied, and the handler receives OperatorPeer", async () => {
      const receivedPeers: OperatorPeer[] = [];
      const handler = createOperatorDiscoveryHandler({
        browse: async () => ({ notes: [], next: null }),
        search: async () => ({ notes: [], next: null }),
        approveUpload: async (params, peer) => {
          receivedPeers.push(peer);
          if ("throughSequence" in params) expect(params).toEqual({ throughSequence: 7 });
          else expect(params).toEqual({});
          if (!("throughSequence" in params)) {
            return {
              kind: "approve-upload-preview",
              total: 2,
              byOperation: { create: 1, append: 0, update: 1, delete: 0 },
              byOrigin: { operator: 1, unknown: 1 },
              highestSequence: 7,
            };
          }
          return { kind: "approve-upload", approved: 2, throughSequence: 7 };
        },
      });
      const request = {
        id: "approval-1",
        method: "notes.approve-upload",
        params: { throughSequence: 7 },
      } as RpcRequest;

      const response = await handler(request, OPERATOR_PEER);
      expect(response).toMatchObject({
        id: "approval-1",
        ok: true,
        result: { kind: "approve-upload", approved: 2, throughSequence: 7 },
      });
      expect(receivedPeers).toEqual([OPERATOR_PEER]);

      const preview = await handler(
        { id: "approval-preview", method: "notes.approve-upload", params: {} } as RpcRequest,
        OPERATOR_PEER,
      );
      expect(preview).toMatchObject({
        id: "approval-preview",
        ok: true,
        result: { kind: "approve-upload-preview", total: 2, highestSequence: 7 },
      });
      expect(receivedPeers).toEqual([OPERATOR_PEER, OPERATOR_PEER]);

      const authorizer = createOperatorAuthorizer({ resolveHandle: () => undefined });
      expect(
        await authorizer("notes.approve-upload", OPERATOR_PEER, request),
      ).toEqual({ allowed: true, method: "notes.approve-upload" });
      expect(
        await authorizer("notes.approve-upload", READER_PEER, request),
      ).toEqual({ allowed: false, reason: "permission_denied" });
      expect(
        await authorizer(
          "notes.approve-upload",
          READER_PEER,
          { ...request, params: {} } as RpcRequest,
        ),
      ).toEqual({ allowed: false, reason: "permission_denied" });
    });
  });

  describe("row 9: approval is not an MCP method", () => {
    it("9: the MCP RPC handler refuses notes.approve-upload with invalid_request", async () => {
      const request = {
        id: "mcp-approval",
        method: "notes.approve-upload",
        params: { throughSequence: 1 },
      } as RpcRequest;
      const response = await handleRpcRequest(
        request,
        { requestSync: async () => ({ status: "synced", pendingSync: false, attempts: 1 }) } as never,
        createReadWriteNoDeleteServicePolicy(),
      );

      expect(response).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    });
  });

  describe("row 10: approval CLI terminal and typed-confirmation gates", () => {
    it("10: rejects non-terminal stdin and every extra argument", async () => {
      const factory = vi.fn();
      expect(parseNotesCommand(["approve-upload", "--yes"], {}).kind).toBe("error");
      expect(parseNotesCommand(["approve-upload", "--all"], {}).kind).toBe("error");
      expect(parseNotesCommand(["approve-upload", "--through", "7"], {}).kind).toBe("error");
      expect(parseNotesCommand(["approve-upload", "note-id"], {}).kind).toBe("error");

      const result = await runNotesCommand({
        argv: ["approve-upload"],
        env: {},
        createRuntime: factory,
        interactive: { tty: false, confirmUpload: async () => "7" },
      });
      expect(result).toEqual({ kind: "invalid-input" });
      expect(factory).not.toHaveBeenCalled();
    });

    it("10: confirms only when the typed sequence exactly matches the listing", async () => {
      const approveUpload = vi.fn(async ({ throughSequence }: { throughSequence: number }) => ({
        kind: "approved" as const,
        approved: 2,
        throughSequence,
      }));
      const factory = vi.fn().mockResolvedValue(
        cliRuntime({
          blockingSummary: async () => BLOCKING_SUMMARY,
          approveUpload,
        }),
      );
      const wrong = await runNotesCommand({
        argv: ["approve-upload"],
        env: {},
        createRuntime: factory,
        interactive: { tty: true, confirmUpload: async () => "6" },
      });
      expect(wrong).toEqual({ kind: "invalid-input" });
      expect(approveUpload).not.toHaveBeenCalled();

      const confirmUpload = vi.fn(async (summary: UploadBlockingSummary) => {
        expect(summary).toEqual(BLOCKING_SUMMARY);
        return "7";
      });
      const right = await runNotesCommand({
        argv: ["approve-upload"],
        env: {},
        createRuntime: factory,
        interactive: { tty: true, confirmUpload },
      });
      expect(right).toEqual({ kind: "approved", approved: 2, throughSequence: 7 });
      expect(approveUpload).toHaveBeenCalledWith({ throughSequence: 7 });
    });

    it("10: the production socket runtime previews first and does not prompt an empty queue", async () => {
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const confirmUpload = vi.fn(async () => "7");
      const runtime = createNotesCommandRuntimeFromOperatorSocket({
        request: async (method, params) => {
          calls.push({ method, params });
          return {
            ok: true,
            result: {
              kind: "approve-upload-preview",
              total: 0,
              byOperation: { create: 0, append: 0, update: 0, delete: 0 },
              byOrigin: { operator: 0, unknown: 0 },
              highestSequence: null,
            },
          };
        },
      });

      const result = await runNotesCommand({
        argv: ["approve-upload"],
        env: {},
        createRuntime: async () => runtime,
        interactive: { tty: true, confirmUpload },
      });

      expect(result).toEqual({ kind: "nothing-to-approve" });
      expect(confirmUpload).not.toHaveBeenCalled();
      expect(calls).toEqual([{ method: "notes.approve-upload", params: {} }]);
    });
  });

  describe("row 11: approval output is metadata-only", () => {
    it("11: a sentinel id and title do not cross the listing, confirmation, result, or audit-shaped record", async () => {
      const sentinelId = "sentinel-note-id";
      const sentinelTitle = "sentinel note title";
      const { coordinator } = harness();
      for (let sequence = 1; sequence < 7; sequence += 1) {
        coordinator.recordLocalCommit(commit("update", `mcp-note-${sequence}`, "mcp"));
      }
      coordinator.recordLocalCommit(commit("update", sentinelId, "operator"));
      const approval = createOperatorUploadApprovalRuntime(coordinator);
      const confirmation = vi.fn(async (summary: UploadBlockingSummary) => {
        expect(JSON.stringify(summary)).not.toContain(sentinelId);
        expect(JSON.stringify(summary)).not.toContain(sentinelTitle);
        return "7";
      });
      const runtime = createNotesCommandRuntimeFromOperatorSocket({
        request: async (_method, params) => ({
          ok: true,
          result: await approval.approveUpload(params as never, OPERATOR_PEER),
        }),
      });
      const result = await runNotesCommand({
        argv: ["approve-upload"],
        env: {},
        createRuntime: async () => runtime,
        interactive: { tty: true, confirmUpload: confirmation },
      });
      const output = formatNotesResult(result);
      const auditRecord = JSON.stringify({
        method: "notes.approve-upload",
        outcome: result.kind,
        approved: result.kind === "approved" ? result.approved : undefined,
        throughSequence: result.kind === "approved" ? result.throughSequence : undefined,
      });

      expect(output).not.toContain(sentinelId);
      expect(output).not.toContain(sentinelTitle);
      expect(auditRecord).not.toContain(sentinelId);
      expect(auditRecord).not.toContain(sentinelTitle);
    });
  });

  describe("row 12: fake-backed end-to-end approval", () => {
    it("12: an operator marker blocks MCP sync, approval releases the next MCP sync", async () => {
      const { coordinator, start } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator"));
      const syncRequest = {
        id: "sync-1",
        method: "notes.sync",
        params: {},
      } as RpcRequest;
      const serviceRuntime = {
        requestSync: coordinator.requestSync.bind(coordinator),
      } as never;

      const refused = await handleRpcRequest(
        syncRequest,
        serviceRuntime,
        createReadWriteNoDeleteServicePolicy(),
      );
      expect(refused).toMatchObject({ ok: false, error: { code: "unapproved_pending" } });
      expect(start).not.toHaveBeenCalled();

      const approval = createOperatorUploadApprovalRuntime(coordinator);
      await approval.approveUpload({ throughSequence: 1 }, OPERATOR_PEER);

      const released = await handleRpcRequest(
        { ...syncRequest, id: "sync-2" },
        serviceRuntime,
        createReadWriteNoDeleteServicePolicy(),
      );
      expect(released).toMatchObject({ ok: true, result: { kind: "sync", status: "synced" } });
      expect(start).toHaveBeenCalledTimes(1);
    });

    it("12: the production socket runtime carries preview and approval over one operator method", async () => {
      const { coordinator } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator"));
      const approval = createOperatorUploadApprovalRuntime(coordinator);
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const runtime = createNotesCommandRuntimeFromOperatorSocket({
        request: async (method, params) => {
          calls.push({ method, params });
          return {
            ok: true,
            result: await approval.approveUpload(params as never, OPERATOR_PEER),
          };
        },
      });
      const result = await runNotesCommand({
        argv: ["approve-upload"],
        env: {},
        createRuntime: async () => runtime,
        interactive: { tty: true, confirmUpload: async () => "1" },
      });

      expect(result).toEqual({ kind: "approved", approved: 1, throughSequence: 1 });
      expect(calls).toEqual([
        { method: "notes.approve-upload", params: {} },
        { method: "notes.approve-upload", params: { throughSequence: 1 } },
      ]);
    });
  });

  describe("row 13: approval documentation and resolved decision", () => {
    it("13: the CLI, MCP, privacy and §13.22 sentences are present verbatim", () => {
      const cli = readRepositoryFile("docs/reference/cli.md");
      const mcp = readRepositoryFile("docs/reference/mcp-tools.md");
      const privacy = readRepositoryFile("docs/security-and-privacy.md");
      const plan = readRepositoryFile("docs/implementation-plan-v1.5.md");
      const docsTests = readRepositoryFile("tests/docs.test.ts");

      expect(cli).toContain(
        "`nookctl notes approve-upload` accepts no arguments. It refuses when stdin or\nstdout is not a terminal, or when the typed confirmation does not exactly match\nthe highest sequence shown in its metadata-only listing.",
      );
      expect(cli).toContain(
        "`nookctl notes approve-upload` first requests a read-only preview over the\noperator socket; an empty preview prints `nothing to approve` and never prompts\nor submits an approval.",
      );
      expect(mcp).toContain(
        "Only the interactive operator CLI can approve those markers; MCP has no approval method.",
      );
      expect(privacy).toContain(
        "The listing,\nconfirmation, result, and audit record contain no note identifiers, titles, or\npaths. MCP has no approval method.",
      );
      expect(plan).toContain("### Decision 5 — operator upload approval");
      expect(plan).not.toContain("### Pending decision");
      expect(plan).toContain("The former\nstatement that operator-origin writes had **no approval path** is therefore\nresolved");
      expect(docsTests).toContain('not.toContain("uploadIntent")');
      expect(docsTests).toContain('not.toMatch(/notes\\.approve(?!-upload)/)');
      expect(docsTests).not.toContain('"--approve-upload",\n      "uploadIntent"');
    });
  });

  describe("row 14: the explicit full call and fetch-only boundary remain closed", () => {
    it("14: full remains on the explicit executor and the read-only shape accepts only fetch", () => {
      const executorSource = readRepositoryFile("src/core/notesnook-live-remote-sync.ts");
      expect(executorSource).toContain('boundStart({ type: "full" })');
      expect(isExactFetchRequest({ type: "fetch" })).toBe(true);
      expect(isExactFetchRequest({ type: "full" })).toBe(false);
      expect(isExactFetchRequest({ type: "fetch", force: true })).toBe(false);
      expect(isExactFetchRequest({ type: "fetch", send: true })).toBe(false);
    });
  });
});
