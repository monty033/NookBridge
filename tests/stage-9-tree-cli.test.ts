import { Buffer } from "node:buffer";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { run, _internal } from "../src/cli.js";
import {
  formatTreeResult,
  parseTreeCommand,
  runTreeCommand,
  type TreeCommandRuntime,
  type TreeResult,
} from "../src/operator/tree-cli.js";
import { createTreeRuntime } from "../src/operator/tree-runtime.js";

const fixtures: string[] = [];
function fixture(): string {
  const path = mkdtempSync(join(tmpdir(), "nookbridge-tree-"));
  fixtures.push(path);
  return path;
}
function env(): Record<string, string | undefined> {
  return {};
}
function page(result: TreeResult) {
  if (result.kind !== "page") throw new Error(`expected page, got ${result.kind}`);
  return result;
}
function captureStdout<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  return fn()
    .then((value) => ({ value, stdout, stderr }))
    .finally(() => {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    });
}

afterEach(() => {
  delete _internal.treeRuntimeFactory;
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("tree parser", () => {
  it("accepts help, root list, and bounded child pagination", () => {
    expect(parseTreeCommand(["help"], env()).kind).toBe("parsed");
    expect(parseTreeCommand(["list"], env())).toMatchObject({
      kind: "parsed",
      command: { limit: 50 },
    });
    expect(
      parseTreeCommand(
        [
          "list",
          "--handle",
          "st_0123456789abcdef",
          "--cursor",
          "crs_0123456789abcdef",
          "--limit",
          "100",
        ],
        env(),
      ),
    ).toMatchObject({ kind: "parsed", command: { limit: 100 } });
  });

  it("rejects paths, cursor-without-handle, duplicate flags, and out-of-range limits", () => {
    for (const argv of [
      ["list", "--path", "/etc"],
      ["list", "--cursor", "crs_0123456789abcdef"],
      ["list", "--limit", "0"],
      ["list", "--limit", "101"],
      ["list", "--limit", "1", "--limit", "2"],
      ["list", "--handle", "../secret"],
    ])
      expect(parseTreeCommand(argv, env()).kind).toBe("error");
  });

  it("rejects secret carriers by presence without reading their values", () => {
    expect(parseTreeCommand(["list"], { NOOKBRIDGE_PASSWORD: undefined }).kind).toBe("error");
    expect(parseTreeCommand(["list", "--token=secret"], env()).kind).toBe("error");
  });
});

describe("tree runtime", () => {
  it("returns only the virtual root and never exposes artifact names", async () => {
    const root = fixture();
    mkdirSync(join(root, ".d"));
    writeFileSync(join(root, "nookbridge.db"), "private");
    writeFileSync(join(root, "credentials.json"), "private");
    const quarantine = join(root, ".recovery-quarantine");
    mkdirSync(quarantine);
    mkdirSync(join(quarantine, "deadbeef-abcdefghijkl"));

    const runtime = createTreeRuntime();
    const rootPage = page(await runtime.list({ stateDir: root, limit: 100 }));
    expect(rootPage.entries).toHaveLength(1);
    expect(rootPage.entries[0]).toMatchObject({ kind: "state-root", label: "state-root" });
    expect(rootPage.entries[0]?.handle).not.toContain(root);
    expect(
      (
        await runtime.list({
          stateDir: root,
          handle: "st_ffffffffffffffff",
          limit: 100,
        })
      ).kind,
    ).toBe("invalid-input");

    const children = page(
      await runtime.list({ stateDir: root, handle: rootPage.entries[0]?.handle ?? "", limit: 100 }),
    );
    expect(children.entries.some((entry) => entry.kind === "quarantine-root")).toBe(true);
    expect(
      children.entries.every(
        (entry) => !entry.label.includes("db") && !entry.label.includes("credential"),
      ),
    ).toBe(true);
    const firstChildPage = page(
      await runtime.list({ stateDir: root, handle: rootPage.entries[0]?.handle ?? "", limit: 1 }),
    );
    expect(firstChildPage.next).not.toBeNull();
    const nextChildPage = page(
      await runtime.list({
        stateDir: root,
        handle: rootPage.entries[0]?.handle ?? "",
        ...(firstChildPage.next === null ? {} : { cursor: firstChildPage.next }),
        limit: 1,
      }),
    );
    expect(nextChildPage.entries).toHaveLength(1);
  });

  it("uses opaque quarantine handles and cursor pagination", async () => {
    const root = fixture();
    const quarantine = join(root, ".recovery-quarantine");
    mkdirSync(quarantine);
    mkdirSync(join(quarantine, "deadbeef-abcdefghijkl"));
    mkdirSync(join(quarantine, "cafebabe-mnopqrstuvwx"));
    const runtime = createTreeRuntime();
    const rootPage = page(await runtime.list({ stateDir: root, limit: 100 }));
    const state = rootPage.entries[0]?.handle;
    if (state === null || state === undefined) throw new Error("expected state handle");
    const stateChildren = page(await runtime.list({ stateDir: root, handle: state, limit: 100 }));
    const quarantineHandle = stateChildren.entries.find(
      (entry) => entry.kind === "quarantine-root",
    )?.handle;
    if (quarantineHandle === null || quarantineHandle === undefined)
      throw new Error("expected quarantine handle");
    const first = page(await runtime.list({ stateDir: root, handle: quarantineHandle, limit: 1 }));
    expect(first.next).not.toBeNull();
    const second = page(
      await runtime.list({
        stateDir: root,
        handle: quarantineHandle,
        ...(first.next === null ? {} : { cursor: first.next }),
        limit: 1,
      }),
    );
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]?.handle).not.toBe(first.entries[0]?.handle);
  });

  it("fails closed for missing, symlink, non-directory, and locked roots", async () => {
    const runtime = createTreeRuntime();
    expect(
      (await runtime.list({ stateDir: join(tmpdir(), "does-not-exist-nookbridge-tree"), limit: 1 }))
        .kind,
    ).toBe("missing");
    const file = join(fixture(), "state-file");
    writeFileSync(file, "not a directory");
    expect((await runtime.list({ stateDir: file, limit: 1 })).kind).toBe("denied");
    const target = fixture();
    const linkParent = fixture();
    symlinkSync(target, join(linkParent, "state-link"));
    expect((await runtime.list({ stateDir: join(linkParent, "state-link"), limit: 1 })).kind).toBe(
      "denied",
    );
    const locked = fixture();
    writeFileSync(join(locked, "nookbridge.lock"), "123");
    expect((await runtime.list({ stateDir: locked, limit: 1 })).kind).toBe("locked");
  });
});

describe("tree runner and dispatcher", () => {
  it("does not construct a runtime for help or invalid input", async () => {
    const factory = vi.fn(
      async (_stateDir: string): Promise<TreeCommandRuntime> => ({
        list: async () => ({ kind: "empty" }),
      }),
    );
    expect(
      (
        await runTreeCommand({
          argv: ["help"],
          env: env(),
          stateDir: "/safe",
          createRuntime: factory,
        })
      ).kind,
    ).toBe("help");
    expect(
      (
        await runTreeCommand({
          argv: ["list", "--path", "/etc"],
          env: env(),
          stateDir: "/safe",
          createRuntime: factory,
        })
      ).kind,
    ).toBe("error");
    expect(factory).not.toHaveBeenCalled();
  });

  it("wires the configured state directory through the CLI factory", async () => {
    const root = fixture();
    const factory = vi.fn(
      async (_stateDir: string): Promise<TreeCommandRuntime> => ({
        list: async () => ({
          kind: "page",
          entries: [
            {
              handle: "st_0123456789abcdef",
              kind: "state-root",
              label: "state-root",
              mode: "directory",
              owner: "owner",
              sizeClass: "bounded",
              childCount: 0,
            },
          ],
          next: null,
        }),
      }),
    );
    _internal.treeRuntimeFactory = factory;
    const captured = await captureStdout(() =>
      run(["node", "nookctl", "tree", "list", "--state-dir", root]),
    );
    expect(captured.value).toBe(0);
    expect(factory).toHaveBeenCalledWith(root);
    expect(captured.stdout).toContain("kind: state-root");
    expect(captured.stdout).not.toContain(root);
    expect(captured.stderr).toBe("");
  });
});

describe("tree formatter", () => {
  it("collapses malformed or sensitive records to categorical error", () => {
    expect(
      formatTreeResult({
        kind: "page",
        entries: [
          {
            handle: "st_0123456789abcdef",
            kind: "state-root",
            label: "private-name" as never,
            mode: "directory",
            owner: "owner",
            sizeClass: "bounded",
            childCount: 0,
          },
        ],
        next: null,
      }),
    ).toBe("nookctl tree: error\n");
    expect(formatTreeResult({ kind: "error", exitCode: 3 })).toBe("nookctl tree: error\n");
  });
});
