import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  diagnoseExactNotePath,
  type ExactNotePathSource,
} from "../src/service/exact-note-path-resolver.js";
import {
  formatPathDiagnostic,
  runPathDiagnostic,
  type PathDiagnosticRuntime,
} from "../src/operator/path-diagnostic.js";

const revision = "rev_00000000000000000000000000000001";
const path = "General/Bernie Test Unlocked";

function makeSource(noteId = "unlocked"): ExactNotePathSource {
  return {
    notebooks: [{ id: "general", title: "General" }],
    findNotesByTitle: async (title) =>
      title === "Bernie Test Unlocked" ? [{ id: noteId, title, revision }] : [],
    findNoteIdsByNotebook: async () => [noteId],
    hasNoteInNotebook: async () => false,
    noteMetadata: async () => ({ id: noteId, title: "Bernie Test Unlocked", revision }),
  };
}

describe("read-only exact-path diagnostic", () => {
  it("distinguishes direct membership from recursive membership without exposing identifiers", async () => {
    await expect(diagnoseExactNotePath(path, makeSource())).resolves.toEqual({
      title: "one",
      notebook: "present",
      directMembership: "absent",
      recursiveMembership: "present",
      revision: "valid",
    });
  });

  it("short-circuits missing titles before hierarchy enumeration", async () => {
    let notebookCalls = 0;
    const source: ExactNotePathSource = {
      ...makeSource(),
      notebooks: [],
      findNotesByTitle: async () => [],
      findNoteIdsByNotebook: async () => {
        notebookCalls += 1;
        throw new Error("must not be called");
      },
    };
    await expect(diagnoseExactNotePath("General/Missing", source)).resolves.toEqual({
      title: "none",
      notebook: "not_applicable",
      directMembership: "not_applicable",
      recursiveMembership: "not_applicable",
      revision: "not_applicable",
    });
    expect(notebookCalls).toBe(0);
  });

  it("returns a frozen, redacted operator report", async () => {
    const runtime: PathDiagnosticRuntime = {
      pathDiagnostic: async (requestedPath) => ({
        kind: "path_diagnostic",
        pathBytes: Buffer.byteLength(requestedPath, "utf8"),
        title: "one",
        notebook: "present",
        directMembership: "present",
        recursiveMembership: "present",
        revision: "valid",
        contentType: "tiptap",
        htmlPrefix: "present",
        simpleChecklist: "absent",
        taskList: "absent",
        literalMarkdown: "absent",
      }),
    };
    const result = await runPathDiagnostic(path, runtime);
    expect(result).toEqual({
      pathBytes: Buffer.byteLength(path, "utf8"),
      title: "one",
      notebook: "present",
      directMembership: "present",
      recursiveMembership: "present",
      revision: "valid",
      contentType: "tiptap",
      htmlPrefix: "present",
      simpleChecklist: "absent",
      taskList: "absent",
      literalMarkdown: "absent",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(formatPathDiagnostic(result)).not.toContain(path);
    expect(Object.keys(result)).toEqual([
      "pathBytes",
      "title",
      "notebook",
      "directMembership",
      "recursiveMembership",
      "revision",
      "contentType",
      "htmlPrefix",
      "simpleChecklist",
      "taskList",
      "literalMarkdown",
    ]);
  });

  it("fails closed without calling the runtime for invalid paths", async () => {
    let calls = 0;
    const runtime: PathDiagnosticRuntime = {
      pathDiagnostic: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    };
    await expect(runPathDiagnostic("", runtime)).resolves.toMatchObject({
      title: "unavailable",
    });
    await expect(runPathDiagnostic("x".repeat(513), runtime)).resolves.toMatchObject({
      title: "unavailable",
    });
    await expect(runPathDiagnostic("bad\u0000path", runtime)).resolves.toMatchObject({
      title: "unavailable",
    });
    expect(calls).toBe(0);
  });
});
