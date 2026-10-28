import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { NOOK_MCP_ALLOWED_TOOL_NAMES } from "../src/mcp/nook-mcp-server.js";
import { OPERATOR_TRANSPORT_METHODS } from "../src/service/operator-methods.js";

const root = resolve(import.meta.dirname, "..");
const read = (relative: string): string => readFileSync(resolve(root, relative), "utf8");

const plan = read("docs/implementation-plan-v1.5.md");
const mcpTools = read("docs/reference/mcp-tools.md");
const rpcProtocol = read("src/service/rpc-protocol.ts");

/** Slice a document from `heading` up to (excluding) `nextHeading`. */
function section(text: string, heading: string, nextHeading: string): string {
  const start = text.indexOf(heading);
  expect(start, `missing heading: ${heading}`).toBeGreaterThan(-1);
  const end = text.indexOf(nextHeading, start + heading.length);
  expect(end, `missing heading: ${nextHeading}`).toBeGreaterThan(start);
  return text.slice(start + heading.length, end);
}

/** Tool names that appear as the first cell of a Markdown table row. */
function tableToolNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^\|\s*`(notesnook_[a-z0-9_]+)`/.exec(line.trim());
    const name = match?.[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

const section33 = section(plan, "## 3.3 ", "## 3.4 ");
const section61 = section(plan, "## 6.1 ", "## 6.2 ");
const section1312 = section(plan, "## 13.12 ", "## 13.13 ");
const section1322 = section(plan, "## 13.22 ", "## 13.23 ");

/** Every literal in the closed `RpcMethod` union in the wire contract. */
function rpcMethodLiterals(source: string): string[] {
  const start = source.indexOf("export type RpcMethod =");
  expect(start, "missing `export type RpcMethod =`").toBeGreaterThan(-1);
  const end = source.indexOf("export interface", start);
  expect(end, "missing interface after `RpcMethod`").toBeGreaterThan(start);
  const block = source.slice(start, end);
  const literals: string[] = [];
  for (const match of block.matchAll(/"([^"]+)"/g)) {
    const literal = match[1];
    if (literal !== undefined) {
      literals.push(literal);
    }
  }
  expect(literals.length, "failed to parse any RPC method literal").toBeGreaterThan(0);
  return literals;
}

const rpcMethods = rpcMethodLiterals(rpcProtocol);

describe("documented MCP tool and RPC method catalogue (R13)", () => {
  it("§6.1 lists exactly the allowlisted MCP tools", () => {
    const documented = tableToolNames(section61);
    expect(documented.size).toBe(9);
    expect([...documented].sort()).toEqual([...new Set(NOOK_MCP_ALLOWED_TOOL_NAMES)].sort());
  });

  it("§6.1 includes the policy-controlled delete row", () => {
    const deleteRow = section61
      .split("\n")
      .find((line) => /^\|\s*`notesnook_delete_note`/.test(line.trim()));
    expect(deleteRow, "missing `notesnook_delete_note` row in §6.1").toBeDefined();
    expect(deleteRow).toContain("Write");
    expect(deleteRow).toContain("destructive");
    expect(deleteRow).toContain("policy-controlled");
    expect(deleteRow).toContain("readWriteNoDelete");
  });

  it("mcp-tools.md lists exactly the allowlisted MCP tools", () => {
    const documented = tableToolNames(mcpTools);
    expect([...documented].sort()).toEqual([...new Set(NOOK_MCP_ALLOWED_TOOL_NAMES)].sort());
  });

  it("§3.3 or §6.1 names every RpcMethod literal in backticks", () => {
    expect(rpcMethods).toHaveLength(20);
    const surface = `${section33}\n${section61}\n${section1322}`;
    for (const method of rpcMethods) {
      expect(surface, `RPC method \`${method}\` is undocumented`).toContain(`\`${method}\``);
    }
  });

  it("§3.3 no longer excludes delete generically and names notes.delete", () => {
    expect(section33).not.toContain(
      "unless they are explicitly designed and enabled in a future release",
    );
    expect(section33).toContain("`notes.delete`");
    expect(section33).toMatch(/no bulk or generic delete/i);
  });

  it("§6.1 states the closed MCP tool count and the RPC surface split", () => {
    expect(section61).toContain("MCP surface is exactly the 9 tools");
    expect(section61).toContain("`RpcMethod` union holds 20 literals");
    expect(section61).toContain("9 are reachable through MCP tools");
    expect(section61).toContain("1 is issued by the CLI over the daemon socket with no MCP tool");
    expect(section61).toContain("10 are operator-only");
    expect(section61).toContain("`notes.locked_note_proof`");
    expect(section61).toContain("`notes.path_diagnostic`");
    expect(section61).not.toContain("never admitted by the daemon listener");
  });

  it("§3.3 separates the eleven parsed names from the ten policy-admitted methods, and claims no method is never admitted", () => {
    expect(section33).toContain("recognises eleven method names");
    expect(section33).toContain("The service policy admits the first ten");
    expect(section33).toContain("holds twenty methods");
    expect(section33).toContain("ten are operator-only");
    expect(section33).not.toContain("never admitted by the daemon listener");
  });

  it("names every operator method the code exports, including the shared one", () => {
    // The operator surface carries eleven methods across OPERATOR_METHODS (nine,
    // including notes.create, which is shared with the daemon) and
    // OPERATOR_DISCOVERY_METHODS (two). A doc listing only the ten
    // operator-only ones is ambiguous about a closed vocabulary. Decision 5
    // documents the new approval method in §13.22, so include that section in
    // the closed catalogue surface without weakening the exact method loop.
    expect(OPERATOR_TRANSPORT_METHODS).toHaveLength(11);
    expect(OPERATOR_TRANSPORT_METHODS).toContain("notes.create");
    const operatorSurface = `${section33}\n${section1322}`;
    for (const method of OPERATOR_TRANSPORT_METHODS) {
      expect(operatorSurface, `operator method not documented: ${method}`).toContain(
        `\`${method}\``,
      );
    }
  });

  it("leaves §13.12 history untouched", () => {
    expect(section1312).toContain("eight closed methods");
  });
});
