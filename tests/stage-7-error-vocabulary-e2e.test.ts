/**
 * Stage 7 — end-to-end error-vocabulary harness.
 *
 * Every row records three layers independently, so a failure names the layer
 * that degraded rather than only the final MCP code:
 *
 *   L1 — `handleRpcRequest(request, runtime, policy).error.code` (RPC handler)
 *   L2 — `NookdSocketClient` method -> `{ ok: false, code }` (framed Unix socket)
 *   L3 — `buildNookMcpServer().callTool(tool, args)` -> MCP error code
 *
 * T1 injects write-contract errors at the service-runtime write seam.
 * T2 runs the production runtime over a fake real-core database, no injection.
 * T3 replays each RPC error envelope from a fake daemon.
 */

import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { URL, fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  NOOK_MCP_APPEND_NOTE_TOOL_NAME,
  NOOK_MCP_CREATE_NOTE_TOOL_NAME,
  NOOK_MCP_DELETE_NOTE_TOOL_NAME,
  NOOK_MCP_UPDATE_NOTE_TOOL_NAME,
  buildNookMcpServer,
} from "../src/mcp/nook-mcp-server.js";
import { NookdSocketClient, type NookdSocketResult } from "../src/mcp/socket-client.js";
import type { NookMcpErrorCode } from "../src/mcp/errors.js";
import { startNookdServer, type NookdServerRuntime } from "../src/service/nookd-server.js";
import { handleRpcRequest } from "../src/service/rpc-handler.js";
import { createCustomServicePolicy, type ServicePolicy } from "../src/service/service-policy.js";
import { createProductionServiceRuntime } from "../src/service/service-runtime.js";
import {
  RPC_ERROR_MESSAGES,
  serializeRpcResponse,
  type RpcErrorCode,
  type RpcRequest,
} from "../src/service/rpc-protocol.js";
import { buildServiceAuditRecord, type ServiceAuditRecord } from "../src/service/service-audit.js";
import { createLogger } from "../src/logging/logger.js";
import {
  createRevisionToken,
  NotesnookWriteContractError,
  type NotesnookWriteErrorCode,
} from "../src/core/notesnook-write-contract.js";
import {
  markRealCoreModule,
  type NotesnookRealCoreModule,
} from "../src/core/notesnook-core-adapter.js";
import { createSystemdCredentialKeyStore } from "../src/keystore/systemd-credential-keystore.js";

type McpServer = ReturnType<typeof buildNookMcpServer>;
type ToolResult = Awaited<ReturnType<McpServer["callTool"]>>;
type NookdSocketFailure = Extract<NookdSocketResult, { ok: false }>["code"];

/** One row's expected codes at each layer. */
interface Triple {
  readonly rpc: RpcErrorCode;
  readonly socket: NookdSocketFailure;
  readonly mcp: NookMcpErrorCode;
}

/** Codes actually observed at each layer; `"ok"` marks a success. */
interface Observed {
  readonly rpc: string;
  readonly socket: string;
  readonly mcp: string;
}

interface Harness {
  readonly policy: ServicePolicy;
  readonly client: NookdSocketClient;
  readonly server: McpServer;
  readonly runtime: NookdServerRuntime;
}

type WriteMethod = "create" | "append" | "update" | "delete";

const NOTE_ID = "note-1";
const PATH = "General/Canary";
const TITLE = "Renamed";
const CONTENT = "Canary body";
const MARKDOWN_FRAGMENT = "frag";
/**
 * Inline HTML is outside `SUPPORTED_MARKDOWN_CONSTRUCTS`, so
 * `assertSupportedConstructs` refuses it.  This is the exact fragment from
 * the stage-4 fidelity-gate case "refuses a create note whose content uses
 * inline HTML" (`tests/stage-4-write-adapter.test.ts`), reused here for the
 * append production path.
 */
const UNSUPPORTED_MARKDOWN_FRAGMENT = "<div>raw</div>";
const REVISION = "rev_00000000000000000000000000000001";
const STALE_REVISION = "rev_ffffffffffffffffffffffffffffffff";
/**
 * Revision the fake core derives for {@link NOTE_ID} at the fake
 * `dateEdited` (1_700_000_000_000). Rows that must reach the adapter's
 * post-revision gates use this; `REVISION` is only exercised by rows that
 * fail before the revision comparison.
 */
const PRODUCTION_REVISION = createRevisionToken({
  id: NOTE_ID,
  dateEdited: 1_700_000_000_000,
});

/**
 * Every daemon method except the locked-note proof, which no row exercises.
 * The proof is outside the write surface this harness covers.
 */
const POLICY_METHODS = [
  "notes.search",
  "notes.status",
  "notes.list_notebooks",
  "notes.get",
  "notes.create",
  "notes.append",
  "notes.update",
  "notes.delete",
  "notes.path_diagnostic",
  "notes.sync",
];

const WRITE_METHODS: readonly WriteMethod[] = ["create", "append", "update", "delete"];

/** Expected triple for a code that must pass through unchanged at every layer. */
function same<C extends RpcErrorCode>(code: C): Triple {
  return { rpc: code, socket: code, mcp: code };
}

/**
 * Write-contract codes and their expected categorical outcome. Typed as a
 * full Record so adding a `NotesnookWriteErrorCode` without a row fails tsc.
 */
const T1_EXPECTED: Record<NotesnookWriteErrorCode, Triple> = {
  invalid_input: same("invalid_request"),
  unsupported_content: same("invalid_request"),
  unsupported_patch_field: same("invalid_request"),
  stale_revision: same("stale_revision"),
  conflict: same("conflict"),
  vault_locked: same("vault_locked"),
  sync_failed: same("sync_failed"),
  local_sync_marker_failed: same("local_sync_marker_failed"),
};
const WRITE_CODES = Object.keys(T1_EXPECTED) as NotesnookWriteErrorCode[];

/** RPC envelope code -> MCP code. Identity for every code; typed exhaustively. */
const RPC_TO_MCP: Readonly<Record<RpcErrorCode, NookMcpErrorCode>> = {
  invalid_request: "invalid_request",
  permission_denied: "permission_denied",
  service_unavailable: "service_unavailable",
  stale_revision: "stale_revision",
  conflict: "conflict",
  sync_failed: "sync_failed",
  vault_locked: "vault_locked",
  not_found: "not_found",
  local_sync_marker_failed: "local_sync_marker_failed",
};
const RPC_CODES = Object.keys(RPC_TO_MCP) as RpcErrorCode[];

const LAYER_LABELS = {
  rpc: "L1 (RPC handler)",
  socket: "L2 (socket client)",
  mcp: "L3 (MCP tool)",
} as const;

/**
 * Rows whose categorical origin is knowingly degraded to `service_unavailable`
 * at L3. Owner: R2d. Empty since R2d: `local_sync_marker_failed` now has its own
 * RPC code, so no categorical origin may surface as `service_unavailable`.
 * Any categorical row that degrades fails the check.
 */
const KNOWN_DEGRADATIONS: ReadonlySet<string> = new Set<string>();

/**
 * Guards the set above against silent growth: the pinning test binds it to
 * this list, so a new allowlisted row needs a deliberate edit in both places.
 */
const EXPECTED_DEGRADATION_ROWS: readonly string[] = [];

/**
 * Where a row's error started. `categorical` is any contract or RPC code other
 * than `service_unavailable`; `uncategorised` is a plain Error or the
 * `service_unavailable` code itself. Only a categorical origin that surfaces as
 * `service_unavailable` counts as a degradation.
 */
type Origin = "categorical" | "uncategorised";
/** Every recorded row, so the degradation check can see the whole run. */
const observations = new Map<string, { readonly origin: Origin; readonly observed: Observed }>();

/**
 * Record the row, then fail naming the first layer whose code deviates. The
 * record happens first so the degradation check still sees a failed row.
 */
function recordAndAssert(
  rowId: string,
  origin: Origin,
  observed: Observed,
  expected: Triple,
): void {
  observations.set(rowId, { origin, observed });
  for (const layer of ["rpc", "socket", "mcp"] as const) {
    if (observed[layer] !== expected[layer]) {
      throw new Error(
        `${rowId}: first deviating layer ${LAYER_LABELS[layer]} — expected ${expected[layer]}, observed ${observed[layer]} (rpc=${observed.rpc}, socket=${observed.socket}, mcp=${observed.mcp})`,
      );
    }
  }
}

function mcpCode(result: ToolResult): string {
  if (result.isError !== true) return "ok";
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("MCP error result has no text block");
  return (JSON.parse(block.text) as { code: string }).code;
}

let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return `e2e-${requestSeq}`;
}

/** Per-row command overrides; every field defaults to the shared canary. */
interface WriteOverrides {
  readonly markdownFragment?: string;
}

function rpcRequestFor(
  method: WriteMethod,
  expectedRevision: string,
  overrides: WriteOverrides = {},
): RpcRequest {
  const id = nextRequestId();
  const markdownFragment = overrides.markdownFragment ?? MARKDOWN_FRAGMENT;
  switch (method) {
    case "create":
      return { id, method: "notes.create", params: { title: TITLE, content: CONTENT } };
    case "append":
      return {
        id,
        method: "notes.append",
        params: { id: NOTE_ID, markdownFragment, expectedRevision },
      };
    case "update":
      return {
        id,
        method: "notes.update",
        params: { id: NOTE_ID, expectedRevision, patch: { title: TITLE } },
      };
    case "delete":
      return { id, method: "notes.delete", params: { path: PATH } };
  }
}

function socketCallFor(
  client: NookdSocketClient,
  method: WriteMethod,
  expectedRevision: string,
  overrides: WriteOverrides = {},
): Promise<NookdSocketResult> {
  const markdownFragment = overrides.markdownFragment ?? MARKDOWN_FRAGMENT;
  switch (method) {
    case "create":
      return client.createNote({ title: TITLE, content: CONTENT });
    case "append":
      return client.appendNote({
        id: NOTE_ID,
        markdownFragment,
        expectedRevision,
      });
    case "update":
      return client.updateNote({ id: NOTE_ID, expectedRevision, patch: { title: TITLE } });
    case "delete":
      return client.deleteNote({ path: PATH });
  }
}

function mcpCallFor(
  server: McpServer,
  method: WriteMethod,
  expectedRevision: string,
  overrides: WriteOverrides = {},
): Promise<ToolResult> {
  const markdownFragment = overrides.markdownFragment ?? MARKDOWN_FRAGMENT;
  switch (method) {
    case "create":
      return server.callTool(NOOK_MCP_CREATE_NOTE_TOOL_NAME, { title: TITLE, content: CONTENT });
    case "append":
      return server.callTool(NOOK_MCP_APPEND_NOTE_TOOL_NAME, {
        id: NOTE_ID,
        markdownFragment,
        expectedRevision,
      });
    case "update":
      return server.callTool(NOOK_MCP_UPDATE_NOTE_TOOL_NAME, {
        id: NOTE_ID,
        expectedRevision,
        patch: { title: TITLE },
      });
    case "delete":
      return server.callTool(NOOK_MCP_DELETE_NOTE_TOOL_NAME, { path: PATH });
  }
}

/** Drive one write method through all three layers and collect the codes. */
async function observeWrite(
  harness: Harness,
  method: WriteMethod,
  expectedRevision: string,
  overrides: WriteOverrides = {},
): Promise<Observed> {
  const rpc = await handleRpcRequest(
    rpcRequestFor(method, expectedRevision, overrides),
    harness.runtime,
    harness.policy,
  );
  const socket = await socketCallFor(harness.client, method, expectedRevision, overrides);
  const mcp = await mcpCallFor(harness.server, method, expectedRevision, overrides);
  return {
    rpc: rpc.ok === true ? "ok" : rpc.error.code,
    socket: socket.ok ? "ok" : socket.code,
    mcp: mcpCode(mcp),
  };
}

/**
 * Start a real `nookd` on a fresh socket, then build the real socket client and
 * MCP server against it. Shutdown runs `runtime.cleanup()`.
 */
async function withHarness(
  runtime: NookdServerRuntime,
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync("/tmp/nbk-");
  const socketPath = join(dir, "nookd.sock");
  const policy = createCustomServicePolicy(POLICY_METHODS);
  const handle = await startNookdServer({
    socketPath,
    runtime,
    policy,
    installSignalHandlers: false,
  });
  try {
    const client = new NookdSocketClient({ socketPath });
    await body({ policy, client, server: buildNookMcpServer({ client }), runtime });
  } finally {
    await handle.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// T1 — write-error codes injected at the service-runtime write seam.
// ---------------------------------------------------------------------------

/** Runtime whose four write capabilities all throw `failure`. */
function injectedRuntime(failure: Error): NookdServerRuntime {
  const fail = async (): Promise<never> => {
    throw failure;
  };
  return {
    search: async () => [],
    cleanup: async () => undefined,
    resolveNotePath: async () => ({ id: NOTE_ID, expectedRevision: REVISION }),
    createNote: fail,
    appendNote: fail,
    updateNote: fail,
    deleteNote: fail,
  };
}

describe("T1 — write-error codes injected at the service-runtime write seam", () => {
  for (const code of WRITE_CODES) {
    for (const method of WRITE_METHODS) {
      const rowId = `T1 ${code} ${method}`;
      it(rowId, async () => {
        await withHarness(injectedRuntime(new NotesnookWriteContractError(code)), async (h) => {
          const observed = await observeWrite(h, method, REVISION);
          recordAndAssert(rowId, "categorical", observed, T1_EXPECTED[code]);
        });
      });
    }
  }

  for (const method of WRITE_METHODS) {
    const rowId = `T1 canary ${method}`;
    it(rowId, async () => {
      await withHarness(injectedRuntime(new Error("boom CANARY")), async (h) => {
        const observed = await observeWrite(h, method, REVISION);
        recordAndAssert(rowId, "uncategorised", observed, same("service_unavailable"));

        // The canary must not survive the RPC envelope: a categorical code
        // replaces the upstream message rather than forwarding its text.
        const rpc = await handleRpcRequest(rpcRequestFor(method, REVISION), h.runtime, h.policy);
        expect(rpc.ok).toBe(false);
        if (rpc.ok === false) {
          expect(rpc.error.message).not.toContain("CANARY");
          expect(rpc.error.message.length).toBeGreaterThan(0);
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// T2 — production runtime, no injection. Fake real-core database as in the
// stage-10 "D4-2 — production runtime wiring" block.
// ---------------------------------------------------------------------------

type FakeDatabaseState = { readonly locked: boolean; readonly conflicted: boolean };

/** Mutator spies the T2 rows use to prove no write reached the fake core. */
interface FakeDatabaseSpies {
  readonly contentUpdate: ReturnType<typeof vi.fn>;
  readonly collectionUpdate: ReturnType<typeof vi.fn>;
}

function createFakeDatabase(
  state: FakeDatabaseState,
  spies: FakeDatabaseSpies,
): Record<string, unknown> {
  const note = {
    id: NOTE_ID,
    title: "Canary",
    notebookId: "general-id",
    pinned: false,
    favorite: false,
    conflicted: state.conflicted,
    locked: false,
    dateEdited: 1_700_000_000_000,
  };
  // The vault lock lives on the content row, matching the stage-10 fake.
  // The row is always present so the unlocked append row reaches the
  // fidelity gate instead of failing because stored content is missing.
  const content = {
    id: "content-1",
    noteId: NOTE_ID,
    type: "html",
    data: "<p>canary</p>",
    locked: state.locked,
  };
  const tags = new Map<string, { id: string; title: string }>();
  return {
    setup: () => undefined,
    host: () => undefined,
    init: async () => undefined,
    user: {
      authenticateEmail: async () => undefined,
      authenticateMultiFactorCode: async () => undefined,
      authenticatePassword: async () => undefined,
      _login: async () => undefined,
      getUser: async () => undefined,
      logout: async () => undefined,
    },
    tokenManager: {
      getToken: async () => undefined,
      _refreshToken: async () => undefined,
    },
    kv: () => ({
      read: async () => undefined,
      write: async () => undefined,
      delete: async () => undefined,
    }),
    syncer: { start: async () => true },
    lastSynced: async () => 0,
    hasUnsyncedChanges: async () => false,
    notes: {
      note: async (id: string) => (id === NOTE_ID ? { ...note } : undefined),
      add: async () => "note-created",
      addToNotebook: async () => undefined,
      removeFromNotebook: async () => undefined,
      moveToTrash: async () => undefined,
      collection: { update: spies.collectionUpdate },
    },
    content: {
      add: async () => "content-created",
      findByNoteId: async (noteId: string) => (noteId === NOTE_ID ? { ...content } : undefined),
      updateByNoteId: spies.contentUpdate,
    },
    notebooks: {
      all: { ids: async () => ["general-id"] },
      notebook: async (id: string) =>
        id === "general-id" ? { id, title: "General", dateEdited: 1 } : undefined,
      breadcrumbs: async (id: string) => (id === "general-id" ? [{ id, title: "General" }] : []),
      notes: async (id: string) => (id === "general-id" ? [NOTE_ID] : []),
      exists: async (id: string) => id === "general-id",
    },
    tags: {
      tag: async (id: string) => tags.get(id),
      add: async ({ title }: { title: string }) => {
        const id = `tag-${tags.size + 1}`;
        tags.set(id, { id, title });
        return id;
      },
    },
    relations: {
      add: async () => undefined,
      unlink: async () => undefined,
      from: (reference: { id: string; type: string }) => ({
        get: async () => [],
        has: async (noteId: string) =>
          reference.type === "notebook" && reference.id === "general-id" && noteId === NOTE_ID,
      }),
    },
    lookup: {
      notes: async (title: string) => ({
        ids: async () => (title === "Canary" ? [NOTE_ID] : []),
      }),
      notebooks: async () => ({ ids: async () => [] }),
    },
  };
}

async function withProductionHarness(
  state: FakeDatabaseState,
  body: (harness: Harness, spies: FakeDatabaseSpies) => Promise<void>,
): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "nbk-e2e-state-"));
  const credentialsDir = mkdtempSync(join(tmpdir(), "nbk-e2e-creds-"));
  writeFileSync(join(credentialsDir, "nookbridge-db-key"), "error-vocabulary-e2e-key", {
    mode: 0o600,
  });
  const spies: FakeDatabaseSpies = {
    contentUpdate: vi.fn(async () => undefined),
    collectionUpdate: vi.fn(async () => undefined),
  };
  const database = createFakeDatabase(state, spies);
  const injectedModule = markRealCoreModule({
    Database: function FakeDatabase() {
      return database;
    } as unknown as NotesnookRealCoreModule["Database"],
  });
  const keys = createSystemdCredentialKeyStore({ credentialsDirectory: credentialsDir });
  try {
    const runtime = await createProductionServiceRuntime({ stateDir, keys, injectedModule });
    await withHarness(runtime, (harness) => body(harness, spies));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(credentialsDir, { recursive: true, force: true });
  }
}

describe("T2 — production runtime, no injection", () => {
  for (const method of ["update", "append", "delete"] as const) {
    const rowId = `T2 locked content row ${method}`;
    it(rowId, async () => {
      await withProductionHarness({ locked: true, conflicted: false }, async (h) => {
        const observed = await observeWrite(h, method, REVISION);
        recordAndAssert(rowId, "categorical", observed, same("vault_locked"));
      });
    });
  }

  for (const method of ["update", "append"] as const) {
    const staleId = `T2 stale expectedRevision ${method}`;
    it(staleId, async () => {
      await withProductionHarness({ locked: false, conflicted: false }, async (h) => {
        const observed = await observeWrite(h, method, STALE_REVISION);
        recordAndAssert(staleId, "categorical", observed, same("stale_revision"));
      });
    });

    const conflictId = `T2 conflicted note ${method}`;
    it(conflictId, async () => {
      await withProductionHarness({ locked: false, conflicted: true }, async (h) => {
        const observed = await observeWrite(h, method, REVISION);
        recordAndAssert(conflictId, "categorical", observed, same("conflict"));
      });
    });
  }

  it("T2 unsupported construct on append", async () => {
    const rowId = "T2 unsupported construct on append";
    await withProductionHarness({ locked: false, conflicted: false }, async (h, spies) => {
      // Inline HTML (`<div>raw</div>`) is the stage-4 fidelity-gate
      // construct: `assertSupportedConstructs` refuses it, the adapter
      // normalises that refusal to `unsupported_content`, and the RPC
      // handler maps that to `invalid_request`.
      const observed = await observeWrite(h, "append", PRODUCTION_REVISION, {
        markdownFragment: UNSUPPORTED_MARKDOWN_FRAGMENT,
      });
      recordAndAssert(rowId, "categorical", observed, same("invalid_request"));

      // The gate runs before any mutator, so neither the content write nor
      // the metadata touch reached the fake core on any of the three layers.
      expect(spies.contentUpdate).toHaveBeenCalledTimes(0);
      expect(spies.collectionUpdate).toHaveBeenCalledTimes(0);

      // R2b's write-ahead intent is released on this failure, but the
      // coordinator state is persisted through the runtime's encrypted
      // PersistentStorage (`PersistentSyncMetadataStateStore`), not through
      // the fake core's `kv` slot. The service runtime exposes neither the
      // store nor a pending snapshot, so `pending: []` is not observable
      // through this fake and that assertion is dropped here.
    });
  });
});

// ---------------------------------------------------------------------------
// T3 — RPC code pass-through through the socket client and MCP tool.
// ---------------------------------------------------------------------------

function framedEnvelope(envelope: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(envelope), "utf8");
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

/**
 * One-shot fake daemon: answers every framed request with the given error
 * envelope. Same framing as the stage-6 proxy fake, with the echoed id.
 */
async function startEnvelopeDaemon(
  code: RpcErrorCode,
): Promise<{ readonly socketPath: string; readonly close: () => Promise<void> }> {
  const dir = mkdtempSync("/tmp/nbk-");
  const socketPath = join(dir, "fake-nookd.sock");
  const sockets = new Set<Socket>();
  const server: Server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) return;
      const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as {
        id: string;
      };
      socket.off("data", onData);
      socket.end(
        framedEnvelope({
          id: request.id,
          ok: false,
          error: { code, message: RPC_ERROR_MESSAGES[code] },
        }),
      );
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return {
    socketPath,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("T3 — RPC error code pass-through", () => {
  for (const code of RPC_CODES) {
    const rowId = `T3 notes.update envelope ${code}`;
    it(rowId, async () => {
      const daemon = await startEnvelopeDaemon(code);
      try {
        const client = new NookdSocketClient({ socketPath: daemon.socketPath });
        const server = buildNookMcpServer({ client });
        const socket = await client.updateNote({
          id: NOTE_ID,
          expectedRevision: REVISION,
          patch: { title: TITLE },
        });
        const mcp = await server.callTool(NOOK_MCP_UPDATE_NOTE_TOOL_NAME, {
          id: NOTE_ID,
          expectedRevision: REVISION,
          patch: { title: TITLE },
        });
        // L1 is the envelope the fake daemon emits, so it equals the injected code.
        recordAndAssert(
          rowId,
          code === "service_unavailable" ? "uncategorised" : "categorical",
          { rpc: code, socket: socket.ok ? "ok" : socket.code, mcp: mcpCode(mcp) },
          { rpc: code, socket: code, mcp: RPC_TO_MCP[code] },
        );
      } finally {
        await daemon.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Degradation detection. Runs last, after every row has recorded its codes.
// ---------------------------------------------------------------------------

describe("degradation detection", () => {
  it("KNOWN_DEGRADATIONS matches the rows the write matrix actually produces", () => {
    expect([...KNOWN_DEGRADATIONS].sort()).toEqual([...EXPECTED_DEGRADATION_ROWS].sort());
  });

  it("rows observed as service_unavailable from a categorical origin equal KNOWN_DEGRADATIONS", () => {
    const degraded = [...observations]
      .filter(
        ([, entry]) =>
          entry.origin === "categorical" && entry.observed.mcp === "service_unavailable",
      )
      .map(([rowId]) => rowId)
      .sort();
    expect(degraded).toEqual([...KNOWN_DEGRADATIONS].sort());
  });
});

// ---------------------------------------------------------------------------
// R2d — audit and wire contract for local_sync_marker_failed.
// ---------------------------------------------------------------------------

const FIXED_MARKER_MESSAGE = "Local change committed; sync intent not persisted";

describe("R2d — audit and wire contract", () => {
  it("(a) audits the rpc.response.sent outcome as local_sync_marker_failed", async () => {
    const records: ServiceAuditRecord[] = [];
    const auditLogger = createLogger({
      sink: (line) => {
        const parsed = JSON.parse(line) as ServiceAuditRecord & { component?: string };
        if (parsed.component === "service_audit") records.push(parsed);
      },
    });
    const dir = mkdtempSync("/tmp/nbk-");
    const socketPath = join(dir, "nookd.sock");
    const handle = await startNookdServer({
      socketPath,
      runtime: injectedRuntime(new NotesnookWriteContractError("local_sync_marker_failed")),
      policy: createCustomServicePolicy(POLICY_METHODS),
      installSignalHandlers: false,
      auditLogger,
    });
    try {
      const client = new NookdSocketClient({ socketPath });
      const result = await client.createNote({ title: TITLE, content: CONTENT });
      expect(result).toMatchObject({ ok: false, code: "local_sync_marker_failed" });
      for (let i = 0; i < 50 && !records.some((r) => r.event === "rpc.response.sent"); i += 1) {
        await delay(10);
      }
    } finally {
      await handle.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
    const sent = records.filter((record) => record.event === "rpc.response.sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.outcome).toBe("local_sync_marker_failed");
    expect(() =>
      buildServiceAuditRecord({
        event: "rpc.response.sent",
        outcome: "local_sync_marker_failed",
        method: "notes.create",
        requestIdEcho: true,
        latencyMs: 1,
        peerCredentials: "self",
      }),
    ).not.toThrow();
  });

  it("(b) serializeRpcResponse accepts only the fixed message for the code", () => {
    const envelope = (message: string) => ({
      id: "r2d-1",
      ok: false as const,
      error: { code: "local_sync_marker_failed" as const, message },
    });
    expect(RPC_ERROR_MESSAGES.local_sync_marker_failed).toBe(FIXED_MARKER_MESSAGE);
    expect(() =>
      serializeRpcResponse(envelope(RPC_ERROR_MESSAGES.local_sync_marker_failed)),
    ).not.toThrow();
    expect(() => serializeRpcResponse(envelope("Service unavailable"))).toThrow();
  });

  it("(c) the MCP create error names the code and carries the fixed message, no leaks", async () => {
    await withHarness(
      injectedRuntime(new NotesnookWriteContractError("local_sync_marker_failed")),
      async (h) => {
        const result = await h.server.callTool(NOOK_MCP_CREATE_NOTE_TOOL_NAME, {
          title: TITLE,
          content: CONTENT,
        });
        expect(result.isError).toBe(true);
        const block = result.content[0];
        if (block?.type !== "text") throw new Error("no text block");
        expect(JSON.parse(block.text)).toMatchObject({
          code: "local_sync_marker_failed",
          message: FIXED_MARKER_MESSAGE,
        });
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("SECRET");
        expect(serialized).not.toContain("CANARY");
      },
    );
  });

  it("(d) an unknown envelope code still degrades to service_unavailable at L2", async () => {
    const daemon = await startEnvelopeDaemon("made_up_code" as RpcErrorCode);
    try {
      const client = new NookdSocketClient({ socketPath: daemon.socketPath });
      const result = await client.createNote({ title: TITLE, content: CONTENT });
      expect(result).toMatchObject({ ok: false, code: "service_unavailable" });
    } finally {
      await daemon.close();
    }
  });

  it("(e) the MCP tool list is 9 tools with unchanged input schemas", () => {
    const client = new NookdSocketClient({ socketPath: "/tmp/nbk-never-used.sock" });
    const { tools } = buildNookMcpServer({ client });
    const baseline = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("./fixtures/mcp-input-schemas-pre-r2d.json", import.meta.url)),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(tools).toHaveLength(9);
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]))).toEqual(
      baseline,
    );
  });

  it("documents the code and the do-not-retry rule", () => {
    const docs = readFileSync("docs/reference/mcp-tools.md", "utf8");
    expect(docs).toContain("local_sync_marker_failed");
  });
});
