/**
 * Stage 6 — `nook-mcp` MCP proxy server factory.
 *
 * This module builds the closed MCP server surface the proxy
 * exposes to Hermes. It is intentionally the *only* module in the
 * `src/mcp/` tree that imports `@modelcontextprotocol/sdk`. It is
 * the only module that registers tools, resources, or prompts,
 * and it is the only module that knows how a tool call is
 * translated to a Stage 5 `notes.search` RPC.
 *
 * Hard rules (Stage 6 slice):
 *
 *   - Exactly one tool is registered: `notesnook_search_notes`.
 *   - The tool is annotated `readOnlyHint: true` and
 *     `destructiveHint: false`. No mutating tools exist in this
 *     slice; mutating tools are deferred to a later stage with
 *     its own decision-record amendment.
 *   - The tool input schema is a fixed JSON Schema for
 *     `{ query: string, limit?: number }`. `limit` is optional
 *     and is documented as currently ignored because the
 *     underlying Stage 5 RPC does not support a caller-provided
 *     limit (this is captured in `docs/stage-6-mcp-proxy.md`).
 *     The Stage 5 RPC contract is unchanged in this slice.
 *   - The tool callback validates the input shape and bounds
 *     BEFORE invoking the socket client. A hostile or empty
 *     query never reaches the daemon.
 *   - The closed categorical MCP error vocabulary
 *     ({@link NookMcpErrorCode}) is the only failure surface.
 *     Note IDs, note bodies, paths, socket errors, errno
 *     strings, and `cause` chains never cross the boundary.
 *   - The factory takes a {@link NookdSocketClient} as a
 *     dependency so tests can inject a fake without ever
 *     opening a real socket.
 */

import { Buffer } from "node:buffer";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { toMcpErrorResult, type NookMcpErrorCode } from "./errors.js";
import { NookdSocketClient, type NookdSocketFailure } from "./socket-client.js";

export { NookMcpServerError, nookMcpServiceUnavailableResult } from "./errors.js";

// -----------------------------------------------------------------------
// Version constant — kept in one place so package.json and the SDK
// announcement stay in sync. Declared before the public constants that
// are commonly copied into other modules.
// -----------------------------------------------------------------------

const NOOK_MCP_VERSION = "0.0.0-stage.6" as const;

// -----------------------------------------------------------------------
// Public constants — frozen names that downstream code may import.
// -----------------------------------------------------------------------

/** The single MVP tool name. Frozen: do NOT change without a
 *  decision-record amendment. */
export const NOOK_MCP_ALLOWED_TOOL_NAME = "notesnook_search_notes" as const;

/** The exhaustive allowlist of valid tool names. The factory
 *  enforces this at registration time so a future contributor
 *  who adds a second `registerTool` call will fail loudly. */
export const NOOK_MCP_ALLOWED_TOOL_NAMES: ReadonlyArray<string> = Object.freeze([
  NOOK_MCP_ALLOWED_TOOL_NAME,
]);

/**
 * Names that MUST NEVER appear as tool names in this slice.
 * Captured here so the static-guard test can compare against a
 * single source of truth rather than a hand-edited list.
 */
export const FORBIDDEN_TOOL_NAMES: ReadonlyArray<string> = Object.freeze([
  "notesnook_get_note",
  "notesnook_create_note",
  "notesnook_update_note",
  "notesnook_append_note",
  "notesnook_delete_note",
  "notesnook_list_notebooks",
  "notesnook_list_notes",
  "notesnook_sync",
  "notesnook_full_sync",
  "notesnook_send_sync",
  "notesnook_unlock_vault",
  "notesnook_auth_login",
  "notesnook_call",
  "notesnook_eval",
]);

/**
 * Maximum query byte budget. Mirrors
 * `STAGE5_RPC_LIMITS.maxQueryBytes` so the MCP layer cannot
 * accept a query that the underlying RPC would reject.
 */
export const NOOK_MCP_MAX_QUERY_BYTES = 512;

/** Maximum `limit` we will ever accept, even if a future Stage 6
 *  slice grows the underlying RPC to support one.  Today `limit`
 *  is documented as ignored; we still bound it so a future code
 *  path cannot be widened to an unbounded slice by accident. */
export const NOOK_MCP_MAX_LIMIT = 64;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0 && code <= 0x1f) || code === 0x7f) return true;
  }
  return false;
}

// -----------------------------------------------------------------------
// Tool definitions.
// -----------------------------------------------------------------------

const SEARCH_TOOL_ANNOTATIONS: ToolAnnotations = Object.freeze({
  title: "Search notes",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const SEARCH_TOOL_DESCRIPTION =
  "Search note titles via the local nookd service. " +
  "Returns title-only hits; note IDs, bodies, and notebook IDs are intentionally not exposed.";

/** Static tool descriptor returned by the factory so tests can
 *  introspect the registered surface without standing up an MCP
 *  transport. */
const SEARCH_TOOL_DEFINITION = Object.freeze({
  name: NOOK_MCP_ALLOWED_TOOL_NAME,
  description: SEARCH_TOOL_DESCRIPTION,
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      query: Object.freeze({
        type: "string",
        description:
          "Search query string. Must be non-empty after trimming and within the published byte budget.",
        minLength: 1,
        maxLength: NOOK_MCP_MAX_QUERY_BYTES,
      }),
      limit: Object.freeze({
        type: "integer",
        description:
          "Optional upper bound on the number of returned titles. " +
          "Currently ignored by the underlying service; documented in " +
          "docs/stage-6-mcp-proxy.md.",
        minimum: 1,
        maximum: NOOK_MCP_MAX_LIMIT,
      }),
    }),
    required: Object.freeze(["query"]),
    additionalProperties: false,
  }),
  annotations: SEARCH_TOOL_ANNOTATIONS,
}) as unknown as Tool;

/** Static list of every tool the proxy is allowed to expose. */
export const NOOK_MCP_TOOL_DEFINITIONS: ReadonlyArray<Tool> = Object.freeze([
  SEARCH_TOOL_DEFINITION,
]);

// -----------------------------------------------------------------------
// Input schemas — Zod shapes used by `registerTool`.
// -----------------------------------------------------------------------

const searchInputSchema = {
  query: z
    .string()
    .min(1)
    .max(NOOK_MCP_MAX_QUERY_BYTES)
    .describe("Search query string (non-empty, within the published byte budget)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(NOOK_MCP_MAX_LIMIT)
    .optional()
    .describe("Optional upper bound on returned titles (currently ignored)."),
};

const permissiveCallRequestSchema = z
  .object({
    method: z.literal("tools/call"),
    params: z.unknown().optional(),
  })
  .passthrough();

// -----------------------------------------------------------------------
// Public factory.
// -----------------------------------------------------------------------

export interface BuildNookMcpServerOptions {
  readonly client: NookdSocketClient;
}

/**
 * A single registered tool, paired with the canonical name we
 * registered it under. We track the name locally because the
 * SDK's {@link RegisteredTool} type does NOT expose `name` as
 * a property in @modelcontextprotocol/sdk 1.30.0 — the name is
 * only stored in the server's private `_registeredTools` map.
 * Pairing the handle with the registered name lets the static
 * guards below compare against the closed allowlist without
 * touching the private SDK map.
 */
interface RegisteredToolRecord {
  readonly name: string;
  readonly handle: RegisteredTool;
}

/**
 * Public introspection handle returned by {@link buildNookMcpServer}.
 *
 * Tests use this to walk the registered tools / prompts /
 * resources without standing up an MCP transport.
 */
export interface NookMcpServerHandle {
  readonly server: McpServer;
  readonly tools: ReadonlyArray<Tool>;
  readonly prompts: ReadonlyArray<unknown>;
  readonly resources: ReadonlyArray<unknown>;
  /** Direct tool invocation surface, useful for unit tests. */
  readonly callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
}

/**
 * Build the closed MCP proxy server.
 *
 * The factory:
 *
 *   1. Constructs an {@link McpServer} with explicit
 *      `capabilities: {}` so no resources / prompts / tools
 *      are advertised except what we register.
 *   2. Registers exactly one tool, `notesnook_search_notes`,
 *      with the published JSON Schema + annotations.
 *   3. Returns a handle exposing the registered surface plus a
 *      `callTool` helper for direct invocation.
 */
export function buildNookMcpServer(options: BuildNookMcpServerOptions): NookMcpServerHandle {
  if (!(options.client instanceof NookdSocketClient)) {
    throw new TypeError("nook-mcp: client must be a NookdSocketClient");
  }
  const server = new McpServer(
    {
      name: "nook-mcp",
      version: NOOK_MCP_VERSION,
    },
    {
      capabilities: {},
    },
  );
  const registered: RegisteredToolRecord[] = [];
  registered.push({
    name: NOOK_MCP_ALLOWED_TOOL_NAME,
    handle: server.registerTool(
      NOOK_MCP_ALLOWED_TOOL_NAME,
      {
        title: "Search notes",
        description: SEARCH_TOOL_DESCRIPTION,
        inputSchema: searchInputSchema,
        annotations: SEARCH_TOOL_ANNOTATIONS,
      },
      async (input) => invokeSearch(options.client, input as SearchInput),
    ),
  });

  // The high-level McpServer dispatcher emits SDK-generated validation and
  // unknown-tool text. Replace only its tools/call handler with the same
  // SDK-backed transport seam, while retaining registerTool's exact schema
  // for tools/list. All call inputs therefore cross our categorical boundary.
  server.server.removeRequestHandler("tools/call");
  server.server.setRequestHandler(permissiveCallRequestSchema, async (request) => {
    try {
      const params = request.params;
      if (typeof params !== "object" || params === null || Array.isArray(params)) {
        return toMcpErrorResult("invalid_request");
      }
      const paramsRecord = params as Record<string, unknown>;
      const name = paramsRecord.name;
      if (typeof name !== "string") {
        return toMcpErrorResult("invalid_request");
      }
      if (name !== NOOK_MCP_ALLOWED_TOOL_NAME) {
        return toMcpErrorResult("unknown_tool");
      }
      return invokeSearch(options.client, paramsRecord.arguments as SearchInput);
    } catch {
      return toMcpErrorResult("invalid_request");
    }
  });

  // Defence-in-depth: refuse to construct if anything beyond the
  // allowlist was registered.  If a future contributor adds a
  // second `registerTool` call above, this guard fires.
  for (const tool of registered) {
    if (!NOOK_MCP_ALLOWED_TOOL_NAMES.includes(tool.name)) {
      throw new Error(`nook-mcp: tool "${tool.name}" is not in the closed allowlist`);
    }
  }
  for (const forbidden of FORBIDDEN_TOOL_NAMES) {
    for (const tool of registered) {
      if (tool.name === forbidden) {
        throw new Error(`nook-mcp: forbidden tool "${forbidden}" was registered`);
      }
    }
  }
  if (registered.length !== NOOK_MCP_ALLOWED_TOOL_NAMES.length) {
    throw new Error(
      `nook-mcp: registered ${registered.length} tool(s) but allowlist has ${NOOK_MCP_ALLOWED_TOOL_NAMES.length}`,
    );
  }

  const handle: NookMcpServerHandle = Object.freeze({
    server,
    tools: NOOK_MCP_TOOL_DEFINITIONS,
    prompts: Object.freeze([]) as ReadonlyArray<unknown>,
    resources: Object.freeze([]) as ReadonlyArray<unknown>,
    callTool: (name: string, args: Record<string, unknown>) =>
      callToolDirectly(options.client, name, args),
  });
  return handle;
}

interface SearchInput {
  query?: unknown;
  limit?: unknown;
}

/**
 * MCP-side tool callback. Validates the input shape and bounds
 * BEFORE invoking the socket client; any deviation collapses to
 * a categorical MCP error result.
 */
async function invokeSearch(
  client: NookdSocketClient,
  input: SearchInput,
): Promise<CallToolResult> {
  let normalised: NormalisedSearchInput | NormalisedSearchFailure;
  try {
    normalised = normaliseSearchInput(input);
  } catch {
    return toMcpErrorResult("invalid_request");
  }
  if (!normalised.ok) {
    return toMcpErrorResult(normalised.code);
  }
  let result: Awaited<ReturnType<NookdSocketClient["search"]>>;
  try {
    result = await client.search({ query: normalised.query });
  } catch {
    return toMcpErrorResult("service_unavailable");
  }
  if (!result.ok) {
    return toMcpErrorResult(socketFailureToCode(result.code));
  }
  try {
    const payload = {
      kind: result.envelope.result.kind,
      notes: result.envelope.result.notes.map((note) => ({ title: note.title })),
    };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload),
        },
      ],
    };
  } catch {
    return toMcpErrorResult("service_unavailable");
  }
}

/**
 * Direct (non-SDK) tool invocation. Mirrors the SDK callback
 * logic exactly so unit tests can exercise the boundary without
 * standing up an MCP transport.
 */
async function callToolDirectly(
  client: NookdSocketClient,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  if (name !== NOOK_MCP_ALLOWED_TOOL_NAME) {
    return toMcpErrorResult("unknown_tool");
  }
  return invokeSearch(client, args as SearchInput);
}

interface NormalisedSearchInput {
  readonly ok: true;
  readonly query: string;
}
interface NormalisedSearchFailure {
  readonly ok: false;
  readonly code: NookMcpErrorCode;
}

function normaliseSearchInput(input: SearchInput): NormalisedSearchInput | NormalisedSearchFailure {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "invalid_request" };
  }
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "query" && key !== "limit")) {
    return { ok: false, code: "invalid_request" };
  }
  const query = (input as { query?: unknown }).query;
  if (typeof query !== "string") {
    return { ok: false, code: "invalid_request" };
  }
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "invalid_request" };
  }
  if (hasControlCharacter(trimmed)) {
    return { ok: false, code: "invalid_request" };
  }
  if (Buffer.byteLength(trimmed, "utf8") > NOOK_MCP_MAX_QUERY_BYTES) {
    return { ok: false, code: "invalid_request" };
  }
  // `limit` is intentionally accepted in the input schema (so a
  // future Stage 6 slice can wire it through without a schema
  // break) but currently ignored; see docs/stage-6-mcp-proxy.md.
  const limit = (input as { limit?: unknown }).limit;
  if (
    limit !== undefined &&
    (typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > NOOK_MCP_MAX_LIMIT)
  ) {
    return { ok: false, code: "invalid_request" };
  }
  return { ok: true, query: trimmed };
}

function socketFailureToCode(reason: NookdSocketFailure): NookMcpErrorCode {
  switch (reason) {
    case "invalid_request":
      return "invalid_request";
    case "permission_denied":
      return "permission_denied";
    case "sync_failed":
      return "sync_failed";
    case "vault_locked":
      return "vault_locked";
    case "not_found":
      return "not_found";
    case "service_unavailable":
      return "service_unavailable";
    default:
      return "service_unavailable";
  }
}
