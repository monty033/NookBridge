/**
 * Stage 6 — categorical MCP error vocabulary for the read-only
 * `nook-mcp` proxy.
 *
 * The Stage 5 service-boundary decision record (§5) pins the closed
 * categorical RPC error vocabulary
 * (`invalid_request`, `permission_denied`, `service_unavailable`,
 * `sync_failed`, `vault_locked`, `not_found`). The Stage 6 MCP
 * proxy re-exports that same vocabulary, adds a single proxy-side
 * `unknown_tool` category for the MCP layer, and refuses to expose
 * any other error code to the agent.
 *
 * Hard rules:
 *
 *   - The error body is a single JSON text block whose schema is
 *     `{ "code": string, "message": string }`. No note IDs, no note
 *     bodies, no paths, no upstream socket / connect / errno
 *     strings, no `cause` chains cross the boundary.
 *   - `McpErrorResult` is built through the closed helper
 *     {@link toMcpErrorResult} so every result is structurally
 *     identical and frozen.
 *   - {@link NookMcpServerError} is the proxy-internal exception
 *     type. It carries a categorical code only — never the raw
 *     upstream error message, cause, or stack frames. The
 *     `cause` and `__context__` properties are explicitly cleared
 *     to keep the chain free.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// -----------------------------------------------------------------------
// Closed categorical vocabulary.
// -----------------------------------------------------------------------

/**
 * The full categorical vocabulary the MCP proxy may surface.
 *
 * The Stage 5 RPC codes are passed through unchanged; the proxy adds
 * `unknown_tool` for MCP-layer tool routing, and `service_loss` for
 * the transport-level socket failure mode (which the proxy reports
 * to the agent as the same `service_unavailable` category the
 * upstream daemon would have used).
 */
export type NookMcpErrorCode =
  | "invalid_request"
  | "permission_denied"
  | "service_unavailable"
  | "sync_failed"
  | "vault_locked"
  | "stale_revision"
  | "conflict"
  | "not_found"
  | "unknown_tool";

/**
 * Fixed, redacted message text per category. Identical messages
 * are used regardless of the upstream detail so the proxy never
 * echoes raw parser / socket / Notesnook output.
 */
const NOOK_MCP_ERROR_MESSAGES: Readonly<Record<NookMcpErrorCode, string>> = Object.freeze({
  invalid_request: "Invalid request",
  permission_denied: "Permission denied",
  service_unavailable: "Service unavailable",
  sync_failed: "Sync failed",
  vault_locked: "Vault locked",
  stale_revision: "Stale revision",
  conflict: "Conflict",
  not_found: "Not found",
  unknown_tool: "Unknown tool",
});

/**
 * Return the fixed, redacted message for a closed category. Any
 * code outside the closed vocabulary is treated as
 * `service_unavailable` so the proxy cannot accidentally surface
 * an uncategorised message.
 */
export function nookMcpErrorMessage(code: NookMcpErrorCode): string {
  return NOOK_MCP_ERROR_MESSAGES[code];
}

// -----------------------------------------------------------------------
// Internal exception type.
// -----------------------------------------------------------------------

/**
 * Proxy-internal exception carrying a categorical code only. The
 * `cause`, `__context__`, and stack frames are deliberately cleared
 * before the exception crosses module boundaries so a hostile
 * socket / parser cannot smuggle data through the chain.
 */
export class NookMcpServerError extends Error {
  readonly category: NookMcpErrorCode;
  constructor(category: NookMcpErrorCode) {
    super(NOOK_MCP_ERROR_MESSAGES[category]);
    this.name = "NookMcpServerError";
    this.category = category;
    Object.defineProperty(this, "cause", { configurable: true, value: undefined });
    Object.defineProperty(this, "__context__", { configurable: true, value: undefined });
    Object.freeze(this);
  }
}

/**
 * True iff `value` is a {@link NookMcpServerError} produced by
 * this module. Used to distinguish proxy-internal rejections from
 * upstream transport / parser errors before mapping them to MCP
 * results.
 */
export function isNookMcpServerError(value: unknown): value is NookMcpServerError {
  return value instanceof NookMcpServerError;
}

// -----------------------------------------------------------------------
// Result builders.
// -----------------------------------------------------------------------

/**
 * Build a closed `isError: true` MCP `CallToolResult` for the
 * supplied category. The result is frozen and contains exactly one
 * `text` content block whose JSON payload is
 * `{ code, message }`. No raw upstream detail is echoed.
 *
 * Implementation note: the SDK's `CallToolResult` type comes from
 * `z.infer`; we deliberately construct the object literal first and
 * then freeze so the structural shape matches the schema, and we
 * avoid spreading an `Object.freeze` shape that `exactOptionalPropertyTypes`
 * would reject.
 */
export function toMcpErrorResult(code: NookMcpErrorCode): CallToolResult {
  const payload = JSON.stringify({ code, message: nookMcpErrorMessage(code) });
  const result: CallToolResult = {
    isError: true,
    content: [
      {
        type: "text",
        text: payload,
      },
    ],
  };
  Object.freeze(result);
  Object.freeze(result.content);
  Object.freeze(result.content[0]);
  return result;
}

/**
 * Convenience wrapper that builds the canonical
 * `service_unavailable` MCP error result.
 */
export function nookMcpServiceUnavailableResult(): CallToolResult {
  return toMcpErrorResult("service_unavailable");
}
