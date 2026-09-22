/**
 * T04 — canonical operator RPC vocabulary.
 *
 * T00 freezes seven operator mutation/view methods. The browse/search methods
 * are a separate discovery transport vocabulary: they are not D2 methods and
 * are kept distinct so the frozen contract cannot silently widen.
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
] as const);

export const OPERATOR_DISCOVERY_METHODS = Object.freeze([
  "notes.browse",
  "notes.search-operator",
] as const);

export const OPERATOR_TRANSPORT_METHODS = Object.freeze([
  ...OPERATOR_METHODS,
  ...OPERATOR_DISCOVERY_METHODS,
] as const);

type OperatorMethodLiteral = (typeof OPERATOR_METHODS)[number];
type OperatorDiscoveryMethodLiteral = (typeof OPERATOR_DISCOVERY_METHODS)[number];
export type OperatorDiscoveryMethod = OperatorDiscoveryMethodLiteral;
export type OperatorTransportMethod = OperatorMethodLiteral | OperatorDiscoveryMethodLiteral;
export type OperatorMethod = OperatorTransportMethod;

const _operatorMethodsAreRpcMethods: OperatorTransportMethod extends RpcMethod ? true : false =
  true;
void _operatorMethodsAreRpcMethods;

export function isOperatorMethod(value: unknown): value is OperatorMethod {
  if (typeof value !== "string" || value.length === 0) return false;
  for (const method of OPERATOR_METHODS) if (method === value) return true;
  for (const method of OPERATOR_DISCOVERY_METHODS) if (method === value) return true;
  return false;
}

export function isOperatorDiscoveryMethod(value: unknown): value is OperatorDiscoveryMethod {
  if (typeof value !== "string" || value.length === 0) return false;
  for (const method of OPERATOR_DISCOVERY_METHODS) if (method === value) return true;
  return false;
}

export function isOperatorTransportMethod(value: unknown): value is OperatorTransportMethod {
  return isOperatorMethod(value) || isOperatorDiscoveryMethod(value);
}
