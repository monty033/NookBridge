/**
 * T04 — canonical operator RPC vocabulary.
 *
 * T00 froze seven operator methods:
 *
 *   notes.get-view
 *   notes.edit-preimage
 *   notes.apply-edit
 *   notes.apply-undo
 *   notes.create
 *   notes.operation-status
 *   notes.operation-list
 *
 * The discovery surface added two more for browsing and searching, so the
 * closed set an operator listener accepts today is nine:
 *
 *   notes.browse
 *   notes.search-operator
 *
 * Both halves are published literals of the operator transport; the header and
 * the constant must agree, and `tests/stage-11-operator-discovery-handler.test.ts`
 * pins the exact set so neither can drift silently.
 *
 * This module is a tiny frozen-constant surface — every other
 * T04 module (`rpc-protocol`, `service-policy`, `operator-server`,
 * tests) imports from here so the vocabulary lives in exactly one
 * place and a regression that introduces an alias
 * (`notes.edit` / `notes.undo` / `notes.predict-next-revision` /
 * any "snapshot" RPC) is caught by both the unit suite and the
 * type system.
 *
 * The union is the closed set of `RpcMethod` literals an operator
 * listener may accept on the dedicated Unix socket.  The MCP
 * listener still rejects every entry in this set: the operator
 * vocabulary is bound to a separate transport, a separate
 * authorization seam, and a separate peer-credential check.
 */

import type { RpcMethod } from "./rpc-protocol.js";

export const OPERATOR_METHODS = Object.freeze([
  "notes.get-view",
  "notes.edit-preimage",
  "notes.apply-edit",
  "notes.apply-undo",
  "notes.create",
  "notes.operation-status",
  "notes.operation-list",
  "notes.browse",
  "notes.search-operator",
] as const);

// Each operator literal is also a member of the `RpcMethod` union —
// the parser admits operator methods on the wire.  The narrow type
// `OperatorMethod` (defined below) is what the policy seam
// consumes; `RpcMethod` is the wire type.
type OperatorMethodLiteral = (typeof OPERATOR_METHODS)[number];
const _operatorMethodIsRpcMethodCheck: OperatorMethodLiteral extends RpcMethod ? true : false =
  true;
void _operatorMethodIsRpcMethodCheck;

export type OperatorMethod = OperatorMethodLiteral;

/**
 * Test membership in the canonical operator vocabulary.  Returns
 * `true` only for one of the nine published literals; every other
 * string, the empty string, and every non-string candidate is
 * `false`.  The check is intentionally O(n) over the small frozen
 * list — the alternative is a `Set`, but a Set's iterator surface
 * would leak the method names through hostile probing during
 * operator-listener fuzz tests.
 */
export function isOperatorMethod(value: unknown): value is OperatorMethod {
  if (typeof value !== "string" || value.length === 0) return false;
  for (let index = 0; index < OPERATOR_METHODS.length; index += 1) {
    if (OPERATOR_METHODS[index] === value) return true;
  }
  return false;
}
