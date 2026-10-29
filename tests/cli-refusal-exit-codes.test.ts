import { Buffer } from "node:buffer";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { _internal, run } from "../src/cli.js";

const HANDLE = "not_abc1234";

async function drive(argv: readonly string[]): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await run(["node", "nookctl", ...argv]), stdout };
  } finally {
    process.stdout.write = write;
  }
}

function notesRuntime(result: { kind: string }): void {
  const answer = async () => result;
  (_internal as { notesRuntimeFactory?: () => unknown }).notesRuntimeFactory = () => ({
    browse: answer,
    search: answer,
    get: answer,
    edit: answer,
    undo: answer,
  });
}

afterEach(() => {
  delete (_internal as { notesRuntimeFactory?: unknown }).notesRuntimeFactory;
  delete _internal.treeRuntimeFactory;
});

describe("nookctl refusal exit codes", () => {
  it.each(["denied", "locked", "missing", "conflict"])(
    "notes browse exits 4 when the runtime answers %s",
    async (kind) => {
      notesRuntime({ kind });
      const out = await drive(["notes", "browse"]);
      expect(out.stdout).toBe(`nookctl notes: ${kind}\n`);
      expect(out.code).toBe(4);
    },
  );

  it("notes get exits 4 on a refusal", async () => {
    notesRuntime({ kind: "denied" });
    const out = await drive(["notes", "get", "--handle", HANDLE]);
    expect(out.stdout).toBe("nookctl notes: denied\n");
    expect(out.code).toBe(4);
  });

  it("approve-upload without a TTY is invalid input, not a refusal", async () => {
    notesRuntime({ kind: "nothing-to-approve" });
    const out = await drive(["notes", "approve-upload"]);
    expect(out.stdout).toBe("nookctl notes: invalid-input\n");
    expect(out.code).toBe(2);
  });

  it("an empty result is not a refusal and still exits 0", async () => {
    notesRuntime({ kind: "empty" });
    const out = await drive(["notes", "browse"]);
    expect(out.stdout).toBe("nookctl notes: empty\n");
    expect(out.code).toBe(0);
  });

  it("invalid input keeps its own exit code 2", async () => {
    notesRuntime({ kind: "invalid-input" });
    expect((await drive(["notes", "browse"])).code).toBe(2);
  });

  it("tree invalid input keeps exit code 2", async () => {
    _internal.treeRuntimeFactory = () =>
      ({ list: async () => ({ kind: "invalid-input" }) }) as never;
    const out = await drive(["tree", "list"]);
    expect(out.stdout).toBe("nookctl tree: invalid-input\n");
    expect(out.code).toBe(2);
  });

  it("tree empty is not a refusal and exits 0", async () => {
    _internal.treeRuntimeFactory = () => ({ list: async () => ({ kind: "empty" }) }) as never;
    expect((await drive(["tree", "list"])).code).toBe(0);
  });

  it.each(["denied", "locked", "missing"])("tree list exits 4 on %s", async (kind) => {
    _internal.treeRuntimeFactory = () => ({ list: async () => ({ kind }) }) as never;
    const out = await drive(["tree", "list"]);
    expect(out.stdout).toBe(`nookctl tree: ${kind}\n`);
    expect(out.code).toBe(4);
  });
});
