import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";

import { loadServiceConfig } from "../config/service-config.js";
import { loadSettings } from "../settings/settings-loader.js";
import type { SettingsFile } from "../settings/settings-types.js";

export type SettingsBackend = "nix" | "cli";

type ParsedSettingsCommand =
  | Readonly<{ kind: "help" }>
  | Readonly<{ kind: "show" }>
  | Readonly<{ kind: "validate" }>
  | Readonly<{ kind: "edit" }>
  | Readonly<{ kind: "reset" }>;

export type ParseSettingsCommandResult =
  | Readonly<{ kind: "parsed"; command: ParsedSettingsCommand }>
  | Readonly<{ kind: "error"; message: string; exitCode: 2 }>;

export type SettingsEditResult = Readonly<{ ok: true; content: string }> | Readonly<{ ok: false }>;

export type SettingsCommandRuntime = Readonly<{
  read: (path: string) => string;
  writeAtomic: (path: string, content: string) => void;
  edit: (path: string, initialContent: string) => SettingsEditResult;
  restartAndVerify: () => void;
}>;

export type SettingsCommandResult =
  | Readonly<{ kind: "help"; message: string }>
  | Readonly<{ kind: "success"; message: string }>
  | Readonly<{ kind: "error"; exitCode: 2; message: string }>;

const NIX_SETTINGS_SOURCE = "nix-config/modules/nookbridge/settings.json";
const SYSTEM_SETTINGS_PATH = "/etc/nookbridge/settings.json";
const SAFE_SUBPROCESS_ENV = new Set([
  "PATH",
  "HOME",
  "TERM",
  "COLORTERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
]);
const DEFAULT_SETTINGS: SettingsFile = Object.freeze({
  version: 1,
  defaults: Object.freeze({ read: true, edit: false, create: false, delete: false }),
  overrides: Object.freeze([]),
});

export function parseSettingsCommand(
  argv: readonly string[],
  _env: Record<string, string | undefined>,
): ParseSettingsCommandResult {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    return { kind: "parsed", command: { kind: "help" } };
  }
  if (argv.length !== 1) {
    return { kind: "error", exitCode: 2, message: "nookctl settings: invalid command input" };
  }
  const command = argv[0];
  if (command === "show" || command === "validate" || command === "edit" || command === "reset") {
    return { kind: "parsed", command: { kind: command } };
  }
  return { kind: "error", exitCode: 2, message: "nookctl settings: invalid command input" };
}

export function formatSettingsHelp(): string {
  return [
    "nookctl settings — inspect and manage settings",
    "",
    "Usage:",
    "  nookctl settings show",
    "  nookctl settings validate",
    "  nookctl settings edit",
    "  nookctl settings reset",
    "  nookctl settings help",
    "",
    "Commands:",
    "  show                  print the validated settings",
    "  validate              validate the settings file",
    "  edit                  edit settings (CLI-managed installs only)",
    "  reset                 restore CLI-managed defaults",
    "  help                  show this help",
    "",
  ].join("\n");
}

export async function runSettingsCommand(
  options: Readonly<{
    argv: readonly string[];
    env: Record<string, string | undefined>;
    runtime?: SettingsCommandRuntime;
  }>,
): Promise<SettingsCommandResult> {
  const parsed = parseSettingsCommand(options.argv, options.env);
  if (parsed.kind === "error") return parsed;
  if (parsed.command.kind === "help") {
    return { kind: "help", message: formatSettingsHelp() };
  }

  const backend = resolveBackend(options.env);
  if (backend === undefined) {
    return { kind: "error", exitCode: 2, message: "nookctl settings: invalid settings backend" };
  }
  if ((parsed.command.kind === "edit" || parsed.command.kind === "reset") && backend === "nix") {
    const source = resolveNixSettingsSource(options.env);
    if (source === undefined) {
      return {
        kind: "error",
        exitCode: 2,
        message: "nookctl settings: invalid Nix settings source",
      };
    }
    return {
      kind: "error",
      exitCode: 2,
      message: [
        `nookctl settings ${parsed.command.kind} is unavailable: this installation is managed by Nix.`,
        `Edit ${source} and apply it with nixos-rebuild switch.`,
      ].join(" "),
    };
  }

  const runtime = options.runtime ?? createProductionSettingsRuntime(options.env);
  try {
    const path = resolveSettingsPath(options.env, backend, options.runtime !== undefined);
    switch (parsed.command.kind) {
      case "show": {
        const settings = parseSettingsText(runtime.read(path));
        return { kind: "success", message: `${JSON.stringify(settings, null, 2)}\n` };
      }
      case "validate":
        parseSettingsText(runtime.read(path));
        return { kind: "success", message: "nookctl settings: valid" };
      case "reset":
        runtime.writeAtomic(path, serializeSettings(DEFAULT_SETTINGS));
        return finalizeWrite(runtime, "nookctl settings: reset");
      case "edit": {
        const initialContent = readInitialSettings(runtime, path);
        const edited = runtime.edit(path, initialContent);
        if (!edited.ok)
          return { kind: "error", exitCode: 2, message: "nookctl settings: editor failed" };
        const settings = parseSettingsText(edited.content);
        runtime.writeAtomic(path, serializeSettings(settings));
        return finalizeWrite(runtime, "nookctl settings: updated");
      }
    }
  } catch {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl settings: settings file is invalid or unavailable",
    };
  }
}

function finalizeWrite(runtime: SettingsCommandRuntime, message: string): SettingsCommandResult {
  try {
    runtime.restartAndVerify();
  } catch {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl settings: settings were written but service restart verification failed",
    };
  }
  return { kind: "success", message };
}

function resolveBackend(env: Record<string, string | undefined>): SettingsBackend | undefined {
  const serviceConfigPath = env["NOOKBRIDGE_SERVICE_CONFIG"];
  if (serviceConfigPath !== undefined && serviceConfigPath.length > 0) {
    const loaded = loadServiceConfig(serviceConfigPath);
    if (!loaded.ok) return undefined;
    return loaded.config.settingsBackend ?? "cli";
  }
  const value = env["NOOKBRIDGE_SETTINGS_BACKEND"] ?? "cli";
  return value === "nix" || value === "cli" ? value : undefined;
}

function resolveNixSettingsSource(env: Record<string, string | undefined>): string | undefined {
  const source = env["NOOKBRIDGE_NIX_SETTINGS_SOURCE"] ?? NIX_SETTINGS_SOURCE;
  return source.length > 0 && source.length <= 256 && !hasControlCharacter(source)
    ? source
    : undefined;
}

function resolveSettingsPath(
  env: Record<string, string | undefined>,
  backend: SettingsBackend,
  allowTestPath: boolean,
): string {
  const explicit = env["NOOKBRIDGE_SETTINGS_PATH"];
  const configHome = env["XDG_CONFIG_HOME"] ?? join(env["HOME"] ?? process.cwd(), ".config");
  const userPath = join(configHome, "nookbridge", "settings.json");
  const candidate =
    explicit !== undefined && explicit.length > 0
      ? explicit
      : backend === "nix"
        ? SYSTEM_SETTINGS_PATH
        : userPath;
  if (!allowTestPath) {
    const allowed = new Set([resolve(SYSTEM_SETTINGS_PATH), resolve(userPath)]);
    if (!allowed.has(resolve(candidate))) throw new Error("invalid settings path");
  }
  return candidate;
}

function parseSettingsText(content: string): SettingsFile {
  if (content.length > 1024 * 1024) throw new Error("settings too large");
  return loadSettings(JSON.parse(content) as unknown);
}

function serializeSettings(settings: SettingsFile): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function readInitialSettings(runtime: SettingsCommandRuntime, path: string): string {
  try {
    return runtime.read(path);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return serializeSettings(DEFAULT_SETTINGS);
    }
    throw error;
  }
}

function createProductionSettingsRuntime(
  env: Record<string, string | undefined>,
): SettingsCommandRuntime {
  return {
    read: (path) => {
      assertSafeSettingsPath(path);
      return readFileSync(path, "utf8");
    },
    writeAtomic: writeSettingsAtomic,
    edit: (path, initialContent) => {
      assertSafeSettingsPath(path);
      return editSettingsWithEditor(env, path, initialContent);
    },
    restartAndVerify: () => restartAndVerifyService(env),
  };
}

function assertSafeSettingsPath(path: string): void {
  const resolved = resolve(path);
  let current = resolved;
  try {
    if (lstatSync(current).isSymbolicLink()) throw new Error("settings path is a symlink");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  current = dirname(current);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("settings path parent is a symlink");
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }
}

function writeSettingsAtomic(path: string, content: string): void {
  assertSafeSettingsPath(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let fd = -1;
  try {
    fd = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    closeSync(fd);
    fd = -1;
    renameSync(temporaryPath, path);
  } finally {
    if (fd !== -1) closeSync(fd);
    rmSync(temporaryPath, { force: true });
  }
}

export function buildSettingsSubprocessEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if ((SAFE_SUBPROCESS_ENV.has(name) || name.startsWith("LC_")) && value !== undefined) {
      filtered[name] = value;
    }
  }
  return filtered;
}

function restartAndVerifyService(env: Record<string, string | undefined>): void {
  const unit = env["NOOKBRIDGE_SERVICE_UNIT"] ?? "nookd.service";
  if (unit.length === 0 || unit.length > 256 || hasControlCharacter(unit))
    throw new Error("invalid service unit");
  const restart = spawnSync("systemctl", ["restart", unit], {
    stdio: "ignore",
    shell: false,
    env: buildSettingsSubprocessEnv(env),
  });
  if (restart.error !== undefined || restart.status !== 0)
    throw new Error("service restart failed");
  const verify = spawnSync("systemctl", ["is-active", "--quiet", unit], {
    stdio: "ignore",
    shell: false,
    env: buildSettingsSubprocessEnv(env),
  });
  if (verify.error !== undefined || verify.status !== 0) throw new Error("service is not active");
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function editSettingsWithEditor(
  env: Record<string, string | undefined>,
  _path: string,
  initialContent: string,
): SettingsEditResult {
  const editor = env["VISUAL"] ?? env["EDITOR"] ?? "vi";
  if (editor.length === 0 || editor.length > 256 || hasControlCharacter(editor))
    return { ok: false };
  const directory = mkdtempSync(join(tmpdir(), "nookbridge-settings-edit-"));
  const temporaryPath = join(directory, "settings.json");
  try {
    writeFileSync(temporaryPath, initialContent, { encoding: "utf8", mode: 0o600 });
    const result = spawnSync(editor, [temporaryPath], {
      stdio: "inherit",
      shell: false,
      env: buildSettingsSubprocessEnv(env),
    });
    if (result.error !== undefined || result.status !== 0) return { ok: false };
    return { ok: true, content: readFileSync(temporaryPath, "utf8") };
  } catch {
    return { ok: false };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
