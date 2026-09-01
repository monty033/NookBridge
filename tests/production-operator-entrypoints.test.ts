import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import type { LiveLoginRuntime } from "../src/auth/admin-command.js";
import type { SecretPrompt } from "../src/auth/secret-input.js";
import {
  CREDENTIALS_DIRECTORY_ENV,
  createProductionOperatorKeyStore,
  readSafeOperatorEnvironment,
} from "../src/operator/production-runtime.js";
import { runProvision } from "../src/provision.js";
import { runProductionSync } from "../src/sync.js";

function promptFor(values: string[]): SecretPrompt {
  return {
    writeLine: vi.fn(),
    readSecretLine: vi.fn(async () => {
      const value = values.shift();
      return value === undefined ? null : Buffer.from(value, "utf8");
    }),
  };
}

function liveRuntime(): LiveLoginRuntime {
  return {
    providerFactory: vi.fn(() => ({
      login: vi.fn(async () => ({
        userId: "operator-user",
        accessToken: "operator-access",
        issuedAt: 1,
        expiresAt: 2,
      })),
      refresh: vi.fn(async () => {
        throw new Error("not used");
      }),
      logout: vi.fn(async () => undefined),
    })),
    cleanup: vi.fn(async () => undefined),
  };
}

describe("production operator entrypoints", () => {
  it("selects the systemd credential backend for production state", () => {
    const keys = createProductionOperatorKeyStore({
      [CREDENTIALS_DIRECTORY_ENV]: "/run/credentials/nookd.service",
    });

    expect(keys.backend).toBe("systemd-credential");
    expect(keys.productionSafe).toBe(true);
  });

  it("allowlists only non-secret operator environment names", () => {
    const snapshot = readSafeOperatorEnvironment({
      [CREDENTIALS_DIRECTORY_ENV]: "/run/credentials/test",
      NOOKBRIDGE_ENABLE_LIVE_AUTH: "1",
      NOOKBRIDGE_ENABLE_LIVE_SYNC: "1",
      UNRELATED_SECRET: "must-not-cross",
    });

    expect(snapshot).toEqual({
      [CREDENTIALS_DIRECTORY_ENV]: "/run/credentials/test",
      NOOKBRIDGE_ENABLE_LIVE_AUTH: "1",
      NOOKBRIDGE_ENABLE_LIVE_SYNC: "1",
    });
    expect(snapshot).not.toHaveProperty("UNRELATED_SECRET");
  });

  it("fails provisioning closed before prompt or runtime when the auth gate is absent", async () => {
    const createPrompt = vi.fn(() => promptFor([]));
    const createRuntime = vi.fn(async () => liveRuntime());

    const stderr: string[] = [];
    const result = await runProvision({
      argv: [],
      env: { CREDENTIALS_DIRECTORY: "/run/credentials/test" },
      createPrompt,
      createRuntime,
      writeErr: (text) => stderr.push(text),
    });

    expect(result).toBe(2);
    expect(stderr).toEqual(["nookbridge-provision: failed\n"]);
    expect(createPrompt).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("rejects forbidden credential carriers without exposing their values", async () => {
    const canary = "production-password-canary";
    const createPrompt = vi.fn(() => promptFor([]));
    const createRuntime = vi.fn(async () => liveRuntime());
    const stderr: string[] = [];

    const result = await runProvision({
      argv: [],
      env: {
        NOOKBRIDGE_ENABLE_LIVE_AUTH: "1",
        CREDENTIALS_DIRECTORY: "/run/credentials/test",
        NOOKBRIDGE_PASSWORD: canary,
      },
      createPrompt,
      createRuntime,
      writeErr: (text) => stderr.push(text),
    });

    expect(result).toBe(2);
    expect(stderr.join(" ")).not.toContain(canary);
    expect(createPrompt).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("authenticates through the injected TTY/runtime seams and always cleans up", async () => {
    const runtime = liveRuntime();
    const prompt = promptFor(["operator@example.test", "operator-password"]);
    const stdout: string[] = [];

    const result = await runProvision({
      argv: [],
      env: {
        NOOKBRIDGE_ENABLE_LIVE_AUTH: "1",
        CREDENTIALS_DIRECTORY: "/run/credentials/test",
      },
      createPrompt: () => prompt,
      createRuntime: async () => runtime,
      writeOut: (text) => stdout.push(text),
    });

    expect(result).toBe(0);
    expect(stdout).toEqual(["nookbridge-provision: authenticated\n"]);
    expect(runtime.cleanup).toHaveBeenCalledTimes(1);
  });

  it("runs the production sync command only through the read-only fetch proof", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runProductionSync({
      argv: [],
      env: {
        NOOKBRIDGE_ENABLE_LIVE_SYNC: "1",
        CREDENTIALS_DIRECTORY: "/run/credentials/test",
      },
      writeOut: (text) => stdout.push(text),
      writeErr: (text) => stderr.push(text),
    });

    // The real runtime must not reach account or network operations in this
    // offline unit test: the missing disposable credential path yields the
    // stable failure envelope before the encrypted state can be opened.
    expect(result).toBe(3);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["nookbridge-sync: failed\n"]);
  });
});
