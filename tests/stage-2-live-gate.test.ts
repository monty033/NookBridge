import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { runAuthCommand, type LiveLoginRuntime } from "../src/auth/admin-command.js";
import type { SecretPrompt } from "../src/auth/secret-input.js";

function runtimeCanary(label: string): string {
  return `runtime-live-gate-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function runtimeEmailCanary(label: string): string {
  return `${runtimeCanary(label)}@example.test`;
}

function createPrompt(values: string[]): SecretPrompt {
  return {
    writeLine: vi.fn(),
    readSecretLine: vi.fn(async () => {
      const value = values.shift();
      return value === undefined ? null : Buffer.from(value, "utf8");
    }),
  };
}

function createRuntime(overrides: Partial<LiveLoginRuntime> = {}): LiveLoginRuntime {
  return {
    providerFactory: vi.fn(() => ({
      login: vi.fn(async () => ({
        userId: runtimeCanary("user"),
        accessToken: runtimeCanary("access"),
        issuedAt: 1_000,
        expiresAt: 2_000,
      })),
      refresh: vi.fn(async () => {
        throw new Error("not used");
      }),
      logout: vi.fn(async () => undefined),
    })),
    cleanup: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("nookctl auth live-login operator gate", () => {
  it("fails closed before prompt or runtime construction when the gate is absent", async () => {
    const createPromptSpy = vi.fn(() => createPrompt([]));
    const createRuntimeSpy = vi.fn(async () => createRuntime());

    const result = await runAuthCommand({
      argv: ["live-login"],
      env: {},
      liveLogin: {
        stateDir: "/tmp/never-created",
        createPrompt: createPromptSpy,
        createRuntime: createRuntimeSpy,
      },
    });

    expect(result).toEqual({
      kind: "error",
      exitCode: 2,
      message: "nookctl auth live-login is disabled; set NOOKBRIDGE_ENABLE_LIVE_AUTH=1",
    });
    expect(createPromptSpy).not.toHaveBeenCalled();
    expect(createRuntimeSpy).not.toHaveBeenCalled();
  });

  it("rejects forbidden environment carriers before prompt or runtime construction", async () => {
    const canary = runtimeCanary("password");
    const createPromptSpy = vi.fn(() => createPrompt([]));
    const createRuntimeSpy = vi.fn(async () => createRuntime());

    const result = await runAuthCommand({
      argv: ["live-login"],
      env: { NOOKBRIDGE_ENABLE_LIVE_AUTH: "1", NOOKBRIDGE_PASSWORD: canary },
      liveLogin: {
        stateDir: "/tmp/never-created",
        createPrompt: createPromptSpy,
        createRuntime: createRuntimeSpy,
      },
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected gate error");
    expect(result.exitCode).toBe(2);
    expect(result.message).not.toContain(canary);
    expect(createPromptSpy).not.toHaveBeenCalled();
    expect(createRuntimeSpy).not.toHaveBeenCalled();
  });

  it("rejects forbidden argv equals-form carriers before prompt or runtime construction", async () => {
    const canary = runtimeCanary("argv");
    const createPromptSpy = vi.fn(() => createPrompt([]));
    const createRuntimeSpy = vi.fn(async () => createRuntime());

    const result = await runAuthCommand({
      argv: ["live-login", `--password=${canary}`],
      env: { NOOKBRIDGE_ENABLE_LIVE_AUTH: "1" },
      liveLogin: {
        stateDir: "/tmp/never-created",
        createPrompt: createPromptSpy,
        createRuntime: createRuntimeSpy,
      },
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected argv error");
    expect(result.message).not.toContain(canary);
    expect(createPromptSpy).not.toHaveBeenCalled();
    expect(createRuntimeSpy).not.toHaveBeenCalled();
  });

  it("requires a real prompt/TTY before state or core runtime creation", async () => {
    const createPromptSpy = vi.fn(() => {
      throw new Error("TTY canary must not escape");
    });
    const createRuntimeSpy = vi.fn(async () => createRuntime());

    const result = await runAuthCommand({
      argv: ["live-login"],
      env: { NOOKBRIDGE_ENABLE_LIVE_AUTH: "1" },
      liveLogin: {
        stateDir: "/tmp/never-created",
        createPrompt: createPromptSpy,
        createRuntime: createRuntimeSpy,
      },
    });

    expect(result).toEqual({
      kind: "error",
      exitCode: 3,
      message: "nookctl auth live-login requires an interactive TTY",
    });
    expect(createPromptSpy).toHaveBeenCalledTimes(1);
    expect(createRuntimeSpy).not.toHaveBeenCalled();
  });

  it("runs the gated fake provider and always cleans up, while returning only redacted CLI metadata", async () => {
    const email = runtimeEmailCanary("email");
    const password = runtimeCanary("password");
    const accessToken = runtimeCanary("access");
    const prompt = createPrompt([email, password]);
    const provider = {
      login: vi.fn(async () => ({
        userId: runtimeCanary("user-id"),
        accessToken,
        issuedAt: 1_000,
        expiresAt: 2_000,
      })),
      refresh: vi.fn(async () => {
        throw new Error("not used");
      }),
      logout: vi.fn(async () => undefined),
    };
    const runtime = createRuntime({ providerFactory: vi.fn(() => provider) });
    const result = await runAuthCommand({
      argv: ["live-login"],
      env: { NOOKBRIDGE_ENABLE_LIVE_AUTH: "1" },
      liveLogin: {
        stateDir: "/tmp/live-gate-test",
        createPrompt: () => prompt,
        createRuntime: vi.fn(async () => runtime),
      },
    });

    expect(result.kind).toBe("live-login");
    if (result.kind !== "live-login") throw new Error("expected authenticated result");
    expect(result.outcome.status).toBe("authenticated");
    expect(result.outcome.message).not.toContain(email);
    expect(result.outcome.message).not.toContain(password);
    expect(result.outcome.message).not.toContain(accessToken);
    expect(runtime.cleanup).toHaveBeenCalledTimes(1);
    expect(provider.login).toHaveBeenCalledWith({ username: email, password });
  });

  it("cleans up when the fake provider fails and normalizes its error", async () => {
    const runtime = createRuntime({
      providerFactory: vi.fn(() => ({
        login: vi.fn(async () => {
          throw new Error(runtimeCanary("upstream-failure"));
        }),
        refresh: vi.fn(async () => {
          throw new Error("not used");
        }),
        logout: vi.fn(async () => undefined),
      })),
    });
    const result = await runAuthCommand({
      argv: ["live-login"],
      env: { NOOKBRIDGE_ENABLE_LIVE_AUTH: "1" },
      liveLogin: {
        stateDir: "/tmp/live-gate-test",
        createPrompt: () => createPrompt([runtimeEmailCanary("email"), runtimeCanary("password")]),
        createRuntime: vi.fn(async () => runtime),
      },
    });

    expect(result).toEqual({
      kind: "error",
      exitCode: 2,
      message: "live notesnook runner: login failed",
    });
    expect(runtime.cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not enable production live login for ordinary auth login", async () => {
    const createPromptSpy = vi.fn(() => createPrompt([]));
    const createRuntimeSpy = vi.fn(async () => createRuntime());

    const result = await runAuthCommand({
      argv: ["login"],
      env: { NOOKBRIDGE_ENABLE_LIVE_AUTH: "1" },
      liveLogin: {
        stateDir: "/tmp/never-created",
        createPrompt: createPromptSpy,
        createRuntime: createRuntimeSpy,
      },
    });

    expect(result.kind).toBe("deferred");
    expect(createPromptSpy).not.toHaveBeenCalled();
    expect(createRuntimeSpy).not.toHaveBeenCalled();
  });

  it("reopens persisted state through gated status without constructing a TTY prompt", async () => {
    const session = {
      userId: runtimeCanary("restored-user"),
      accessToken: runtimeCanary("restored-access"),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const provider = {
      login: vi.fn(),
      refresh: vi.fn(),
      logout: vi.fn(),
      restoreSession: vi.fn(async () => session),
    };
    const runtime = createRuntime({ providerFactory: vi.fn(() => provider) });
    const createPromptSpy = vi.fn(() => createPrompt([]));
    const result = await runAuthCommand({
      argv: ["status"],
      env: { NOOKBRIDGE_ENABLE_LIVE_AUTH: "1" },
      liveLogin: {
        stateDir: "/tmp/live-gate-test",
        createPrompt: createPromptSpy,
        createRuntime: vi.fn(async () => runtime),
      },
    });

    expect(result).toMatchObject({
      kind: "auth-state",
      outcome: { subcommand: "status", status: "authenticated" },
    });
    expect(provider.restoreSession).toHaveBeenCalledTimes(1);
    expect(createPromptSpy).not.toHaveBeenCalled();
    expect(runtime.cleanup).toHaveBeenCalledTimes(1);
  });

  it("refreshes an expired restored session through gated status without a TTY prompt", async () => {
    const restored = {
      userId: runtimeCanary("expired-user"),
      accessToken: runtimeCanary("expired-access"),
      issuedAt: 1,
      expiresAt: 2,
    };
    const refreshed = {
      ...restored,
      accessToken: runtimeCanary("fresh-access"),
      expiresAt: Date.now() + 60_000,
    };
    const provider = {
      login: vi.fn(),
      refresh: vi.fn(async () => refreshed),
      logout: vi.fn(),
      restoreSession: vi.fn(async () => restored),
    };
    const runtime = createRuntime({ providerFactory: vi.fn(() => provider) });
    const createPromptSpy = vi.fn(() => createPrompt([]));
    const result = await runAuthCommand({
      argv: ["status"],
      env: { NOOKBRIDGE_ENABLE_LIVE_AUTH: "1" },
      liveLogin: {
        stateDir: "/tmp/live-gate-test",
        createPrompt: createPromptSpy,
        createRuntime: vi.fn(async () => runtime),
      },
    });

    expect(result).toMatchObject({
      kind: "auth-state",
      outcome: { subcommand: "status", status: "authenticated" },
    });
    expect(provider.restoreSession).toHaveBeenCalledTimes(1);
    expect(provider.refresh).toHaveBeenCalledWith(restored);
    expect(createPromptSpy).not.toHaveBeenCalled();
    expect(runtime.cleanup).toHaveBeenCalledTimes(1);
  });

  it("forces a refresh of a valid restored session only when --refresh is explicit", async () => {
    const restored = {
      userId: runtimeCanary("valid-user"),
      accessToken: runtimeCanary("valid-access"),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const provider = {
      login: vi.fn(),
      refresh: vi.fn(async () => ({ ...restored, expiresAt: Date.now() + 120_000 })),
      logout: vi.fn(),
      restoreSession: vi.fn(async () => restored),
    };
    const runtime = createRuntime({ providerFactory: vi.fn(() => provider) });
    const result = await runAuthCommand({
      argv: ["status", "--refresh"],
      env: { NOOKBRIDGE_ENABLE_LIVE_AUTH: "1" },
      liveLogin: {
        stateDir: "/tmp/live-gate-test",
        createPrompt: vi.fn(() => createPrompt([])),
        createRuntime: vi.fn(async () => runtime),
      },
    });

    expect(result).toMatchObject({
      kind: "auth-state",
      outcome: { subcommand: "status", status: "authenticated" },
    });
    expect(provider.refresh).toHaveBeenCalledWith(restored);
  });

  it("clears authenticated state through gated logout and reset without a TTY prompt", async () => {
    for (const command of ["logout", "reset-local-client"] as const) {
      const provider = {
        login: vi.fn(),
        refresh: vi.fn(),
        logout: vi.fn(async () => undefined),
      };
      const runtime = createRuntime({ providerFactory: vi.fn(() => provider) });
      const result = await runAuthCommand({
        argv: [command],
        env: { NOOKBRIDGE_ENABLE_LIVE_AUTH: "1" },
        liveLogin: {
          stateDir: "/tmp/live-gate-test",
          createPrompt: vi.fn(() => createPrompt([])),
          createRuntime: vi.fn(async () => runtime),
        },
      });
      expect(result).toMatchObject({
        kind: "auth-state",
        outcome: { subcommand: command, status: "signed-out" },
      });
      expect(provider.logout).toHaveBeenCalledTimes(1);
      expect(runtime.cleanup).toHaveBeenCalledTimes(1);
    }
  });
});
