/**
 * Stage 6 — `nook-mcp` MCP proxy server factory.
 *
 * This module builds the closed MCP server surface the proxy
 * exposes to Hermes. It is intentionally the *only* module in the
 * `src/mcp/` tree that imports `@modelcontextprotocol/sdk`. It is
 * the only module that registers tools, resources, or prompts,
 * the only module that knows how tool calls are translated to the
 *     four allowlisted read-only RPC methods and three bounded write methods.
 *
 * Hard rules (Stage 6 slice):
 *
 *   - Exactly seven tools are registered: the four bounded read-only search,
 *     status, notebook-listing, and note-metadata tools plus create, append,
 *     and update. No delete tool exists.
 *   - The search tool input schema is a fixed JSON Schema for
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

/** The original search tool name. Frozen: do NOT change without a
 *  decision-record amendment. */
export const NOOK_MCP_ALLOWED_TOOL_NAME = "notesnook_search_notes" as const;
export const NOOK_MCP_STATUS_TOOL_NAME = "notesnook_status" as const;
export const NOOK_MCP_LIST_NOTEBOOKS_TOOL_NAME = "notesnook_list_notebooks" as const;
export const NOOK_MCP_GET_NOTE_TOOL_NAME = "notesnook_get_note" as const;
export const NOOK_MCP_CREATE_NOTE_TOOL_NAME = "notesnook_create_note" as const;
export const NOOK_MCP_APPEND_NOTE_TOOL_NAME = "notesnook_append_note" as const;
export const NOOK_MCP_UPDATE_NOTE_TOOL_NAME = "notesnook_update_note" as const;

/** The exhaustive allowlist of valid tool names. The factory
 *  enforces this at registration time so a future contributor
 *  who adds a second `registerTool` call will fail loudly. */
export const NOOK_MCP_ALLOWED_TOOL_NAMES: ReadonlyArray<string> = Object.freeze([
  NOOK_MCP_ALLOWED_TOOL_NAME,
  NOOK_MCP_STATUS_TOOL_NAME,
  NOOK_MCP_LIST_NOTEBOOKS_TOOL_NAME,
  NOOK_MCP_GET_NOTE_TOOL_NAME,
  NOOK_MCP_CREATE_NOTE_TOOL_NAME,
  NOOK_MCP_APPEND_NOTE_TOOL_NAME,
  NOOK_MCP_UPDATE_NOTE_TOOL_NAME,
]);

/**
 * Names that MUST NEVER appear as tool names in this slice.
 * Captured here so the static-guard test can compare against a
 * single source of truth rather than a hand-edited list.
 */
export const FORBIDDEN_TOOL_NAMES: ReadonlyArray<string> = Object.freeze([
  "notesnook_delete_note",

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
export const NOOK_MCP_MAX_TITLE_BYTES = 256;
export const NOOK_MCP_MAX_IDENTIFIER_BYTES = 256;
export const NOOK_MCP_MAX_CONTENT_BYTES = 512;
export const NOOK_MCP_MAX_TAGS = 16;
export const NOOK_MCP_MAX_REVISION_BYTES = 36;

/** Maximum `limit` we will ever accept, even if a future Stage 6
 *  slice grows the underlying RPC to support one.  Today `limit`
 *  is documented as ignored; we still bound it so a future code
 *  path cannot be widened to an unbounded slice by accident. */
export const NOOK_MCP_MAX_LIMIT = 64;

function isSafeIdentifier(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const allowed =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x2d ||
      code === 0x5f;
    if (!allowed) return false;
  }
  return true;
}

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

const EMPTY_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({}),
  required: Object.freeze([]),
  additionalProperties: false,
});

const STATUS_TOOL_DEFINITION = Object.freeze({
  name: NOOK_MCP_STATUS_TOOL_NAME,
  description: "Return sync status without exposing credentials, paths, or note content.",
  inputSchema: EMPTY_INPUT_SCHEMA,
  annotations: SEARCH_TOOL_ANNOTATIONS,
}) as unknown as Tool;

const LIST_NOTEBOOKS_TOOL_DEFINITION = Object.freeze({
  name: NOOK_MCP_LIST_NOTEBOOKS_TOOL_NAME,
  description: "List notebook identifiers and titles from the local nookd service.",
  inputSchema: EMPTY_INPUT_SCHEMA,
  annotations: SEARCH_TOOL_ANNOTATIONS,
}) as unknown as Tool;

const GET_NOTE_TOOL_DEFINITION = Object.freeze({
  name: NOOK_MCP_GET_NOTE_TOOL_NAME,
  description: "Return bounded note metadata only; note bodies and attachments are never exposed.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      id: Object.freeze({ type: "string", minLength: 1, maxLength: NOOK_MCP_MAX_IDENTIFIER_BYTES }),
    }),
    required: Object.freeze(["id"]),
    additionalProperties: false,
  }),
  annotations: SEARCH_TOOL_ANNOTATIONS,
}) as unknown as Tool;

const CREATE_NOTE_TOOL_DEFINITION = Object.freeze({
  name: NOOK_MCP_CREATE_NOTE_TOOL_NAME,
  description: "Create a note with bounded title, content, and optional notebook identifier.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      title: Object.freeze({ type: "string", minLength: 1, maxLength: NOOK_MCP_MAX_TITLE_BYTES }),
      content: Object.freeze({
        type: "string",
        minLength: 1,
        maxLength: NOOK_MCP_MAX_CONTENT_BYTES,
      }),
      notebookId: Object.freeze({
        type: "string",
        minLength: 1,
        maxLength: NOOK_MCP_MAX_IDENTIFIER_BYTES,
      }),
    }),
    required: Object.freeze(["title", "content"]),
    additionalProperties: false,
  }),
  annotations: Object.freeze({
    title: "Create note",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  }),
}) as unknown as Tool;

const APPEND_NOTE_TOOL_DEFINITION = Object.freeze({
  name: NOOK_MCP_APPEND_NOTE_TOOL_NAME,
  description: "Append a bounded markdown fragment using an expected note revision.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      id: Object.freeze({ type: "string", minLength: 1, maxLength: NOOK_MCP_MAX_IDENTIFIER_BYTES }),
      markdownFragment: Object.freeze({
        type: "string",
        minLength: 1,
        maxLength: NOOK_MCP_MAX_CONTENT_BYTES,
      }),
      expectedRevision: Object.freeze({
        type: "string",
        minLength: NOOK_MCP_MAX_REVISION_BYTES,
        maxLength: NOOK_MCP_MAX_REVISION_BYTES,
      }),
    }),
    required: Object.freeze(["id", "markdownFragment", "expectedRevision"]),
    additionalProperties: false,
  }),
  annotations: Object.freeze({
    title: "Append to note",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  }),
}) as unknown as Tool;

const UPDATE_NOTE_TOOL_DEFINITION = Object.freeze({
  name: NOOK_MCP_UPDATE_NOTE_TOOL_NAME,
  description: "Update bounded note fields using an expected note revision.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      id: Object.freeze({ type: "string", minLength: 1, maxLength: NOOK_MCP_MAX_IDENTIFIER_BYTES }),
      expectedRevision: Object.freeze({
        type: "string",
        minLength: NOOK_MCP_MAX_REVISION_BYTES,
        maxLength: NOOK_MCP_MAX_REVISION_BYTES,
      }),
      patch: Object.freeze({
        type: "object",
        minProperties: 1,
        maxProperties: 6,
        properties: Object.freeze({
          title: Object.freeze({
            type: "string",
            minLength: 1,
            maxLength: NOOK_MCP_MAX_TITLE_BYTES,
          }),
          content: Object.freeze({
            type: "string",
            minLength: 1,
            maxLength: NOOK_MCP_MAX_CONTENT_BYTES,
          }),
          notebookId: Object.freeze({
            type: "string",
            minLength: 1,
            maxLength: NOOK_MCP_MAX_IDENTIFIER_BYTES,
          }),
          tags: Object.freeze({
            type: "array",
            minItems: 1,
            maxItems: NOOK_MCP_MAX_TAGS,
            items: Object.freeze({
              type: "string",
              minLength: 1,
              maxLength: NOOK_MCP_MAX_IDENTIFIER_BYTES,
            }),
          }),
          pinned: Object.freeze({ type: "boolean" }),
          favorite: Object.freeze({ type: "boolean" }),
        }),
        additionalProperties: false,
      }),
    }),
    required: Object.freeze(["id", "expectedRevision", "patch"]),
    additionalProperties: false,
  }),
  annotations: Object.freeze({
    title: "Update note",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }),
}) as unknown as Tool;

/** Static list of every tool the proxy is allowed to expose. */
export const NOOK_MCP_TOOL_DEFINITIONS: ReadonlyArray<Tool> = Object.freeze([
  SEARCH_TOOL_DEFINITION,
  STATUS_TOOL_DEFINITION,
  LIST_NOTEBOOKS_TOOL_DEFINITION,
  GET_NOTE_TOOL_DEFINITION,
  CREATE_NOTE_TOOL_DEFINITION,
  APPEND_NOTE_TOOL_DEFINITION,
  UPDATE_NOTE_TOOL_DEFINITION,
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

const emptyInputSchema = {};
const getNoteInputSchema = {
  id: z.string().min(1).max(NOOK_MCP_MAX_IDENTIFIER_BYTES).describe("Opaque note identifier."),
};
const createNoteInputSchema = {
  title: z.string().min(1).max(NOOK_MCP_MAX_TITLE_BYTES),
  content: z.string().min(1).max(NOOK_MCP_MAX_CONTENT_BYTES),
  notebookId: z.string().min(1).max(NOOK_MCP_MAX_IDENTIFIER_BYTES).optional(),
};
const appendNoteInputSchema = {
  id: z.string().min(1).max(NOOK_MCP_MAX_IDENTIFIER_BYTES),
  markdownFragment: z.string().min(1).max(NOOK_MCP_MAX_CONTENT_BYTES),
  expectedRevision: z
    .string()
    .length(NOOK_MCP_MAX_REVISION_BYTES)
    .regex(/^rev_[0-9a-f]{32}$/),
};
const updateNoteInputSchema = {
  id: z.string().min(1).max(NOOK_MCP_MAX_IDENTIFIER_BYTES),
  expectedRevision: z
    .string()
    .length(NOOK_MCP_MAX_REVISION_BYTES)
    .regex(/^rev_[0-9a-f]{32}$/),
  patch: z
    .object({
      title: z.string().min(1).max(NOOK_MCP_MAX_TITLE_BYTES).optional(),
      content: z.string().min(1).max(NOOK_MCP_MAX_CONTENT_BYTES).optional(),
      notebookId: z.string().min(1).max(NOOK_MCP_MAX_IDENTIFIER_BYTES).optional(),
      tags: z
        .array(z.string().min(1).max(NOOK_MCP_MAX_IDENTIFIER_BYTES))
        .min(1)
        .max(NOOK_MCP_MAX_TAGS)
        .optional(),
      pinned: z.boolean().optional(),
      favorite: z.boolean().optional(),
    })
    .strict()
    .refine((patch) => Object.keys(patch).length > 0),
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
 *   2. Registers exactly four read-only tools,
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

  registered.push({
    name: NOOK_MCP_STATUS_TOOL_NAME,
    handle: server.registerTool(
      NOOK_MCP_STATUS_TOOL_NAME,
      {
        title: "Sync status",
        description: "Return bounded local sync status.",
        inputSchema: emptyInputSchema,
        annotations: SEARCH_TOOL_ANNOTATIONS,
      },
      async () => invokeStatus(options.client),
    ),
  });
  registered.push({
    name: NOOK_MCP_LIST_NOTEBOOKS_TOOL_NAME,
    handle: server.registerTool(
      NOOK_MCP_LIST_NOTEBOOKS_TOOL_NAME,
      {
        title: "List notebooks",
        description: "List bounded notebook metadata.",
        inputSchema: emptyInputSchema,
        annotations: SEARCH_TOOL_ANNOTATIONS,
      },
      async () => invokeListNotebooks(options.client),
    ),
  });
  registered.push({
    name: NOOK_MCP_GET_NOTE_TOOL_NAME,
    handle: server.registerTool(
      NOOK_MCP_GET_NOTE_TOOL_NAME,
      {
        title: "Get note metadata",
        description: "Return bounded note metadata without the body.",
        inputSchema: getNoteInputSchema,
        annotations: SEARCH_TOOL_ANNOTATIONS,
      },
      async (input) => invokeGetNote(options.client, input as GetNoteInput),
    ),
  });
  registered.push({
    name: NOOK_MCP_CREATE_NOTE_TOOL_NAME,
    handle: server.registerTool(
      NOOK_MCP_CREATE_NOTE_TOOL_NAME,
      {
        title: "Create note",
        description: "Create a bounded note.",
        inputSchema: createNoteInputSchema,
        annotations: CREATE_NOTE_TOOL_DEFINITION.annotations as ToolAnnotations,
      },
      async (input) => invokeCreateNote(options.client, input as CreateNoteInput),
    ),
  });
  registered.push({
    name: NOOK_MCP_APPEND_NOTE_TOOL_NAME,
    handle: server.registerTool(
      NOOK_MCP_APPEND_NOTE_TOOL_NAME,
      {
        title: "Append to note",
        description: "Append a bounded markdown fragment to a note.",
        inputSchema: appendNoteInputSchema,
        annotations: APPEND_NOTE_TOOL_DEFINITION.annotations as ToolAnnotations,
      },
      async (input) => invokeAppendNote(options.client, input as AppendNoteInput),
    ),
  });
  registered.push({
    name: NOOK_MCP_UPDATE_NOTE_TOOL_NAME,
    handle: server.registerTool(
      NOOK_MCP_UPDATE_NOTE_TOOL_NAME,
      {
        title: "Update note",
        description: "Update bounded fields on a note.",
        inputSchema: updateNoteInputSchema,
        annotations: UPDATE_NOTE_TOOL_DEFINITION.annotations as ToolAnnotations,
      },
      async (input) => invokeUpdateNote(options.client, input as UpdateNoteInput),
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
      if (
        name !== NOOK_MCP_ALLOWED_TOOL_NAME &&
        name !== NOOK_MCP_STATUS_TOOL_NAME &&
        name !== NOOK_MCP_LIST_NOTEBOOKS_TOOL_NAME &&
        name !== NOOK_MCP_GET_NOTE_TOOL_NAME &&
        name !== NOOK_MCP_CREATE_NOTE_TOOL_NAME &&
        name !== NOOK_MCP_APPEND_NOTE_TOOL_NAME &&
        name !== NOOK_MCP_UPDATE_NOTE_TOOL_NAME
      ) {
        return toMcpErrorResult("unknown_tool");
      }
      const args = paramsRecord.arguments;
      if (name === NOOK_MCP_ALLOWED_TOOL_NAME)
        return invokeSearch(options.client, args as SearchInput);
      if (name === NOOK_MCP_STATUS_TOOL_NAME)
        return invokeStatus(options.client, args as Record<string, unknown>);
      if (name === NOOK_MCP_LIST_NOTEBOOKS_TOOL_NAME)
        return invokeListNotebooks(options.client, args as Record<string, unknown>);
      if (name === NOOK_MCP_GET_NOTE_TOOL_NAME)
        return invokeGetNote(options.client, args as GetNoteInput);
      if (name === NOOK_MCP_CREATE_NOTE_TOOL_NAME)
        return invokeCreateNote(options.client, args as CreateNoteInput);
      if (name === NOOK_MCP_APPEND_NOTE_TOOL_NAME)
        return invokeAppendNote(options.client, args as AppendNoteInput);
      return invokeUpdateNote(options.client, args as UpdateNoteInput);
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
interface GetNoteInput {
  id?: unknown;
}
interface CreateNoteInput {
  title?: unknown;
  content?: unknown;
  notebookId?: unknown;
}
interface AppendNoteInput {
  id?: unknown;
  markdownFragment?: unknown;
  expectedRevision?: unknown;
}
interface UpdateNoteInput {
  id?: unknown;
  expectedRevision?: unknown;
  patch?: unknown;
}

type BoundedWriteResult = Awaited<ReturnType<NookdSocketClient["appendNote"]>>;

async function invokeCreateNote(
  client: NookdSocketClient,
  input: CreateNoteInput,
): Promise<CallToolResult> {
  let params: { title: string; content: string; notebookId?: string };
  try {
    if (!hasExactKeys(input, ["title", "content", "notebookId"], ["title", "content"]))
      return toMcpErrorResult("invalid_request");
    const title = input.title;
    const content = input.content;
    if (
      !isBoundedText(title, NOOK_MCP_MAX_TITLE_BYTES) ||
      !isBoundedText(content, NOOK_MCP_MAX_CONTENT_BYTES)
    )
      return toMcpErrorResult("invalid_request");
    const notebookId = input.notebookId;
    if (notebookId !== undefined && !isBoundedIdentifier(notebookId))
      return toMcpErrorResult("invalid_request");
    params = notebookId === undefined ? { title, content } : { title, content, notebookId };
  } catch {
    return toMcpErrorResult("invalid_request");
  }
  let result: BoundedWriteResult;
  try {
    result = await client.createNote(params);
  } catch {
    return toMcpErrorResult("service_unavailable");
  }
  return projectCreateResult(result);
}

async function invokeAppendNote(
  client: NookdSocketClient,
  input: AppendNoteInput,
): Promise<CallToolResult> {
  let params: { id: string; markdownFragment: string; expectedRevision: string };
  try {
    if (!hasExactKeys(input, ["id", "markdownFragment", "expectedRevision"]))
      return toMcpErrorResult("invalid_request");
    if (
      !isBoundedIdentifier(input.id) ||
      !isBoundedText(input.markdownFragment, NOOK_MCP_MAX_CONTENT_BYTES) ||
      !isRevision(input.expectedRevision)
    )
      return toMcpErrorResult("invalid_request");
    params = {
      id: input.id,
      markdownFragment: input.markdownFragment,
      expectedRevision: input.expectedRevision,
    };
  } catch {
    return toMcpErrorResult("invalid_request");
  }
  let result: BoundedWriteResult;
  try {
    result = await client.appendNote(params);
  } catch {
    return toMcpErrorResult("service_unavailable");
  }
  return projectAppendResult(result);
}

async function invokeUpdateNote(
  client: NookdSocketClient,
  input: UpdateNoteInput,
): Promise<CallToolResult> {
  let params: {
    id: string;
    expectedRevision: string;
    patch: Record<string, unknown>;
  };
  try {
    if (!hasExactKeys(input, ["id", "expectedRevision", "patch"]))
      return toMcpErrorResult("invalid_request");
    if (!isBoundedIdentifier(input.id) || !isRevision(input.expectedRevision))
      return toMcpErrorResult("invalid_request");
    params = {
      id: input.id,
      expectedRevision: input.expectedRevision,
      patch: normaliseUpdatePatch(input.patch),
    };
  } catch {
    return toMcpErrorResult("invalid_request");
  }
  let result: BoundedWriteResult;
  try {
    result = await client.updateNote(params as Parameters<NookdSocketClient["updateNote"]>[0]);
  } catch {
    return toMcpErrorResult("service_unavailable");
  }
  return projectUpdateResult(result);
}

function hasExactKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    Object.getOwnPropertySymbols(record).length === 0 &&
    keys.every((key) => allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(record, key))
  );
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxBytes &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !hasControlCharacter(value)
  );
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isSafeIdentifier(value) &&
    value.length <= NOOK_MCP_MAX_IDENTIFIER_BYTES &&
    Buffer.byteLength(value, "utf8") <= NOOK_MCP_MAX_IDENTIFIER_BYTES
  );
}

function isRevision(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === NOOK_MCP_MAX_REVISION_BYTES &&
    /^rev_[0-9a-f]{32}$/.test(value)
  );
}

function normaliseUpdatePatch(value: unknown): Record<string, unknown> {
  const allowed = ["title", "content", "notebookId", "tags", "pinned", "favorite"] as const;
  if (!hasExactKeys(value, allowed, []) || Object.keys(value).length === 0)
    throw new Error("invalid patch");
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const field = value[key];
    if (key === "title" && !isBoundedText(field, NOOK_MCP_MAX_TITLE_BYTES))
      throw new Error("invalid patch");
    if (key === "content" && !isBoundedText(field, NOOK_MCP_MAX_CONTENT_BYTES))
      throw new Error("invalid patch");
    if (key === "notebookId" && !isBoundedIdentifier(field)) throw new Error("invalid patch");
    if (key === "tags") {
      if (!Array.isArray(field) || field.length === 0 || field.length > NOOK_MCP_MAX_TAGS)
        throw new Error("invalid patch");
      if (field.some((tag) => !isBoundedText(tag, NOOK_MCP_MAX_IDENTIFIER_BYTES)))
        throw new Error("invalid patch");
      patch[key] = [...field];
      continue;
    }
    if ((key === "pinned" || key === "favorite") && typeof field !== "boolean")
      throw new Error("invalid patch");
    patch[key] = field;
  }
  return patch;
}

function projectCreateResult(result: BoundedWriteResult): CallToolResult {
  try {
    if (!result.ok || result.envelope.result.kind !== "create")
      return result.ok
        ? toMcpErrorResult("service_unavailable")
        : toMcpErrorResult(socketFailureToCode(result.code));
    const value = result.envelope.result as unknown as Record<string, unknown>;
    if (
      !isBoundedIdentifier(value.id) ||
      !isBoundedCount(value.titleBytes, NOOK_MCP_MAX_TITLE_BYTES) ||
      !isBoundedCount(value.contentBytes)
    )
      return toMcpErrorResult("service_unavailable");
    return textResult({
      kind: "create",
      id: value.id,
      titleBytes: value.titleBytes,
      contentBytes: value.contentBytes,
    });
  } catch {
    return toMcpErrorResult("service_unavailable");
  }
}

function projectAppendResult(result: BoundedWriteResult): CallToolResult {
  try {
    if (!result.ok) return toMcpErrorResult(socketFailureToCode(result.code));
    const value = result.envelope.result as unknown as Record<string, unknown>;
    if (
      value.kind !== "append" ||
      !isBoundedIdentifier(value.id) ||
      !isBoundedCount(value.fragmentBytes)
    )
      return toMcpErrorResult("service_unavailable");
    return textResult({ kind: "append", id: value.id, fragmentBytes: value.fragmentBytes });
  } catch {
    return toMcpErrorResult("service_unavailable");
  }
}

function projectUpdateResult(result: BoundedWriteResult): CallToolResult {
  try {
    if (!result.ok) return toMcpErrorResult(socketFailureToCode(result.code));
    const value = result.envelope.result as unknown as Record<string, unknown>;
    const fields = value.appliedFields;
    if (
      value.kind !== "update" ||
      !isBoundedIdentifier(value.id) ||
      !Array.isArray(fields) ||
      fields.length === 0 ||
      fields.length > 6 ||
      new Set(fields).size !== fields.length ||
      fields.some(
        (field) =>
          !["title", "content", "notebookId", "tags", "pinned", "favorite"].includes(field),
      ) ||
      (Object.hasOwn(value, "contentBytes") && !isBoundedCount(value.contentBytes))
    )
      return toMcpErrorResult("service_unavailable");
    const payload: Record<string, unknown> = {
      kind: "update",
      id: value.id,
      appliedFields: [...fields],
    };
    if (Object.hasOwn(value, "contentBytes")) payload.contentBytes = value.contentBytes;
    return textResult(payload);
  } catch {
    return toMcpErrorResult("service_unavailable");
  }
}

function isBoundedCount(value: unknown, maximum = NOOK_MCP_MAX_CONTENT_BYTES): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;
}

async function invokeStatus(
  client: NookdSocketClient,
  input: Record<string, unknown> = {},
): Promise<CallToolResult> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 0
  )
    return toMcpErrorResult("invalid_request");
  const result = await client.status();
  if (!result.ok) return toMcpErrorResult(socketFailureToCode(result.code));
  try {
    if (result.envelope.result.kind !== "status") return toMcpErrorResult("service_unavailable");
    return textResult({
      kind: "status",
      lastSynced: result.envelope.result.lastSynced,
      hasUnsyncedChanges: result.envelope.result.hasUnsyncedChanges,
    });
  } catch {
    return toMcpErrorResult("service_unavailable");
  }
}

async function invokeListNotebooks(
  client: NookdSocketClient,
  input: Record<string, unknown> = {},
): Promise<CallToolResult> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 0
  )
    return toMcpErrorResult("invalid_request");
  const result = await client.listNotebooks();
  if (!result.ok) return toMcpErrorResult(socketFailureToCode(result.code));
  try {
    if (result.envelope.result.kind !== "notebooks") return toMcpErrorResult("service_unavailable");
    return textResult({ kind: "notebooks", notebooks: result.envelope.result.notebooks });
  } catch {
    return toMcpErrorResult("service_unavailable");
  }
}

async function invokeGetNote(
  client: NookdSocketClient,
  input: GetNoteInput,
): Promise<CallToolResult> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "id")
  )
    return toMcpErrorResult("invalid_request");
  const id = input.id;
  if (
    typeof id !== "string" ||
    !isSafeIdentifier(id) ||
    id.length > NOOK_MCP_MAX_IDENTIFIER_BYTES ||
    Buffer.byteLength(id, "utf8") > NOOK_MCP_MAX_IDENTIFIER_BYTES
  )
    return toMcpErrorResult("invalid_request");
  const result = await client.getNote(id);
  if (!result.ok) return toMcpErrorResult(socketFailureToCode(result.code));
  try {
    if (result.envelope.result.kind !== "note") return toMcpErrorResult("service_unavailable");
    return textResult({ kind: "note", note: result.envelope.result.note });
  } catch {
    return toMcpErrorResult("service_unavailable");
  }
}

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
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
    if (result.envelope.result.kind !== "search") return toMcpErrorResult("service_unavailable");
    const payload = {
      kind: "search",
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
  if (name === NOOK_MCP_ALLOWED_TOOL_NAME) return invokeSearch(client, args as SearchInput);
  if (name === NOOK_MCP_STATUS_TOOL_NAME) return invokeStatus(client, args);
  if (name === NOOK_MCP_LIST_NOTEBOOKS_TOOL_NAME) return invokeListNotebooks(client, args);
  if (name === NOOK_MCP_GET_NOTE_TOOL_NAME) return invokeGetNote(client, args as GetNoteInput);
  if (name === NOOK_MCP_CREATE_NOTE_TOOL_NAME)
    return invokeCreateNote(client, args as CreateNoteInput);
  if (name === NOOK_MCP_APPEND_NOTE_TOOL_NAME)
    return invokeAppendNote(client, args as AppendNoteInput);
  if (name === NOOK_MCP_UPDATE_NOTE_TOOL_NAME)
    return invokeUpdateNote(client, args as UpdateNoteInput);
  return toMcpErrorResult("unknown_tool");
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
    case "stale_revision":
    case "conflict":
      // The MCP vocabulary is intentionally narrower than the write RPC
      // vocabulary; do not invent a new externally visible category here.
      return "service_unavailable";
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
