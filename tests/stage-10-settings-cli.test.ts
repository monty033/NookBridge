import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";

import { afterEach, describe, expect, it } from "vitest";

import { run } from "../src/cli.js";
import {
  formatSettingsHelp,
  parseSettingsCommand,
  runSettingsCommand,
  buildSettingsSubprocessEnv,
  type SettingsCommandRuntime,
} from "../src/operator/settings-cli.js";
import { loadSettings } from "../src/settings/settings-loader.js";

const createdDirectories: string[] = [];

function tempSettingsPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "nookbridge-settings-cli-"));
  createdDirectories.push(directory);
  return join(directory, "settings.json");
}

function captureOutput(): {
  stdout: { value: string; write: typeof process.stdout.write };
  stderr: { value: string; write: typeof process.stderr.write };
  restore: () => void;
} {
  const stdout = { value: "", write: process.stdout.write.bind(process.stdout) };
  const stderr = { value: "", write: process.stderr.write.bind(process.stderr) };
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout.value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr.value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = stdout.write;
      process.stderr.write = stderr.write;
    },
  };
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("settings CLI parser", () => {
  it("parses the bounded settings command vocabulary", () => {
    expect(parseSettingsCommand([], {})).toEqual({ kind: "parsed", command: { kind: "help" } });
    expect(parseSettingsCommand(["show"], {})).toEqual({
      kind: "parsed",
      command: { kind: "show" },
    });
    expect(parseSettingsCommand(["validate"], {})).toEqual({
      kind: "parsed",
      command: { kind: "validate" },
    });
    expect(parseSettingsCommand(["edit"], {})).toEqual({
      kind: "parsed",
      command: { kind: "edit" },
    });
    expect(parseSettingsCommand(["reset"], {})).toEqual({
      kind: "parsed",
      command: { kind: "reset" },
    });
    expect(parseSettingsCommand(["unknown"], {})).toEqual({
      kind: "error",
      exitCode: 2,
      message: "nookctl settings: invalid command input",
    });
    expect(formatSettingsHelp()).toContain("nookctl settings edit");
  });

  it("filters settings subprocess environments to non-secret variables", () => {
    expect(
      buildSettingsSubprocessEnv({
        PATH: "/safe/bin",
        HOME: "/home/operator",
        TERM: "xterm",
        NOOKBRIDGE_PASSWORD: "secret",
        NOOKBRIDGE_SETTINGS_PATH: "/etc/nookbridge/settings.json",
        NOOKCTL_TOKEN: "secret",
      }),
    ).toEqual({ PATH: "/safe/bin", HOME: "/home/operator", TERM: "xterm" });
  });
});

describe("Nix-managed settings protection", () => {
  it.each(["edit", "reset"])("refuses settings %s with Nix guidance", async (subcommand) => {
    const runtime: SettingsCommandRuntime = {
      read: () => {
        throw new Error("must not read");
      },
      writeAtomic: () => {
        throw new Error("must not write");
      },
      edit: () => {
        throw new Error("must not edit");
      },
      restartAndVerify: () => {
        throw new Error("must not restart");
      },
    };

    const result = await runSettingsCommand({
      argv: [subcommand],
      env: {
        NOOKBRIDGE_SETTINGS_BACKEND: "nix",
        NOOKBRIDGE_SETTINGS_PATH: "/etc/nookbridge/settings.json",
      },
      runtime,
    });

    expect(result).toEqual({
      kind: "error",
      exitCode: 2,
      message: expect.stringContaining(`nookctl settings ${subcommand} is unavailable`),
    });
    expect(result.kind === "error" ? result.message : "").toContain(
      "nix-config/modules/nookbridge/settings.json",
    );
    expect(result.kind === "error" ? result.message : "").toContain("nixos-rebuild switch");
  });

  it("rejects a control character in the Nix source diagnostic", async () => {
    const result = await runSettingsCommand({
      argv: ["edit"],
      env: {
        NOOKBRIDGE_SETTINGS_BACKEND: "nix",
        NOOKBRIDGE_NIX_SETTINGS_SOURCE: "bad\nsource",
      },
    });
    expect(result).toEqual({
      kind: "error",
      exitCode: 2,
      message: "nookctl settings: invalid Nix settings source",
    });
  });

  it("rejects a CLI settings path outside the approved locations", async () => {
    const result = await runSettingsCommand({
      argv: ["validate"],
      env: {
        NOOKBRIDGE_SETTINGS_BACKEND: "cli",
        NOOKBRIDGE_SETTINGS_PATH: "/tmp/outside-nookbridge/settings.json",
      },
    });
    expect(result).toEqual({
      kind: "error",
      exitCode: 2,
      message: "nookctl settings: settings file is invalid or unavailable",
    });
  });

  it("resets to a valid default file", async () => {
    const path = tempSettingsPath();
    const writes: string[] = [];
    let restarts = 0;
    const runtime: SettingsCommandRuntime = {
      read: () => "",
      writeAtomic: (target: string, content: string) => {
        expect(target).toBe(path);
        writes.push(content);
      },
      edit: () => ({ ok: true, content: "" }),
      restartAndVerify: () => {
        restarts += 1;
      },
    };

    const result = await runSettingsCommand({
      argv: ["reset"],
      env: { NOOKBRIDGE_SETTINGS_BACKEND: "cli", NOOKBRIDGE_SETTINGS_PATH: path },
      runtime,
    });

    expect(result).toEqual({ kind: "success", message: "nookctl settings: reset" });
    expect(writes).toHaveLength(1);
    expect(restarts).toBe(1);
    expect(() => loadSettings(JSON.parse(writes[0]!))).not.toThrow();
  });

  it("edits and validates a CLI-managed settings file before writing it", async () => {
    const path = tempSettingsPath();
    const writes: string[] = [];
    let restarts = 0;
    const edited = JSON.stringify({
      version: 1,
      defaults: { read: true, edit: true, create: false, delete: false },
      overrides: [],
    });
    const runtime: SettingsCommandRuntime = {
      read: () => edited,
      writeAtomic: (target: string, content: string) => {
        expect(target).toBe(path);
        writes.push(content);
      },
      edit: () => ({ ok: true, content: edited }),
      restartAndVerify: () => {
        restarts += 1;
      },
    };

    const result = await runSettingsCommand({
      argv: ["edit"],
      env: { NOOKBRIDGE_SETTINGS_BACKEND: "cli", NOOKBRIDGE_SETTINGS_PATH: path },
      runtime,
    });

    expect(result).toEqual({ kind: "success", message: "nookctl settings: updated" });
    expect(writes).toHaveLength(1);
    expect(restarts).toBe(1);
    expect(loadSettings(JSON.parse(writes[0]!)).defaults.edit).toBe(true);
  });

  it("allows validate and show in Nix mode", async () => {
    const path = tempSettingsPath();
    const settings = JSON.stringify({
      version: 1,
      defaults: { read: true, edit: false, create: false, delete: true },
      overrides: [],
    });
    const runtime: SettingsCommandRuntime = {
      read: (target) => {
        expect(target).toBe(path);
        return settings;
      },
      writeAtomic: () => undefined,
      edit: () => ({ ok: true, content: "" }),
      restartAndVerify: () => undefined,
    };
    const env = { NOOKBRIDGE_SETTINGS_BACKEND: "nix", NOOKBRIDGE_SETTINGS_PATH: path };

    await expect(runSettingsCommand({ argv: ["validate"], env, runtime })).resolves.toEqual({
      kind: "success",
      message: "nookctl settings: valid",
    });
    await expect(runSettingsCommand({ argv: ["show"], env, runtime })).resolves.toEqual({
      kind: "success",
      message: `${JSON.stringify(JSON.parse(settings), null, 2)}\n`,
    });
  });
});

describe("top-level nookctl settings dispatch", () => {
  it("prints the Nix guidance and returns exit code 2 for edit", async () => {
    const previousBackend = process.env.NOOKBRIDGE_SETTINGS_BACKEND;
    const previousPath = process.env.NOOKBRIDGE_SETTINGS_PATH;
    const captured = captureOutput();
    process.env.NOOKBRIDGE_SETTINGS_BACKEND = "nix";
    process.env.NOOKBRIDGE_SETTINGS_PATH = "/etc/nookbridge/settings.json";
    try {
      const code = await run(["node", "nookctl", "settings", "edit"]);
      expect(code).toBe(2);
      expect(captured.stdout.value).toBe("");
      expect(captured.stderr.value).toContain("nix-config/modules/nookbridge/settings.json");
      expect(captured.stderr.value).toContain("nixos-rebuild switch");
    } finally {
      captured.restore();
      if (previousBackend === undefined) delete process.env.NOOKBRIDGE_SETTINGS_BACKEND;
      else process.env.NOOKBRIDGE_SETTINGS_BACKEND = previousBackend;
      if (previousPath === undefined) delete process.env.NOOKBRIDGE_SETTINGS_PATH;
      else process.env.NOOKBRIDGE_SETTINGS_PATH = previousPath;
    }
  });

  it("keeps CLI-managed validation available through the top-level command", async () => {
    const configHome = mkdtempSync(join(tmpdir(), "nookbridge-settings-config-"));
    createdDirectories.push(configHome);
    const path = join(configHome, "nookbridge", "settings.json");
    mkdirSync(join(configHome, "nookbridge"));
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        defaults: { read: true, edit: false, create: false, delete: false },
        overrides: [],
      }),
    );
    const previousBackend = process.env.NOOKBRIDGE_SETTINGS_BACKEND;
    const previousPath = process.env.NOOKBRIDGE_SETTINGS_PATH;
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const captured = captureOutput();
    process.env.NOOKBRIDGE_SETTINGS_BACKEND = "cli";
    delete process.env.NOOKBRIDGE_SETTINGS_PATH;
    process.env.XDG_CONFIG_HOME = configHome;
    try {
      const code = await run(["node", "nookctl", "settings", "validate"]);
      expect(code).toBe(0);
      expect(captured.stdout.value).toBe("nookctl settings: valid\n");
      expect(loadSettings(JSON.parse(readFileSync(path, "utf8")))).toBeDefined();
    } finally {
      captured.restore();
      if (previousBackend === undefined) delete process.env.NOOKBRIDGE_SETTINGS_BACKEND;
      else process.env.NOOKBRIDGE_SETTINGS_BACKEND = previousBackend;
      if (previousPath === undefined) delete process.env.NOOKBRIDGE_SETTINGS_PATH;
      else process.env.NOOKBRIDGE_SETTINGS_PATH = previousPath;
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
  });
});
