/** Focused TDD coverage for the bounded nookd startup composition. */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runNookdCli,
  startNookd,
  type NookdStartupFactories,
  type NookdStartupRuntime,
} from "../src/nookd.js";
import type { LoadServiceConfigResult, ServiceConfig } from "../src/config/service-config.js";
import type { SecureKeyStore } from "../src/keystore/keystore.js";
import type { NookdServerHandle, StartNookdServerOptions } from "../src/service/nookd-server.js";

const CONFIG_PATH = "/etc/nookbridge/service.json";
const CREDENTIALS_DIRECTORY = "/run/credentials/nookbridge.service";
const CONFIG: ServiceConfig = Object.freeze({
  stateDir: "/var/lib/nookbridge",
  socketPath: "/run/nookbridge/nookbridge.sock",
  socketGroup: "nookbridge-clients",
  backend: "systemd-credential",
  credentialName: "nookbridge-db-key",
  readPolicy: Object.freeze([
    "notes.search",
    "notes.status",
    "notes.list_notebooks",
    "notes.get",
  ] as const),
});

const WRITE_CONFIG: ServiceConfig = Object.freeze({
  ...CONFIG,
  readPolicy: Object.freeze(["notes.search", "notes.create", "notes.append"] as const),
});

const productionKeys: SecureKeyStore = Object.freeze({
  backend: "systemd-credential",
  productionSafe: true,
  getDatabaseKey: () => "opaque-test-key",
});

function fakeHandle(): NookdServerHandle {
  return Object.freeze({
    socketPath: CONFIG.socketPath,
    shutdown: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  });
}

function runtimeFixture(cleanup: ReturnType<typeof vi.fn>): NookdStartupRuntime {
  return Object.freeze({
    search: vi.fn(async () => [{ title: "result" }]),
    cleanup,
  });
}

function factoriesFixture(overrides: Partial<NookdStartupFactories> = {}): NookdStartupFactories {
  return {
    loadConfig: vi.fn((_: string): LoadServiceConfigResult => ({ ok: true, config: CONFIG })),
    createKeyStore: vi.fn(() => productionKeys),
    createRuntime: vi.fn(async () => runtimeFixture(vi.fn(async () => undefined))),
    startServer: vi.fn(async () => fakeHandle()),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("bounded nookd startup composition", () => {
  it("keeps no-argument startup fail-closed", () => {
    const output = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    expect(runNookdCli([], output)).toBe(64);
    expect(output.stderr.write).toHaveBeenCalledWith(expect.stringContaining("implicit defaults"));
  });

  it("loads once and composes config, fixed credential label, runtime, and Unix server", async () => {
    vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
    const cleanup = vi.fn(async () => undefined);
    const server = fakeHandle();
    let serverOptions: StartNookdServerOptions | undefined;
    const factories = factoriesFixture({
      createRuntime: vi.fn(async () => runtimeFixture(cleanup)),
      startServer: vi.fn(async (options) => {
        serverOptions = options;
        return server;
      }),
    });

    const handle = await startNookd({ configPath: CONFIG_PATH, factories });

    expect(factories.loadConfig).toHaveBeenCalledTimes(1);
    expect(factories.loadConfig).toHaveBeenCalledWith(CONFIG_PATH);
    expect(factories.createKeyStore).toHaveBeenCalledWith({
      credentialsDirectory: CREDENTIALS_DIRECTORY,
      credentialName: "nookbridge-db-key",
    });
    expect(factories.createRuntime).toHaveBeenCalledWith({
      stateDir: CONFIG.stateDir,
      keys: productionKeys,
    });
    expect(serverOptions?.socketPath).toBe(CONFIG.socketPath);
    expect(serverOptions?.runtime.search).toBeDefined();
    expect(handle.socketPath).toBe(CONFIG.socketPath);
  });

  it("forwards the selected frozen policy and every optional write capability", async () => {
    vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
    const cleanup = vi.fn(async () => undefined);
    const createNote = vi.fn(async () => ({
      operation: "create" as const,
      id: "note-created",
      titleBytes: 5,
      contentBytes: 4,
      localCommitted: true as const,
      remoteSynced: false as const,
      pendingSync: true as const,
    }));
    const appendNote = vi.fn(async () => ({
      operation: "append" as const,
      id: "note-created",
      contentBytes: 4,
      localCommitted: true as const,
      remoteSynced: false as const,
      pendingSync: true as const,
    }));
    const updateNote = vi.fn(async () => ({
      operation: "update" as const,
      id: "note-created",
      appliedFields: ["title"] as const,
      localCommitted: true as const,
      remoteSynced: false as const,
      pendingSync: true as const,
    }));
    const runtime = Object.freeze({
      ...runtimeFixture(cleanup),
      createNote,
      appendNote,
      updateNote,
    });
    let serverOptions: StartNookdServerOptions | undefined;
    const factories = factoriesFixture({
      loadConfig: vi.fn(() => ({ ok: true as const, config: WRITE_CONFIG })),
      createRuntime: vi.fn(async () => runtime),
      startServer: vi.fn(async (options) => {
        serverOptions = options;
        return fakeHandle();
      }),
    });

    const handle = await startNookd({ configPath: CONFIG_PATH, factories });

    expect(serverOptions?.policy?.profile).toBe("custom");
    expect(serverOptions?.policy?.allowedMethods).toEqual([
      "notes.search",
      "notes.create",
      "notes.append",
    ]);
    expect(Object.isFrozen(serverOptions?.policy)).toBe(true);
    expect(serverOptions?.runtime.createNote).toBe(createNote);
    expect(serverOptions?.runtime.appendNote).toBe(appendNote);
    expect(serverOptions?.runtime.updateNote).toBe(updateNote);
    await handle.shutdown();
  });

  it("rejects an unsafe config returned by the loader seam before runtime construction", async () => {
    vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
    const factories = factoriesFixture({
      loadConfig: vi.fn(
        () =>
          ({
            ok: true,
            config: {
              ...CONFIG,
              stateDir: "/tmp/not-service-owned",
              socketPath: "/tmp/not-service-owned.sock",
            },
          }) as never,
      ),
    });

    await expect(startNookd({ configPath: CONFIG_PATH, factories })).rejects.toThrow(
      /configuration startup failed/i,
    );
    expect(factories.createKeyStore).not.toHaveBeenCalled();
    expect(factories.createRuntime).not.toHaveBeenCalled();
    expect(factories.startServer).not.toHaveBeenCalled();
  });

  it.each([undefined, "relative/credentials"])(
    "rejects a missing or relative CREDENTIALS_DIRECTORY before credential construction (%s)",
    async (credentialsDirectory) => {
      if (credentialsDirectory === undefined) vi.stubEnv("CREDENTIALS_DIRECTORY", "");
      else vi.stubEnv("CREDENTIALS_DIRECTORY", credentialsDirectory);
      const factories = factoriesFixture();

      await expect(startNookd({ configPath: CONFIG_PATH, factories })).rejects.toThrow(
        /credential directory/i,
      );
      expect(factories.createKeyStore).not.toHaveBeenCalled();
      expect(factories.createRuntime).not.toHaveBeenCalled();
    },
  );

  it.each(["\u001f", "\u007f"])(
    "rejects a control-bearing CREDENTIALS_DIRECTORY before credential construction (U+%s)",
    async (control) => {
      vi.stubEnv("CREDENTIALS_DIRECTORY", `${CREDENTIALS_DIRECTORY}${control}canary`);
      const factories = factoriesFixture();

      await expect(startNookd({ configPath: CONFIG_PATH, factories })).rejects.toThrow(
        /credential directory/i,
      );
      expect(factories.createKeyStore).not.toHaveBeenCalled();
    },
  );

  it.each(["\u0000", "\u001f", "\u007f"])(
    "rejects a config path containing control character U+%s before loading it",
    async (control) => {
      const factories = factoriesFixture();

      await expect(
        startNookd({ configPath: `${CONFIG_PATH}${control}canary`, factories }),
      ).rejects.toThrow(/startup arguments are invalid/i);
      expect(factories.loadConfig).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-canonical config path before loading it", async () => {
    const factories = factoriesFixture();

    await expect(startNookd({ configPath: "/tmp/../etc/service.json", factories })).rejects.toThrow(
      /startup arguments are invalid/i,
    );
    expect(factories.loadConfig).not.toHaveBeenCalled();
  });

  it("cleans the constructed runtime exactly once when server startup fails", async () => {
    vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
    const cleanup = vi.fn(async () => undefined);
    const factories = factoriesFixture({
      createRuntime: vi.fn(async () => runtimeFixture(cleanup)),
      startServer: vi.fn(async () => {
        throw new Error("secret socket path and upstream cause");
      }),
    });

    const promise = startNookd({ configPath: CONFIG_PATH, factories });
    await expect(promise).rejects.toThrow(/server startup failed/i);
    await expect(promise).rejects.not.toThrow(/secret|socket path|upstream cause/i);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans the runtime exactly once on later shutdown, even when the server seam does not", async () => {
    vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
    const cleanup = vi.fn(async () => undefined);
    const server = fakeHandle();
    const factories = factoriesFixture({
      createRuntime: vi.fn(async () => runtimeFixture(cleanup)),
      startServer: vi.fn(async () => server),
    });

    const handle = await startNookd({ configPath: CONFIG_PATH, factories });
    await Promise.all([handle.shutdown(), handle.close(), handle.shutdown()]);

    expect(server.shutdown).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("captures runtime capabilities once before validating them", async () => {
    vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
    const cleanup = vi.fn(async () => undefined);
    const search = vi.fn(async () => []);
    let searchReads = 0;
    let cleanupReads = 0;
    const runtime = {
      get search() {
        searchReads += 1;
        return search;
      },
      get cleanup() {
        cleanupReads += 1;
        return cleanup;
      },
    };
    const factories = factoriesFixture({
      createRuntime: vi.fn(async () => runtime),
    });

    const handle = await startNookd({ configPath: CONFIG_PATH, factories });

    expect(searchReads).toBe(1);
    expect(cleanupReads).toBe(1);
    await handle.shutdown();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed server handle and cleans up the runtime", async () => {
    vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
    const cleanup = vi.fn(async () => undefined);
    const factories = factoriesFixture({
      createRuntime: vi.fn(async () => runtimeFixture(cleanup)),
      startServer: vi.fn(
        async () =>
          ({
            socketPath: CONFIG.socketPath,
            shutdown: "not-callable",
            close: vi.fn(async () => undefined),
          }) as unknown as NookdServerHandle,
      ),
    });

    await expect(startNookd({ configPath: CONFIG_PATH, factories })).rejects.toThrow(
      /server startup failed/i,
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("sanitizes forged startup errors and hostile public CLI inputs", async () => {
    const forged = new (await import("../src/nookd.js")).NookdStartupError(
      "invalid_arguments",
      "FORGED_STARTUP_CANARY",
    );
    expect(forged.message).not.toContain("FORGED_STARTUP_CANARY");
    const hostileOptions = new Proxy(
      {},
      {
        get() {
          throw new Error("OPTIONS_CANARY");
        },
      },
    );
    const output = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const hostileArgv = new Proxy([], {
      get() {
        throw new Error("ARGV_CANARY");
      },
    }) as unknown as readonly string[];

    const direct = new Proxy(
      { configPath: CONFIG_PATH },
      {
        get() {
          throw forged;
        },
      },
    );
    await expect(startNookd(direct as never)).rejects.toThrow(/startup arguments are invalid/i);
    await expect(startNookd(direct as never)).rejects.not.toThrow(/FORGED_STARTUP_CANARY/i);

    expect(runNookdCli(hostileArgv, output)).toBe(78);
    expect(runNookdCli(["--check-config", CONFIG_PATH], output, hostileOptions)).toBe(78);
    expect(
      await runNookdCli(
        ["--config", CONFIG_PATH],
        output,
        undefined,
        {},
        {
          ...factoriesFixture({
            loadConfig: vi.fn(() => ({ ok: false, error: new Error("CONFIG_CANARY") }) as never),
          }),
        },
      ),
    ).toBe(78);
    expect(output.stderr.write.mock.calls.flat().join(" ")).not.toMatch(/CANARY/i);
  });

  it("returns a categorical result when a public output getter or writer is hostile", () => {
    const hostileOutput = new Proxy(
      {},
      {
        get() {
          throw new Error("OUTPUT_CANARY");
        },
      },
    );
    expect(runNookdCli(["--help"], hostileOutput as never)).toBe(78);

    const hostileWriter = {
      write: vi.fn(() => {
        throw new Error("WRITE_CANARY");
      }),
    };
    expect(runNookdCli(["--help"], hostileWriter)).toBe(78);
  });

  it("normalizes config, credential, runtime, and server failures without raw details", async () => {
    vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
    const failures: Array<{
      name: string;
      factories: NookdStartupFactories;
      expected: RegExp;
    }> = [
      {
        name: "config",
        factories: factoriesFixture({
          loadConfig: vi.fn(() => {
            throw new Error("config path and parser details");
          }),
        }),
        expected: /configuration/i,
      },
      {
        name: "credential",
        factories: factoriesFixture({
          createKeyStore: vi.fn(() => {
            throw new Error("credential bytes and path");
          }),
        }),
        expected: /credential/i,
      },
      {
        name: "runtime",
        factories: factoriesFixture({
          createRuntime: vi.fn(async () => {
            throw new Error("note data and state path");
          }),
        }),
        expected: /runtime/i,
      },
      {
        name: "server",
        factories: factoriesFixture({
          startServer: vi.fn(async () => {
            throw new Error("socket path and raw cause");
          }),
        }),
        expected: /server/i,
      },
    ];

    for (const failure of failures) {
      const error = await startNookd({
        configPath: CONFIG_PATH,
        factories: failure.factories,
      }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(failure.expected);
      expect((error as Error).message).not.toMatch(/path|parser|bytes|note data|raw cause/i);
      expect((error as Error).cause).toBeUndefined();
      expect((error as Error & { __context__?: unknown }).__context__).toBeUndefined();
    }
  });
});
