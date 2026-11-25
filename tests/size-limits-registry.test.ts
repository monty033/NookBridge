import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { SIZE_LIMITS } from "../src/core/size-limits.js";
import { MAX_NOTE_DOCUMENT_MARKDOWN_BYTES } from "../src/core/note-document-markdown.js";
import { MAX_NOTE_DOCUMENT_NATIVE_BYTES } from "../src/core/note-document-native.js";
import {
  MAX_NOTE_DOCUMENT_BLOCK_BYTES,
  MAX_NOTE_DOCUMENT_INLINE_BYTES,
  MAX_NOTE_DOCUMENT_OPAQUE_SENTINEL_BYTES,
  MAX_NOTE_DOCUMENT_OPAQUE_TEXT_BYTES,
  MAX_NOTE_DOCUMENT_OPAQUE_TEXT_TOTAL_BYTES,
  MAX_NOTE_DOCUMENT_REFERENCE_LABEL_BYTES,
  MAX_NOTE_DOCUMENT_REFERENCE_URL_BYTES,
} from "../src/core/note-document.js";
import { STAGE4_WRITE_LIMITS } from "../src/core/notesnook-write-contract.js";
import {
  MAX_NOTES_QUERY_BYTES,
  MAX_NOTES_GET_MARKDOWN_BYTES,
} from "../src/operator/notes-cli.js";
import { MAX_EDITOR_MARKDOWN_BYTES } from "../src/operator/notes-editor-runner.js";
import { MAX_NOTES_READ_QUERY_BYTES } from "../src/operator/notes-read-runtime.js";
import { NOTES_UNDO_CONTENT_MAX_BYTES } from "../src/operator/notes-undo-journal.js";
import { STAGE5_RPC_LIMITS } from "../src/service/rpc-protocol.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/**
 * The value of a numeric constant expression, or null when it is not one.
 *
 * Evaluating the expression rather than matching spellings is the point:
 * `65_536`, `65536`, `64 * 1024` and `1 << 16` are the same number, and all of
 * them are found. A definition that reads from the registry is an identifier,
 * so it evaluates to null and is not a hit — which is exactly the distinction
 * this test is built on.
 */
function constantValue(node: ts.Node): number | null {
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ""));
  if (ts.isParenthesizedExpression(node)) return constantValue(node.expression);
  // `as const`, `as number` and `satisfies` wrap the value without changing it,
  // and `as const` is this codebase's idiom for a fixed constant.
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) {
    return constantValue(node.expression);
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const inner = constantValue(node.operand);
    return inner === null ? null : -inner;
  }
  if (ts.isBinaryExpression(node)) {
    const left = constantValue(node.left);
    const right = constantValue(node.right);
    if (left === null || right === null) return null;
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.AsteriskToken:
        return left * right;
      case ts.SyntaxKind.PlusToken:
        return left + right;
      case ts.SyntaxKind.MinusToken:
        return left - right;
      case ts.SyntaxKind.LessThanLessThanToken:
        return left << right;
      case ts.SyntaxKind.AsteriskAsteriskToken:
        return left ** right;
      default:
        return null;
    }
  }
  return null;
}

describe("size limit registry", () => {
  it("pins every limit at its current value", () => {
    // A change here is a deliberate limit change and belongs in a diff that
    // says so, together with the tests that exercise the new ceiling.
    expect(SIZE_LIMITS).toEqual({
      OPERATOR_FRAME_BYTES: 65_536,
      RPC_FRAME_BYTES: 65_536,
      RPC_RESPONSE_BYTES: 65_536,
      RPC_CONTENT_BYTES: 27_000,
      RPC_QUERY_BYTES: 512,
      RPC_TITLE_BYTES: 256,
      RPC_IDENTIFIER_BYTES: 256,
      RPC_REVISION_BYTES: 64,
      MCP_MESSAGE_BYTES: 65_536,
      MCP_QUERY_BYTES: 512,
      STORED_CONTENT_BYTES: 262_144,
      STORED_CONTENT_READ_BYTES: 262_144,
      NATIVE_DOCUMENT_BYTES: 262_144,
      STORED_TITLE_BYTES: 1_024,
      FRAGMENT_BYTES: 32_768,
      MARKDOWN_CODEC_STORED_BYTES: 1_048_576,
      CONFLICT_RESOLVE_PAYLOAD_BYTES: 65_536,
      DOCUMENT_BLOCK_BYTES: 65_536,
      DOCUMENT_INLINE_BYTES: 8_192,
      DOCUMENT_OPAQUE_SENTINEL_BYTES: 128,
      DOCUMENT_OPAQUE_TEXT_BYTES: 8_192,
      DOCUMENT_OPAQUE_TEXT_TOTAL_BYTES: 16_384,
      DOCUMENT_REFERENCE_URL_BYTES: 2_048,
      DOCUMENT_REFERENCE_LABEL_BYTES: 256,
      PROJECTION_HTML_BYTES: 262_144,
      NOTES_GET_MARKDOWN_BYTES: 262_144,
      NOTES_QUERY_BYTES: 4_194_304,
      DOCUMENT_MARKDOWN_BYTES: 4_194_304,
      EDITOR_MARKDOWN_BYTES: 4_194_304,
      NOTES_READ_QUERY_BYTES: 4_194_304,
      NOTES_UNDO_CONTENT_BYTES: 4_194_304,
      UNDO_RECORD_BYTES: 65_536,
      UNDO_TOTAL_BYTES: 8_388_608,
    });
  });

  it("is what the enforcing modules actually use", () => {
    // Every assertion below reads a value exported by a module that enforces
    // the cap, so it fails if that module stops taking the value from the
    // registry. Comparing `SIZE_LIMITS.X` against `X` would assert nothing.
    expect(STAGE5_RPC_LIMITS.maxFrameBytes).toBe(SIZE_LIMITS.RPC_FRAME_BYTES);
    expect(STAGE5_RPC_LIMITS.maxResponseBytes).toBe(SIZE_LIMITS.RPC_RESPONSE_BYTES);
    expect(STAGE5_RPC_LIMITS.maxContentBytes).toBe(SIZE_LIMITS.RPC_CONTENT_BYTES);
    expect(STAGE5_RPC_LIMITS.maxQueryBytes).toBe(SIZE_LIMITS.RPC_QUERY_BYTES);
    expect(STAGE5_RPC_LIMITS.maxTitleBytes).toBe(SIZE_LIMITS.RPC_TITLE_BYTES);
    expect(STAGE5_RPC_LIMITS.maxIdentifierBytes).toBe(SIZE_LIMITS.RPC_IDENTIFIER_BYTES);
    expect(STAGE4_WRITE_LIMITS.maxContentBytes).toBe(SIZE_LIMITS.STORED_CONTENT_BYTES);
    expect(STAGE4_WRITE_LIMITS.maxFragmentBytes).toBe(SIZE_LIMITS.FRAGMENT_BYTES);
    expect(MAX_NOTE_DOCUMENT_NATIVE_BYTES).toBe(SIZE_LIMITS.NATIVE_DOCUMENT_BYTES);
    expect(MAX_NOTE_DOCUMENT_BLOCK_BYTES).toBe(SIZE_LIMITS.DOCUMENT_BLOCK_BYTES);
    expect(MAX_NOTE_DOCUMENT_INLINE_BYTES).toBe(SIZE_LIMITS.DOCUMENT_INLINE_BYTES);
    expect(MAX_NOTE_DOCUMENT_OPAQUE_SENTINEL_BYTES).toBe(
      SIZE_LIMITS.DOCUMENT_OPAQUE_SENTINEL_BYTES,
    );
    expect(MAX_NOTE_DOCUMENT_OPAQUE_TEXT_BYTES).toBe(SIZE_LIMITS.DOCUMENT_OPAQUE_TEXT_BYTES);
    expect(MAX_NOTE_DOCUMENT_OPAQUE_TEXT_TOTAL_BYTES).toBe(
      SIZE_LIMITS.DOCUMENT_OPAQUE_TEXT_TOTAL_BYTES,
    );
    expect(MAX_NOTE_DOCUMENT_REFERENCE_URL_BYTES).toBe(SIZE_LIMITS.DOCUMENT_REFERENCE_URL_BYTES);
    expect(MAX_NOTE_DOCUMENT_REFERENCE_LABEL_BYTES).toBe(
      SIZE_LIMITS.DOCUMENT_REFERENCE_LABEL_BYTES,
    );
    expect(MAX_NOTE_DOCUMENT_MARKDOWN_BYTES).toBe(SIZE_LIMITS.DOCUMENT_MARKDOWN_BYTES);
    expect(MAX_NOTES_GET_MARKDOWN_BYTES).toBe(SIZE_LIMITS.NOTES_GET_MARKDOWN_BYTES);
    expect(MAX_NOTES_QUERY_BYTES).toBe(SIZE_LIMITS.NOTES_QUERY_BYTES);
    expect(MAX_NOTES_READ_QUERY_BYTES).toBe(SIZE_LIMITS.NOTES_READ_QUERY_BYTES);
    expect(MAX_EDITOR_MARKDOWN_BYTES).toBe(SIZE_LIMITS.EDITOR_MARKDOWN_BYTES);
    expect(NOTES_UNDO_CONTENT_MAX_BYTES).toBe(SIZE_LIMITS.NOTES_UNDO_CONTENT_BYTES);
  });

  it("keeps the invariants that make the caps safe to reason about", () => {
    // Everything the bridge writes it can read back.
    expect(SIZE_LIMITS.STORED_CONTENT_BYTES).toBe(SIZE_LIMITS.STORED_CONTENT_READ_BYTES);
    // The content cap has to survive JSON escaping of the whole body plus the
    // rest of the envelope: 2x the body for escaping, and roughly 5 KiB of id,
    // revision, title and tag fields. This is the assertion that fails if the
    // cap is raised without raising the frame.
    expect(2 * SIZE_LIMITS.RPC_CONTENT_BYTES + 5_200).toBeLessThanOrEqual(SIZE_LIMITS.RPC_FRAME_BYTES);
    // The produced row is what the read side has to accept: anything the
    // bridge writes it must be able to read back.
    expect(SIZE_LIMITS.NATIVE_DOCUMENT_BYTES).toBeLessThanOrEqual(
      SIZE_LIMITS.STORED_CONTENT_READ_BYTES,
    );
    // The daemon store retains at least one maximum-size record.
    expect(SIZE_LIMITS.UNDO_TOTAL_BYTES).toBeGreaterThan(SIZE_LIMITS.UNDO_RECORD_BYTES);
    // Deliberately not asserted: that a response can carry a maximum-size
    // stored row. It cannot, which is why a large note is refused or paged
    // rather than returned whole.
  });

  it("defines named byte caps by import, not by literal", () => {
    // The risk this guards is a cap written as a literal in a module far from
    // the note-size work, so that a later change leaves it behind. Numbers
    // alone cannot tell a cap from a clone buffer, so the check is on
    // declarations named for bytes whose value is a literal; a definition that
    // reads from the registry evaluates to no number and is not a hit.
    //
    // Fixed-size primitives are not caps and are excluded by name: key, nonce,
    // tag, salt, hash and frame-prefix lengths are properties of a format.
    const fixedPrimitive = /(KEY|NONCE|TAG|SALT|HASH|DIGEST|IV|PREFIX)_?bytes$/i;
    const allowed = new Map([
      ["config/service-config.ts: SERVICE_CONFIG_MAX_BYTES", "the service config file, not note content"],
      [
        "core/note-document-version-claim.ts: MARKDOWN_VERSION_CLAIM_MAX_HEADER_BYTES",
        "the window scanned for the version header; it never refuses a note",
      ],
      ["core/note-document.ts: MAX_NOTE_DOCUMENT_OPAQUE_PAYLOAD_BYTES", "a policy zero, not a budget"],
      ["service/exact-note-path-resolver.ts: MAX_PATH_BYTES", "a path or title length, not a body"],
      ["operator/path-diagnostic.ts: MAX_PATH_BYTES", "a path length"],
      ["operator/locked-note-proof.ts: MAX_PATH_BYTES", "a path length"],
      ["mcp/nook-mcp-server.ts: NOOK_MCP_MAX_NOTE_PATH_BYTES", "a path length"],
      ["mcp/nook-mcp-server.ts: NOOK_MCP_MAX_REVISION_BYTES", "a revision id length"],
      ["settings/notebook-index.ts: MAX_ID_BYTES", "an id length"],
      ["operator/notes-production-runtime.ts: SOURCE_ID_MAX_BYTES", "an id length"],
      ["operator/notes-production-runtime.ts: HANDLE_PAYLOAD_MAX_BYTES", "a handle length"],
      ["cli.ts: MAX_UPLOAD_CONFIRMATION_BYTES", "a confirmation word length"],
      [
        "keystore/systemd-credential-keystore.ts: SYSTEMD_CREDENTIAL_MAX_BYTES",
        "a credential file read, not note content",
      ],
      ["service/operator-capabilities.ts: MAX_DIRECTORY_FILE_BYTES", "a passwd/group file read"],
      ["service/socket-group-resolver.ts: MAX_GROUP_FILE_BYTES", "a passwd/group file read"],
      ["service/peer-credentials.ts: MAX_HELPER_STDOUT_BYTES", "helper stdout, not note content"],
      ["service/operator-socket-server.ts: UNIX_SOCKET_PATH_MAX_BYTES", "a socket path length"],
      ["service/rpc-protocol.ts: PREFLIGHT_ARRAY_ENVELOPE_BYTES", "envelope overhead arithmetic"],
      [
        "service/rpc-protocol.ts: PREFLIGHT_ENVELOPE_OVERHEAD_BYTES",
        "envelope overhead arithmetic, not a body cap",
      ],
      [
        "service/nookd-server.ts: MAX_PAYLOAD_BYTES",
        "the frame payload bound: the registry frame minus its four-byte prefix",
      ],
      [
        "service/nookd-server.ts: MAX_PENDING_BYTES",
        "twice the wire frame: a per-connection read budget, not a note cap",
      ],
    ]);
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (resolve(file) === resolve(SRC, "core", "size-limits.ts")) continue;
      const ast = ts.createSourceFile(
        "scan.ts",
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        // Module consts, and the object members both published limit tables are
        // built from, plus class fields — the shapes a cap can hide in.
        let name: string | undefined;
        let initializer: ts.Expression | undefined;
        let isAssignment = false;
        // Module constants are SCREAMING_SNAKE. A camelCase `contentBytes` is
        // a field on a value object, not a cap, so properties are only checked
        // in the assignment shape below.
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          /^[A-Z][A-Z0-9_]*$/.test(node.name.text)
        ) {
          name = node.name.text;
          initializer = node.initializer;
        } else if (
          // `limitsTable.maxBodyBytes = 65_536;` — how both published limit
          // tables are built, and the shape a new cap would arrive in.
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) &&
          ts.isIdentifier(node.left.name)
        ) {
          name = node.left.name.text;
          initializer = node.right;
          isAssignment = true;
        }
        if (name !== undefined && initializer !== undefined) {
          // Both `MAX_FRAME_BYTES` and the camelCase `maxBodyBytes`. An
          // assignment also has to be named like a cap: `payload.contentBytes
          // = ...` is a value field, and both published tables use `max*`.
          const capShaped = !isAssignment || /^max/i.test(name);
          if (/bytes$/i.test(name) && capShaped && !fixedPrimitive.test(name)) {
            // A cap must BE an imported value. Anything else — a literal, a
            // derived product, a property read off another table — is a second
            // definition site, and a derived one is the shape that hid a
            // production 1 MiB cap from this check.
            if (ts.isIdentifier(initializer)) return;
            // Only numeric forms can be a rewritten cap; an object literal or a
            // call is configuration, not a budget.
            const numeric =
              ts.isBinaryExpression(initializer) ||
              ts.isPropertyAccessExpression(initializer) ||
              ts.isNumericLiteral(initializer) ||
              ts.isAsExpression(initializer) ||
              ts.isSatisfiesExpression(initializer);
            if (!numeric) return;
            const value = constantValue(initializer);
            if (value === 0) return; // a policy zero, not a size budget
            const key = `${file.slice(SRC.length + 1)}: ${name}`;
            if (!allowed.has(key)) {
              offenders.push(value === null ? `${key} = (derived)` : `${key} = ${value}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    expect(offenders).toEqual([]);
  });
});
