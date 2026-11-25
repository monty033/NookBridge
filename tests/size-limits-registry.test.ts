import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DOCUMENT_BLOCK_BYTES,
  MCP_MESSAGE_BYTES,
  NATIVE_DOCUMENT_BYTES,
  NOTES_VIEW_MARKDOWN_BYTES,
  OPERATOR_FRAME_BYTES,
  PROJECTION_HTML_BYTES,
  RPC_CONTENT_BYTES,
  RPC_FRAME_BYTES,
  RPC_RESPONSE_BYTES,
  SIZE_LIMITS,
  STORED_CONTENT_BYTES,
  UNDO_RECORD_BYTES,
  UNDO_TOTAL_BYTES,
} from "../src/core/size-limits.js";
import { MAX_NOTE_DOCUMENT_NATIVE_BYTES } from "../src/core/note-document-native.js";
import { MAX_NOTE_DOCUMENT_BLOCK_BYTES } from "../src/core/note-document.js";
import { STAGE4_WRITE_LIMITS } from "../src/core/notesnook-write-contract.js";
import { MAX_NOTES_VIEW_MARKDOWN_BYTES } from "../src/operator/notes-cli.js";
import { STAGE5_RPC_LIMITS } from "../src/service/rpc-protocol.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Remove comments so a limit explained in prose is not read as a definition. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
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
      MCP_MESSAGE_BYTES: 65_536,
      STORED_CONTENT_BYTES: 262_144,
      STORED_CONTENT_READ_BYTES: 262_144,
      NATIVE_DOCUMENT_BYTES: 262_144,
      DOCUMENT_BLOCK_BYTES: 65_536,
      PROJECTION_HTML_BYTES: 262_144,
      NOTES_VIEW_MARKDOWN_BYTES: 262_144,
      UNDO_RECORD_BYTES: 65_536,
      UNDO_TOTAL_BYTES: 8_388_608,
    });
  });

  it("is what the enforcing modules actually use", () => {
    expect(STAGE5_RPC_LIMITS.maxFrameBytes).toBe(RPC_FRAME_BYTES);
    expect(STAGE5_RPC_LIMITS.maxResponseBytes).toBe(RPC_RESPONSE_BYTES);
    expect(STAGE5_RPC_LIMITS.maxContentBytes).toBe(RPC_CONTENT_BYTES);
    expect(STAGE4_WRITE_LIMITS.maxContentBytes).toBe(STORED_CONTENT_BYTES);
    expect(MAX_NOTE_DOCUMENT_NATIVE_BYTES).toBe(NATIVE_DOCUMENT_BYTES);
    expect(MAX_NOTE_DOCUMENT_BLOCK_BYTES).toBe(DOCUMENT_BLOCK_BYTES);
    expect(MAX_NOTES_VIEW_MARKDOWN_BYTES).toBe(NOTES_VIEW_MARKDOWN_BYTES);
    // These three are consumed deep inside the transport and journal rather
    // than re-exported, so pin the registry entry itself.
    expect(SIZE_LIMITS.OPERATOR_FRAME_BYTES).toBe(OPERATOR_FRAME_BYTES);
    expect(SIZE_LIMITS.MCP_MESSAGE_BYTES).toBe(MCP_MESSAGE_BYTES);
    expect(SIZE_LIMITS.UNDO_RECORD_BYTES).toBe(UNDO_RECORD_BYTES);
    expect(SIZE_LIMITS.UNDO_TOTAL_BYTES).toBe(UNDO_TOTAL_BYTES);
  });

  it("is the only place a size literal appears in src/", () => {
    const patterns = [
      /\b65_536\b/,
      /\b65536\b/,
      /\b27_000\b/,
      /\b262_144\b/,
      /\b256\s*\*\s*1024\b/,
      /\b8\s*\*\s*1024\s*\*\s*1024\b/,
    ];
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith("/core/size-limits.ts")) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (patterns.some((pattern) => pattern.test(code))) {
        offenders.push(file.slice(SRC.length + 1));
      }
    }
    // Every limit moves together or not at all; a stray literal is a limit
    // that would be left behind by a future change.
    expect(offenders).toEqual([]);
  });

  it("keeps the content cap below the frame that carries it", () => {
    // The invariant, not the numbers: whatever the values become, a content
    // cap that exceeds its own frame can never be satisfied.
    expect(RPC_CONTENT_BYTES).toBeLessThan(RPC_FRAME_BYTES);
    expect(DOCUMENT_BLOCK_BYTES).toBeLessThanOrEqual(PROJECTION_HTML_BYTES);
  });
});
