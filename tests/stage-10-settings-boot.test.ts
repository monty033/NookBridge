/** Stage 10 Task 8 — boot-time settings and trusted notebook index wiring. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startNookd, type NookdStartupFactories, type NookdStartupRuntime } from "../src/nookd.js";
import type { ServiceConfig } from "../src/config/service-config.js";
import type { SecureKeyStore } from "../src/keystore/keystore.js";
import type { NookdServerHandle, StartNookdServerOptions } from "../src/service/nookd-server.js";

const CONFIG: ServiceConfig = Object.freeze({
  stateDir: "/var/lib/nookbridge",
  socketPath: "/run/nookbridge/nookbridge.sock",
  socketGroup: "nookbridge-clients",
  backend: "systemd-credential",
  credentialName: "nookbridge-db-key",
  readPolicy: Object.freeze(["notes.search", "notes.get"] as const),
});

const KEYS: SecureKeyStore = Object.freeze({
  backend: "systemd-credential",
  productionSafe: true,
  getDatabaseKey: () => "opaque-test-key",
});

const SETTINGS = {
  version: 1,
  defaults: { read: true, edit: false, create: false, delete: false },
  overrides: [],
};

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path) rmSync(path, { force: true });
  }
  vi.restoreAllMocks();
});

function settingsFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "nookbridge-settings-")), "settings.json");
  tempPaths.push(path);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

function serverHandle(): NookdServerHandle {
  return Object.freeze({
    socketPath: CONFIG.socketPath,
    shutdown: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  });
}

function factories(
  runtime: NookdStartupRuntime,
  capture: (options: StartNookdServerOptions) => void,
): NookdStartupFactories {
  vi.stubEnv("CREDENTIALS_DIRECTORY", "/run/credentials/nookbridge.service");
  return {
    loadConfig: vi.fn(() => ({ ok: true as const, config: CONFIG })),
    createKeyStore: vi.fn(() => KEYS),
    createRuntime: vi.fn(async () => runtime),
    readSettingsFile: vi.fn((path: string) => readFileSync(path, "utf8")),
    startServer: vi.fn(async (options) => {
      capture(options);
      return serverHandle();
    }),
  };
}

async function startupError(promise: Promise<NookdServerHandle>): Promise<Error> {
  try {
    await promise;
  } catch (value) {
    if (value instanceof Error) return value;
  }
  throw new Error("expected startup failure");
}

function runtimeFixture(cleanup = vi.fn(async () => undefined)): NookdStartupRuntime {
  return {
    search: vi.fn(async () => [{ title: "result" }]),
    listNotebooks: vi.fn(async () => [
      { id: "family", title: "Family" },
      { id: "lina", title: "Lina", parentId: "family" },
    ]),
    listNotebooksForSettings: vi.fn(async () => [
      { id: "family", title: "Family" },
      { id: "lina", title: "Lina", parentId: "family" },
    ]),
    noteMetadata: vi.fn(async (id: string) => ({ id, title: "Note", notebookId: "lina" })),
    cleanup,
  };
}

describe("Stage 10 Task 8 — settings and notebook index at boot", () => {
  it("rejects a missing settings file categorically before runtime construction", async () => {
    const factoriesUnderTest = factories(runtimeFixture(), () => undefined);

    const error = await startupError(
      startNookd({
        configPath: "/etc/nookbridge/service.json",
        settingsPath: "/tmp/definitely-missing-nookbridge-settings.json",
        factories: factoriesUnderTest,
      }),
    );

    expect(error).toMatchObject({ category: "settings_invalid" });
    expect(error.message).toMatch(/settings/i);
    expect(error.message).not.toContain("definitely-missing");
    expect(error.cause).toBeUndefined();
    expect(factoriesUnderTest.createRuntime).not.toHaveBeenCalled();
  });

  it.each(["{", JSON.stringify({ version: 1, defaults: {}, overrides: [] })])(
    "rejects malformed or invalid settings categorically without leaking contents",
    async (contents) => {
      const path = settingsFile(contents);
      const factoriesUnderTest = factories(runtimeFixture(), () => undefined);
      const error = await startupError(
        startNookd({
          configPath: "/etc/nookbridge/service.json",
          settingsPath: path,
          factories: factoriesUnderTest,
        }),
      );

      expect(error).toMatchObject({ category: "settings_invalid" });
      expect(error.message).not.toContain(contents);
      expect(error.message).not.toContain(path);
      expect(error.cause).toBeUndefined();
      expect(factoriesUnderTest.createRuntime).not.toHaveBeenCalled();
    },
  );

  it("loads settings once and injects one evaluator and the complete trusted index", async () => {
    const path = settingsFile(JSON.stringify(SETTINGS));
    const runtime = runtimeFixture();
    let serverOptions: StartNookdServerOptions | undefined;
    const handle = await startNookd({
      configPath: "/etc/nookbridge/service.json",
      settingsPath: path,
      factories: factories(runtime, (options) => {
        serverOptions = options;
      }),
    });

    const policy = serverOptions?.policy;
    expect(policy?.evaluator).toEqual(expect.any(Function));
    expect(serverOptions?.runtime.notebookIndex).toBeDefined();
    expect(serverOptions?.runtime.notebookIndex?.resolvePath("family")).toBe("Family");
    expect(serverOptions?.runtime.notebookIndex?.resolvePath("lina")).toBe("Family/Lina");
    expect(serverOptions?.runtime.notebookIndex?.resolveId("family/lina")).toBe("lina");
    expect(serverOptions?.runtime.notebookIndex?.size()).toBe(2);
    expect(serverOptions?.runtime.notebookIndex).toEqual(
      expect.objectContaining({ resolvePath: expect.any(Function) }),
    );
    await handle.shutdown();
  });

  it.each([
    ["missing parent", [{ id: "child", title: "Child", parentId: "missing" }]],
    [
      "cycle",
      [
        { id: "a", title: "A", parentId: "b" },
        { id: "b", title: "B", parentId: "a" },
      ],
    ],
    [
      "duplicate path",
      [
        { id: "a", title: "Same" },
        { id: "b", title: "same" },
      ],
    ],
  ] as const)("fails boot closed for notebook index %s", async (_name, records) => {
    const path = settingsFile(JSON.stringify(SETTINGS));
    const cleanup = vi.fn(async () => undefined);
    const runtime = {
      ...runtimeFixture(cleanup),
      listNotebooksForSettings: vi.fn(async () => records),
    };
    const factoriesUnderTest = factories(runtime, () => undefined);

    const error = await startupError(
      startNookd({
        configPath: "/etc/nookbridge/service.json",
        settingsPath: path,
        factories: factoriesUnderTest,
      }),
    );

    expect(error).toMatchObject({ category: "settings_invalid" });
    expect(error.message).toBe("nookd settings startup failed");
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
