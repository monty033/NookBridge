import { describe, expect, it } from "vitest";
import { parseNotesSearchQuery } from "../src/operator/notes-cli.js";
import { STAGE5_RPC_LIMITS } from "../src/service/rpc-protocol.js";

/**
 * A piped query always arrives with the shell's line terminator.  The daemon
 * treats a control character in the query as a protocol fault and closes the
 * connection without replying, which the client reports as an unavailable
 * service — so before this was handled, every `printf '%s\n' q | nookctl
 * notes search --stdin` failed with a generic error while browse worked.
 */
describe("notes search query: the line terminator a pipe adds", () => {
  it("accepts a query with the trailing newline printf adds", () => {
    expect(parseNotesSearchQuery("Roux\n")).toEqual({ kind: "query", query: "Roux" });
  });

  it("accepts a query with a CRLF terminator", () => {
    expect(parseNotesSearchQuery("Roux\r\n")).toEqual({ kind: "query", query: "Roux" });
  });

  it("still refuses an embedded newline", () => {
    expect(parseNotesSearchQuery("Roux\nSports")).toEqual({ kind: "invalid" });
  });

  it("removes exactly one terminator, not a run of them", () => {
    // Two newlines means the operator sent an empty second line; that is not
    // the same query, so it is refused rather than silently truncated.
    expect(parseNotesSearchQuery("Roux\n\n")).toEqual({ kind: "invalid" });
  });

  it("still refuses a query that is empty once the terminator is gone", () => {
    expect(parseNotesSearchQuery("\n")).toEqual({ kind: "invalid" });
    expect(parseNotesSearchQuery("")).toEqual({ kind: "invalid" });
  });

  it("refuses a query that is only whitespace", () => {
    // Stricter than the daemon, deliberately: the daemon only refuses an
    // empty query, so whitespace would reach the search engine. A blank query
    // that returns everything reads to the operator as a hit rather than a
    // mistake, so the CLI refuses it instead of forwarding it.
    expect(parseNotesSearchQuery("   \n")).toEqual({ kind: "invalid" });
    expect(parseNotesSearchQuery(" \t \n")).toEqual({ kind: "invalid" });
  });

  it("still refuses any other control character", () => {
    expect(parseNotesSearchQuery("Roux\u0000")).toEqual({ kind: "invalid" });
    expect(parseNotesSearchQuery("Roux\tSports\n")).toEqual({ kind: "invalid" });
  });

  it("keeps the query otherwise byte-identical", () => {
    expect(parseNotesSearchQuery("  Roux Sports  \n")).toEqual({
      kind: "query",
      query: "  Roux Sports  ",
    });
  });

  it("enforces the daemon's query bound, not just the stdin bound", () => {
    // A query the daemon would reject by destroying the connection must never
    // leave the CLI: the operator would see a generic error instead of a
    // refusal they can act on.
    const atBound = "x".repeat(STAGE5_RPC_LIMITS.maxQueryBytes);
    const overBound = "x".repeat(STAGE5_RPC_LIMITS.maxQueryBytes + 1);
    expect(parseNotesSearchQuery(`${atBound}\n`)).toEqual({ kind: "query", query: atBound });
    expect(parseNotesSearchQuery(`${overBound}\n`)).toEqual({ kind: "invalid" });
  });

  it("counts bytes, not characters, against that bound", () => {
    // "é" is two UTF-8 bytes: half as many characters still fills the bound.
    const multiByte = "é".repeat(STAGE5_RPC_LIMITS.maxQueryBytes / 2);
    expect(parseNotesSearchQuery(`${multiByte}\n`)).toEqual({ kind: "query", query: multiByte });
    expect(parseNotesSearchQuery(`${multiByte}é\n`)).toEqual({ kind: "invalid" });
  });
});
