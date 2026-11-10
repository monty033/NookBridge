/**
 * EA-2 — `nookctl notes edit-census`, the client for `notes.edit-census`.
 *
 * Synthetic fixtures only: the operator socket is a recording fake and the
 * dispatcher runs against an injected runtime.  No daemon, account, sync,
 * authentication or `var/` state is touched.
 *
 * The census is read-only and ungated like `browse`/`get`, prints counts
 * only, echoes only the opaque handle it was given for a scoped call, and
 * turns a refused or malformed response into an error, never a zeroed census.
 */

import process from "node:process";
import { Buffer } from "node:buffer";

import { afterEach, describe, expect, it } from "vitest";

import { run, _internal } from "../src/cli.js";
import {
  APPROVE_EDIT_FLAG,
  formatNotesHelp,
  formatNotesResult,
  parseNotesCommand,
  runNotesCommand,
  type NotesCategoricalResult,
  type NotesCommandRuntime,
} from "../src/operator/notes-cli.js";
import { createNotesCommandRuntimeFromOperatorSocket } from "../src/operator/notes-production-runtime.js";
import type { OperatorSocketResult } from "../src/operator/operator-socket-client.js";
import { MAX_EDIT_CENSUS_NOTES_PER_RUN } from "../src/service/notes-edit-census.js";
import type { RpcNotesEditCensusResult } from "../src/service/rpc-protocol.js";

const HANDLE = `h_${"Cn5u".repeat(6)}`;
const OTHER_HANDLE = `h_${"Zz9y".repeat(6)}`;
const TITLE_SENTINEL = "TITLE_SENTINEL_do_not_print";

/** A truncated corpus census with distinct, invariant-satisfying counts. */
const CORPUS: RpcNotesEditCensusResult = {
  kind: "edit-census",
  scope: "corpus",
  total: MAX_EDIT_CENSUS_NOTES_PER_RUN,
  reasons: { hostile: 1, uninterpretable: 2, limit: 1, unclassified: 1 },
  editRefusals: 0,
  serializationRefusals: {
    malformed_link: 2,
    unsupported_mark: 1,
    invalid_shape: 1,
    unclassified: 1,
  },
  serializationFallbackWithPreserved: 1,
  projection: {
    strict: MAX_EDIT_CENSUS_NOTES_PER_RUN - 20,
    strictWithPreservedBlocks: 6,
    opaqueHeadingFallback: 3,
    serializerFallback: 5,
    locked: 2,
    oversize: 1,
    unavailable: 3,
  },
  preservedBlocks: 11,
  preservedTaskLists: 4,
  cap: MAX_EDIT_CENSUS_NOTES_PER_RUN,
  skipped: 37,
  truncated: true,
};

const NOTE: RpcNotesEditCensusResult = {
  kind: "edit-census",
  scope: "note",
  note: HANDLE,
  total: 1,
  reasons: { hostile: 0, uninterpretable: 0, limit: 0, unclassified: 0 },
  editRefusals: 0,
  serializationRefusals: {},
  serializationFallbackWithPreserved: 0,
  projection: {
    strict: 0,
    strictWithPreservedBlocks: 1,
    opaqueHeadingFallback: 0,
    serializerFallback: 0,
    locked: 0,
    oversize: 0,
    unavailable: 0,
  },
  preservedBlocks: 2,
  preservedTaskLists: 1,
  cap: MAX_EDIT_CENSUS_NOTES_PER_RUN,
  skipped: 0,
  truncated: false,
};

/** An empty visible corpus: zeros are legitimate only when the wire says so. */
const EMPTY_CORPUS: RpcNotesEditCensusResult = {
  ...CORPUS,
  total: 0,
  reasons: { hostile: 0, uninterpretable: 0, limit: 0, unclassified: 0 },
  serializationRefusals: {},
  serializationFallbackWithPreserved: 0,
  projection: {
    strict: 0,
    strictWithPreservedBlocks: 0,
    opaqueHeadingFallback: 0,
    serializerFallback: 0,
    locked: 0,
    oversize: 0,
    unavailable: 0,
  },
  preservedBlocks: 0,
  preservedTaskLists: 0,
  skipped: 0,
  truncated: false,
};

const { skipped: _skipped, ...CORPUS_WITHOUT_SKIPPED } = CORPUS;
void _skipped;

const CORPUS_OUTPUT = [
  "nookctl notes: edit-census",
  "scope: corpus",
  "total: 500",
  "projection-strict: 480",
  "projection-strict-with-preserved-blocks: 6",
  "projection-opaque-heading-fallback: 3",
  "projection-serializer-fallback: 5",
  "projection-locked: 2",
  "projection-oversize: 1",
  "projection-unavailable: 3",
  "class-hostile: 1",
  "class-uninterpretable: 2",
  "class-limit: 1",
  "class-unclassified: 1",
  "edit-refusals: 0",
  "serializer-refusals: 5",
  "serializer-refusal-invalid-shape: 1",
  "serializer-refusal-malformed-link: 2",
  "serializer-refusal-unclassified: 1",
  "serializer-refusal-unsupported-mark: 1",
  "serializer-fallback-with-preserved: 1",
  "preserved-blocks: 11",
  "preserved-task-lists: 4",
  "cap: 500",
  "skipped: 37",
  "truncated: yes",
  "",
].join("\n");

const NOTE_OUTPUT = [
  "nookctl notes: edit-census",
  "scope: note",
  `handle: ${HANDLE}`,
  "total: 1",
  "projection-strict: 0",
  "projection-strict-with-preserved-blocks: 1",
  "projection-opaque-heading-fallback: 0",
  "projection-serializer-fallback: 0",
  "projection-locked: 0",
  "projection-oversize: 0",
  "projection-unavailable: 0",
  "class-hostile: 0",
  "class-uninterpretable: 0",
  "class-limit: 0",
  "class-unclassified: 0",
  "edit-refusals: 0",
  "serializer-refusals: 0",
  "serializer-fallback-with-preserved: 0",
  "preserved-blocks: 2",
  "preserved-task-lists: 1",
  "cap: 500",
  "skipped: 0",
  "truncated: no",
  "",
].join("\n");

/** The closed serializer-refusal codes, in the kebab form the CLI prints. */
const SERIALIZATION_REFUSAL_CODE_KEYS: readonly string[] = [
  "invalid-shape",
  "oversize-document",
  "oversize-block",
  "oversize-inline",
  "oversize-sentinel",
  "depth-exceeded",
  "unsupported-node",
  "unsupported-list-kind",
  "unsupported-mark",
  "unsupported-callout-variant",
  "opaque-payload-forbidden",
  "malformed-link",
  "table-column-mismatch",
  "invalid-reference-url",
  "unclassified",
];

/**
 * The exact vocabulary the census may print. A permissive "some key: some
 * number" rule would accept a leaked count-shaped field such as
 * `title-bytes: 42`, so the keys are enumerated: a new line fails here until
 * someone adds it deliberately.
 */
const CENSUS_KEYS: readonly string[] = [
  "total",
  "cap",
  "skipped",
  "edit-refusals",
  "serializer-refusals",
  "serializer-fallback-with-preserved",
  "preserved-blocks",
  "preserved-task-lists",
  "projection-strict",
  "projection-strict-with-preserved-blocks",
  "projection-opaque-heading-fallback",
  "projection-serializer-fallback",
  "projection-locked",
  "projection-oversize",
  "projection-unavailable",
  "class-hostile",
  "class-uninterpretable",
  "class-limit",
  "class-unclassified",
];

/** Every line is the banner, the scope, the given handle, or an enumerated count. */
function expectCountsOnly(output: string, handle?: string): void {
  for (const line of output.trimEnd().split("\n")) {
    if (
      line === "nookctl notes: edit-census" ||
      line === "scope: corpus" ||
      line === "scope: note" ||
      (handle !== undefined && line === `handle: ${handle}`) ||
      line === "truncated: yes" ||
      line === "truncated: no"
    ) {
      continue;
    }
    const match = /^([a-z-]+): (\d+)$/.exec(line);
    expect(match, line).not.toBeNull();
    if (match === null) continue;
    // A per-code line names one of the closed serializer-refusal codes.
    const key = match[1] ?? "";
    if (key.startsWith("serializer-refusal-")) {
      expect(SERIALIZATION_REFUSAL_CODE_KEYS, line).toContain(
        key.slice("serializer-refusal-".length),
      );
      continue;
    }
    expect(CENSUS_KEYS, line).toContain(key);
  }
}

type Call = { method: string; params: Record<string, unknown> };

function socket(response: OperatorSocketResult | (() => Promise<OperatorSocketResult>)) {
  const calls: Call[] = [];
  const runtime = createNotesCommandRuntimeFromOperatorSocket({
    request: async (method, params) => {
      calls.push({ method, params });
      return typeof response === "function" ? await response() : response;
    },
  });
  return { calls, runtime };
}

const ok = (result: unknown): OperatorSocketResult =>
  ({ ok: true, result }) as unknown as OperatorSocketResult;

async function driveCli(argv: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await run(["node", "nookctl", ...argv]);
    return { stdout, stderr, code };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

function installRuntime(runtime: NotesCommandRuntime): { constructed: () => number } {
  let count = 0;
  (_internal as { notesRuntimeFactory?: () => NotesCommandRuntime }).notesRuntimeFactory = () => {
    count += 1;
    return runtime;
  };
  return { constructed: () => count };
}

afterEach(() => {
  delete (_internal as { notesRuntimeFactory?: unknown }).notesRuntimeFactory;
});

// ---------------------------------------------------------------------------
// Parser.
// ---------------------------------------------------------------------------

describe("parseNotesCommand — `notes edit-census`", () => {
  it("parses the bare corpus census with no handle", () => {
    expect(parseNotesCommand(["edit-census"], {})).toEqual({
      kind: "parsed",
      command: { kind: "edit-census", subcommand: "edit-census" },
    });
  });

  it("parses the scoped census with exactly the given opaque handle", () => {
    expect(parseNotesCommand(["edit-census", "--handle", HANDLE], {})).toEqual({
      kind: "parsed",
      command: { kind: "edit-census", subcommand: "edit-census", handle: HANDLE },
    });
  });

  it.each([
    ["--stdin", ["--stdin"]],
    ["--stdin with a handle", ["--handle", HANDLE, "--stdin"]],
    ["the approval flag", [APPROVE_EDIT_FLAG]],
    ["an unknown flag", ["--verbose"]],
    ["an extra positional", ["corpus"]],
    ["a duplicate handle", ["--handle", HANDLE, "--handle", OTHER_HANDLE]],
    ["a missing handle value", ["--handle"]],
    ["a flag-shaped handle value", ["--handle", "--stdin"]],
    ["a path-shaped handle", ["--handle", "/etc/passwd"]],
    ["a revision-shaped handle", ["--handle", `rev_${"a".repeat(32)}`]],
  ])("refuses %s", (_label, rest) => {
    const census = parseNotesCommand(["edit-census", ...rest], {});
    expect(census).toEqual({
      kind: "error",
      exitCode: 2,
      message: "nookctl notes: invalid command input",
    });
  });

  it("refuses a forbidden carrier before anything else", () => {
    const result = parseNotesCommand(["edit-census", "--title", "x"], {});
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
  });

  it("is listed in the help text as a read-only subcommand", () => {
    const help = formatNotesHelp();
    expect(help).toContain("nookctl notes edit-census [--handle <opaque-handle>]");
    expect(help).toMatch(/edit-census .*\(read-only\)/);
  });
});

// ---------------------------------------------------------------------------
// Operator socket seam.
// ---------------------------------------------------------------------------

describe("operator socket edit-census mapping", () => {
  it("sends an empty corpus request and maps every count", async () => {
    const { calls, runtime } = socket(ok(CORPUS));
    const result = await runtime.editCensus!({});
    expect(calls).toEqual([{ method: "notes.edit-census", params: {} }]);
    expect(formatNotesResult(result, "edit-census")).toBe(CORPUS_OUTPUT);
  });

  it("sends only the opaque handle, as `id`, for a scoped census", async () => {
    const { calls, runtime } = socket(ok(NOTE));
    const result = await runtime.editCensus!({ handle: HANDLE });
    expect(calls).toEqual([{ method: "notes.edit-census", params: { id: HANDLE } }]);
    expect(formatNotesResult(result, "edit-census")).toBe(NOTE_OUTPUT);
  });

  it("prints a genuinely empty corpus as zeros", async () => {
    const { runtime } = socket(ok(EMPTY_CORPUS));
    const printed = formatNotesResult(await runtime.editCensus!({}), "edit-census");
    expect(printed).toContain("total: 0\n");
    expect(printed).toContain("cap: 500\n");
    expect(printed).toContain("truncated: no\n");
    expectCountsOnly(printed);
  });

  it.each([
    ["not_found", { kind: "missing" }],
    ["permission_denied", { kind: "denied" }],
    ["invalid_request", { kind: "invalid-input" }],
    [
      "service_unavailable",
      {
        kind: "error",
        message: "nookctl notes: runtime unavailable",
        exitCode: 3,
        reason: "service_unavailable",
      },
    ],
  ] as const)("maps a refused %s like browse does", async (code, expected) => {
    const { runtime } = socket({ ok: false, code });
    await expect(runtime.editCensus!({ handle: HANDLE })).resolves.toEqual(expected);
    await expect(runtime.browse({})).resolves.toEqual(expected);
  });

  it("collapses a thrown transport failure to service_unavailable without detail", async () => {
    const { runtime } = socket(async () => {
      throw new Error(`/private/path ${TITLE_SENTINEL}`);
    });
    const result = await runtime.editCensus!({});
    expect(result).toMatchObject({ kind: "error", reason: "service_unavailable" });
    expect(JSON.stringify(result)).not.toContain(TITLE_SENTINEL);
  });

  const malformed: ReadonlyArray<readonly [string, unknown, string | undefined]> = [
    [
      "another command's success shape",
      { kind: "operator-page", notes: [], next: null },
      undefined,
    ],
    ["a stray title field", { ...CORPUS, title: TITLE_SENTINEL }, undefined],
    [
      "an individual reason name",
      { ...CORPUS, reasons: { ...CORPUS.reasons, unknownNodeType: 1 } },
      undefined,
    ],
    ["a missing field", CORPUS_WITHOUT_SKIPPED, undefined],
    ["a non-integer count", { ...CORPUS, preservedBlocks: 1.5 }, undefined],
    ["a negative count", { ...CORPUS, editRefusals: -1 }, undefined],
    ["a string count", { ...CORPUS, total: "500" }, undefined],
    ["a projection that does not partition total", { ...CORPUS, total: 499 }, undefined],
    ["skipped without truncated", { ...CORPUS, truncated: false }, undefined],
    ["more task lists than blocks", { ...CORPUS, preservedTaskLists: 12 }, undefined],
    ["a zero cap", { ...EMPTY_CORPUS, cap: 0 }, undefined],
    ["a note scope for a corpus request", NOTE, undefined],
    ["a corpus scope for a scoped request", CORPUS, HANDLE],
    ["a different echoed handle", { ...NOTE, note: OTHER_HANDLE }, HANDLE],
    ["a scoped result without its handle", { ...CORPUS, scope: "note" }, HANDLE],
  ];

  it.each(malformed)("rejects %s as invalid_response", async (_label, wire, handle) => {
    const { runtime } = socket(ok(wire));
    const result = await runtime.editCensus!(handle === undefined ? {} : { handle });
    expect(result).toEqual({
      kind: "error",
      message: "nookctl notes: runtime unavailable",
      exitCode: 3,
      reason: "invalid_response",
    });
    const printed = formatNotesResult(result, "edit-census");
    expect(printed).toBe("nookctl notes: invalid_response\n");
    expect(printed).not.toContain("total");
  });
});

// ---------------------------------------------------------------------------
// Runner and formatter, independent of the socket seam.
// ---------------------------------------------------------------------------

describe("runNotesCommand — `notes edit-census`", () => {
  const runCensus = (argv: readonly string[], runtime: Partial<NotesCommandRuntime>) =>
    runNotesCommand({
      argv,
      env: {},
      createRuntime: () => runtime as NotesCommandRuntime,
    });

  it("passes no handle for the corpus and only the handle for a scoped call", async () => {
    const seen: unknown[] = [];
    const runtime: Partial<NotesCommandRuntime> = {
      editCensus: async (command) => {
        seen.push(command);
        return command.handle === undefined
          ? await socket(ok(CORPUS)).runtime.editCensus!({})
          : await socket(ok(NOTE)).runtime.editCensus!({ handle: command.handle });
      },
    };
    await expect(runCensus(["edit-census"], runtime)).resolves.toMatchObject({
      kind: "edit-census",
    });
    await expect(runCensus(["edit-census", "--handle", HANDLE], runtime)).resolves.toMatchObject({
      kind: "edit-census",
      census: { scope: "note", handle: HANDLE },
    });
    expect(seen).toEqual([{}, { handle: HANDLE }]);
  });

  it("never constructs a runtime for a refused invocation", async () => {
    let constructed = 0;
    const result = await runNotesCommand({
      argv: ["edit-census", "--stdin"],
      env: {},
      createRuntime: () => {
        constructed += 1;
        return {} as NotesCommandRuntime;
      },
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    expect(constructed).toBe(0);
  });

  it("reports service_unavailable for a runtime without the census", async () => {
    await expect(runCensus(["edit-census"], {})).resolves.toMatchObject({
      kind: "error",
      exitCode: 3,
      reason: "service_unavailable",
    });
  });

  it.each([
    ["another command's success", { kind: "updated" }, ["edit-census"]],
    [
      "a census for another handle",
      {
        kind: "edit-census",
        census: {
          scope: "note",
          handle: OTHER_HANDLE,
          total: 0,
          classes: { hostile: 0, uninterpretable: 0, limit: 0, unclassified: 0 },
          editRefusals: 0,
          projection: {
            strict: 0,
            strictWithPreservedBlocks: 0,
            opaqueHeadingFallback: 0,
            serializerFallback: 0,
            locked: 0,
            oversize: 0,
            unavailable: 0,
          },
          preservedBlocks: 0,
          preservedTaskLists: 0,
          cap: 1,
          skipped: 0,
          truncated: false,
        },
      },
      ["edit-census", "--handle", HANDLE],
    ],
    [
      "a census with a smuggled field",
      { kind: "edit-census", census: { scope: "corpus", title: TITLE_SENTINEL } },
      ["edit-census"],
    ],
  ] as const)("refuses %s from an injected runtime", async (_label, returned, argv) => {
    const result = await runCensus(argv, {
      editCensus: async () => returned as unknown as NotesCategoricalResult,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 3, reason: "invalid_response" });
  });

  it("formats a malformed census handed straight to the formatter as an error", async () => {
    const valid = await socket(ok(EMPTY_CORPUS)).runtime.editCensus!({});
    if (valid.kind !== "edit-census") throw new Error("expected a census");
    // Every field present and printable; only the partition invariant fails.
    const unpartitioned = {
      kind: "edit-census",
      census: { ...valid.census, total: 3 },
    } as NotesCategoricalResult;
    expect(formatNotesResult(unpartitioned, "edit-census")).toBe("nookctl notes: error\n");
    // A handle on a corpus census is not printable either.
    const smuggled = {
      kind: "edit-census",
      census: { ...valid.census, handle: HANDLE },
    } as NotesCategoricalResult;
    expect(formatNotesResult(smuggled, "edit-census")).toBe("nookctl notes: error\n");
  });
});

// ---------------------------------------------------------------------------
// Dispatcher (`nookctl notes edit-census ...`) end to end over a fake socket.
// ---------------------------------------------------------------------------

describe("nookctl notes edit-census — dispatcher", () => {
  it("prints the corpus census, counts only, and exits 0", async () => {
    installRuntime(socket(ok(CORPUS)).runtime);
    const out = await driveCli(["notes", "edit-census"]);
    expect(out).toEqual({ stdout: CORPUS_OUTPUT, stderr: "", code: 0 });
    expectCountsOnly(out.stdout);
  });

  it("prints the scoped census, echoing only the given handle", async () => {
    installRuntime(socket(ok(NOTE)).runtime);
    const out = await driveCli(["notes", "edit-census", "--handle", HANDLE]);
    expect(out).toEqual({ stdout: NOTE_OUTPUT, stderr: "", code: 0 });
    expectCountsOnly(out.stdout, HANDLE);
  });

  it("refuses --stdin and an unknown flag before constructing a runtime", async () => {
    const probe = installRuntime(socket(ok(CORPUS)).runtime);
    for (const extra of [["--stdin"], ["--verbose"], [APPROVE_EDIT_FLAG]]) {
      const out = await driveCli(["notes", "edit-census", ...extra]);
      expect(out).toEqual({
        stdout: "",
        stderr: "nookctl: nookctl notes: invalid command input\n",
        code: 2,
      });
    }
    expect(probe.constructed()).toBe(0);
  });

  it("surfaces a malformed response as invalid_response, never a zeroed census", async () => {
    installRuntime(socket(ok({ ...CORPUS, title: TITLE_SENTINEL })).runtime);
    const out = await driveCli(["notes", "edit-census"]);
    expect(out).toEqual({ stdout: "nookctl notes: invalid_response\n", stderr: "", code: 3 });
  });

  it("surfaces a refused response with the browse reason vocabulary", async () => {
    installRuntime(socket({ ok: false, code: "service_unavailable" }).runtime);
    expect(await driveCli(["notes", "edit-census"])).toEqual({
      stdout: "nookctl notes: service_unavailable\n",
      stderr: "",
      code: 3,
    });
    installRuntime(socket({ ok: false, code: "not_found" }).runtime);
    expect(await driveCli(["notes", "edit-census", "--handle", HANDLE])).toEqual({
      stdout: "nookctl notes: missing\n",
      stderr: "",
      code: 4,
    });
  });
});
