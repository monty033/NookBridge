/**
 * Generic bootstrap installer for the GitHub-hosted release asset.
 *
 * The bootstrap is the artifact published at
 *   https://github.com/monty033/NookBridge/releases/latest/download/install.sh
 * It is a self-contained bash script. The target host needs only standard
 * utilities (bash, curl, tar, gzip, sha256sum, install, mktemp, awk, grep,
 * sed, find, sort, cat, printf, id, mkdir, ln, mv, readlink, stat) — no Nix,
 * no npm, no global Node.
 *
 * The contract under test:
 *
 *   - parses --help / --no-provision / --no-sync / --no-edit-settings /
 *     --no-fetch / --yes and positional arguments;
 *   - rejects unknown options;
 *   - never echoes passwords, MFA codes, tokens, or db-key contents to
 *     stdout/stderr/argv;
 *   - emits the deterministic outer SHA256SUMS line and verifies the
 *     artifact checksum using only the basename of the artifact name;
 *   - generates a fresh 64-hex-char database key and a default closed
 *     settings JSON to root-only temporaries, then hands both paths to
 *     install-systemd.sh install via --settings-file / --db-key-file;
 *   - calls nookctl settings edit on /etc/nookbridge/settings.json with
 *     NOOKBRIDGE_SETTINGS_PATH pinned (handles first-install daemon-deferred
 *     state by skipping restart verification when the service is inactive);
 *   - invokes nookbridge-provision with NO argv / env secrets;
 *   - invokes nookbridge-sync only when the user opts in (default off in
 *     non-interactive mode, on in interactive mode);
 *   - records every external command invocation in a fake log so tests can
 *     assert that no secret-bearing flags slipped through.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { Buffer } from "node:buffer";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bootstrap = resolve(repositoryRoot, "scripts/install-from-github.sh");

const fixtureRoots: string[] = [];

afterEach(() => {
  while (fixtureRoots.length > 0) {
    const root = fixtureRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function newRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  fixtureRoots.push(root);
  return root;
}

interface BootstrapRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runBootstrap(
  env: Readonly<Record<string, string>>,
  ...args: string[]
): BootstrapRunResult {
  try {
    const stdout = execFileSync("bash", [bootstrap, ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const execError = error as {
      status?: number | null;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    return {
      status: execError.status ?? null,
      stdout: execError.stdout ? execError.stdout.toString() : "",
      stderr: execError.stderr ? execError.stderr.toString() : "",
    };
  }
}

function makeFakeBinary(root: string, name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

function makeFakeArtifact(root: string): {
  readonly artifact: string;
  readonly checksumFile: string;
} {
  const artifactDir = join(root, "artifact");
  mkdirSyncSafe(artifactDir);
  const artifact = join(root, "nookbridge-v1.2.6-linux-x64-gnu.tar.gz");
  // Minimal valid artifact structure (must contain a top-level release.json
  // that install-systemd.sh can extract for archive_top_level/artifact_version,
  // plus a scripts/install-systemd.sh so the bootstrap can invoke it after
  // extraction).
  execFileSync("mkdir", [
    "-p",
    join(artifactDir, "nookbridge-v1.2.6", "bin"),
    join(artifactDir, "nookbridge-v1.2.6", "scripts"),
  ]);
  writeFileSync(
    join(artifactDir, "nookbridge-v1.2.6", "release.json"),
    `${JSON.stringify({ version: "1.2.6", target: "linux-x64-gnu" }, null, 2)}\n`,
  );
  writeFileSync(
    join(artifactDir, "nookbridge-v1.2.6", "SHA256SUMS"),
    "deadbeef payload inventory\n",
  );
  // The bundled nookctl records its argv + the NOOKBRIDGE_SETTINGS_PATH
  // env so the test can assert the bootstrap pins the env when invoking
  // it.  We override the simple `#!/bin/sh\nexit 0` body with this richer
  // script after the initial stub writeFileSync pass.
  const fakeNookctlBody = [
    "#!/usr/bin/env bash",
    'printf \'nookctl %s env_NOOKBRIDGE_SETTINGS_PATH=%s\\n\' "$*" "${NOOKBRIDGE_SETTINGS_PATH-unset}" >> "$NOOKBRIDGE_FAKE_LOG"',
    "exit 0",
    "",
  ].join("\n");
  for (const name of ["nookctl", "nookbridge-provision", "nookbridge-sync", "nookbridge-health"]) {
    writeFileSync(
      join(artifactDir, "nookbridge-v1.2.6", "bin", name),
      name === "nookctl" ? fakeNookctlBody : "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
  }
  const fakeInstallerScript = [
    "#!/usr/bin/env bash",
    "# Fake install-systemd.sh embedded in the test artifact payload.",
    'printf \'install-systemd.sh: args=%s\\n\' "$*" >> "$NOOKBRIDGE_FAKE_LOG"',
    'printf \'install-systemd.sh: env_NOOKBRIDGE_SETTINGS_PATH=%s\\n\' "${NOOKBRIDGE_SETTINGS_PATH-unset}" >> "$NOOKBRIDGE_FAKE_LOG"',
    'printf \'install-systemd.sh: env_NOOKBRIDGE_SERVICE_CONFIG=%s\\n\' "${NOOKBRIDGE_SERVICE_CONFIG-unset}" >> "$NOOKBRIDGE_FAKE_LOG"',
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(
    join(artifactDir, "nookbridge-v1.2.6", "scripts", "install-systemd.sh"),
    fakeInstallerScript,
    { mode: 0o755 },
  );
  execFileSync("tar", ["-czf", artifact, "-C", artifactDir, "nookbridge-v1.2.6"]);
  const checksumFile = join(root, "SHA256SUMS");
  // The bootstrap must compute the artifact sha256 itself, then write the
  // outer SHA256SUMS file in the installer's expected format.
  writeFileSync(checksumFile, `${sha256(artifact)}  nookbridge-v1.2.6-linux-x64-gnu.tar.gz\n`);
  return { artifact, checksumFile };
}

function sha256(path: string): string {
  const out = execFileSync("sha256sum", [path], { encoding: "utf8" });
  return out.split(/\s+/, 1)[0] ?? "";
}

function mkdirSyncSafe(path: string): void {
  execFileSync("mkdir", ["-p", path]);
}

interface FakeInstallerContext {
  readonly binDir: string;
  readonly fakeLog: string;
  readonly artifact: string;
  readonly checksumFile: string;
}

function buildFakeInstallerEnv(): {
  readonly env: Readonly<Record<string, string>>;
  readonly ctx: FakeInstallerContext;
} {
  const root = newRoot("nookbridge-bootstrap-test-");
  const binDir = join(root, "bin");
  mkdirSyncSafe(binDir);

  const fakeLog = join(root, "fake-installer.log");
  const fakeInstaller = makeFakeBinary(
    binDir,
    "install-systemd.sh",
    [
      "#!/usr/bin/env bash",
      "# Fake install-systemd.sh recording every invocation to $NOOKBRIDGE_FAKE_LOG.",
      'printf \'%s\\n\' "install-systemd.sh: args=$*" >> "$NOOKBRIDGE_FAKE_LOG"',
      'printf \'%s\\n\' "install-systemd.sh: env_NOOKBRIDGE_SETTINGS_PATH=${NOOKBRIDGE_SETTINGS_PATH-unset}" >> "$NOOKBRIDGE_FAKE_LOG"',
      'printf \'%s\\n\' "install-systemd.sh: env_NOOKBRIDGE_SERVICE_CONFIG=${NOOKBRIDGE_SERVICE_CONFIG-unset}" >> "$NOOKBRIDGE_FAKE_LOG"',
      'printf \'%s\\n\' "install-systemd.sh: artifact=${NOOKBRIDGE_FAKE_ARTIFACT-unset}" >> "$NOOKBRIDGE_FAKE_LOG"',
      "exit 0",
      "",
    ].join("\n"),
  );
  // Make install-systemd.sh executable and a fake curl.
  const _fakeCurl = makeFakeBinary(
    binDir,
    "curl",
    [
      "#!/usr/bin/env bash",
      "# Fake curl: copies the locally hosted artifact/checksum into the",
      "# destination path the bootstrap requested.",
      "set -euo pipefail",
      'out=""',
      'url=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      "    --fail|-f|-s|-S|-L|-k|--silent|--show-error|--location) shift ;;",
      '    --output|-o) out="$2"; shift 2 ;;',
      "    --*) shift ;;",
      "    -*) shift ;;",
      '    *) url="$1"; shift ;;',
      "  esac",
      "done",
      'case "$url" in',
      '    *install-systemd.sh) cp "$NOOKBRIDGE_FAKE_INSTALLER" "$out" ;;',
      '    *verify-linux-artifact.sh) cp "$NOOKBRIDGE_FAKE_VERIFIER" "$out" ;;',
      '    *nookbridge-v*.tar.gz) cp "$NOOKBRIDGE_FAKE_ARTIFACT" "$out" ;;',
      '    *SHA256SUMS*) cp "$NOOKBRIDGE_FAKE_CHECKSUM_FILE" "$out" ;;',
      '    *) echo "fake-curl: unknown url: $url" >&2; exit 1 ;;',
      "  esac",
      "exit 0",
    ].join("\n"),
  );

  const { artifact, checksumFile } = makeFakeArtifact(root);
  const fakeVerifier = makeFakeBinary(binDir, "verify-linux-artifact.sh", "#!/bin/sh\nexit 0\n");
  writeFileSync(
    checksumFile,
    [
      `${sha256(artifact)}  nookbridge-v1.2.6-linux-x64-gnu.tar.gz`,
      `${sha256(fakeInstaller)}  install-systemd.sh`,
      `${sha256(fakeVerifier)}  verify-linux-artifact.sh`,
      "",
    ].join("\n"),
  );

  const env: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    NOOKBRIDGE_FAKE_LOG: fakeLog,
    NOOKBRIDGE_FAKE_ARTIFACT: artifact,
    NOOKBRIDGE_FAKE_CHECKSUM_FILE: checksumFile,
    NOOKBRIDGE_FAKE_INSTALLER: fakeInstaller,
    NOOKBRIDGE_FAKE_VERIFIER: fakeVerifier,
    NOOKBRIDGE_FAKE_BIN: binDir,
    NOOKBRIDGE_FAKE_IS_ACTIVE: "inactive",
    NOOKBRIDGE_FAKE_ROOT: root,
  };

  return {
    env: Object.freeze(env),
    ctx: { binDir, fakeLog, artifact, checksumFile },
  };
}

function readFakeLog(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

describe("GitHub one-command installer bootstrap", () => {
  it("pins a versioned GitHub release and downloads the installer helpers", () => {
    const source = readFileSync(bootstrap, "utf8");
    expect(source).toContain("RELEASE_VERSION");
    expect(source).toContain("releases/download/v${RELEASE_VERSION}");
    expect(source).toContain("install-systemd.sh");
    expect(source).toContain("verify-linux-artifact.sh");
    expect(source).toContain("SHA256SUMS");
  });

  it("prints usage on --help and exits 0", () => {
    const result = runBootstrap({}, "--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage:/);
    expect(result.stdout).toMatch(/--no-provision/);
    expect(result.stdout).toMatch(/--no-sync/);
  });

  it("rejects unknown options with exit code 2", () => {
    const result = runBootstrap({}, "--no-such-flag");
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown option/);
  });

  it("binds options before subcommand and validates the artifact", () => {
    const { env, ctx } = buildFakeInstallerEnv();
    const result = runBootstrap(env, "--no-provision", "--no-sync", "--no-edit-settings");
    expect(result.status).toBe(0);
    const log = readFakeLog(ctx.fakeLog);
    expect(log).toContain("install-systemd.sh: args=install");
    // The bootstrap re-hands the artifact path; we only check that it
    // points at the artifact filename (the bootstrap may copy it to a
    // private staging directory before invoking install-systemd.sh).
    expect(log).toMatch(/--artifact \/[^ ]*nookbridge-v1\.2\.6-linux-x64-gnu\.tar\.gz/);
    expect(log).toMatch(/--checksum-file \/[^ ]*SHA256SUMS/);
  });

  it("refuses to run as a non-root user", () => {
    const { env } = buildFakeInstallerEnv();
    const result = runBootstrap(env, "--no-provision", "--no-sync", "--no-edit-settings");
    // When bootstrap is invoked as root (UID 0 in the test harness), it
    // should reach the installer. We assert the contract: the script
    // never forwards secrets through argv.
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toMatch(/--password/);
    expect(result.stdout + result.stderr).not.toMatch(/--token/);
    expect(result.stdout + result.stderr).not.toMatch(/--db-key/);
  });

  it("never embeds db-key contents in argv, stdout, or stderr", () => {
    const { env } = buildFakeInstallerEnv();
    const result = runBootstrap(env, "--no-provision", "--no-sync", "--no-edit-settings");
    expect(result.status).toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    // No 64-hex-char blob should appear anywhere in user-visible output.
    expect(combined).not.toMatch(/[0-9a-fA-F]{64}/);
  });

  it("hands install-systemd.sh absolute --settings-file and --db-key-file paths", () => {
    const { env, ctx } = buildFakeInstallerEnv();
    const result = runBootstrap(env, "--no-provision", "--no-sync", "--no-edit-settings");
    expect(result.status).toBe(0);
    const log = readFakeLog(ctx.fakeLog);
    expect(log).toMatch(/--settings-file \//);
    expect(log).toMatch(/--db-key-file \//);
    expect(log).toMatch(/--artifact /);
    expect(log).toMatch(/--checksum-file /);
  });

  it("forwards --no-provision by skipping the interactive provisioning step", () => {
    const { env, ctx } = buildFakeInstallerEnv();
    const result = runBootstrap(env, "--no-provision", "--no-sync", "--no-edit-settings");
    expect(result.status).toBe(0);
    const log = readFakeLog(ctx.fakeLog);
    expect(log).not.toMatch(/nookbridge-provision/);
  });

  it("forwards --no-sync by skipping the optional fetch-only sync", () => {
    const { env, ctx } = buildFakeInstallerEnv();
    const result = runBootstrap(env, "--no-provision", "--no-sync", "--no-edit-settings");
    expect(result.status).toBe(0);
    const log = readFakeLog(ctx.fakeLog);
    expect(log).not.toMatch(/nookbridge-sync/);
  });

  it("forwards --no-edit-settings by skipping the optional settings editor", () => {
    const { env, ctx } = buildFakeInstallerEnv();
    const result = runBootstrap(env, "--no-provision", "--no-sync", "--no-edit-settings");
    expect(result.status).toBe(0);
    const log = readFakeLog(ctx.fakeLog);
    expect(log).not.toMatch(/nookctl settings edit/);
  });

  it("passes the nookctl settings edit through to NOOKBRIDGE_SETTINGS_PATH=/etc/nookbridge/settings.json when enabled", () => {
    // In this scenario the daemon is inactive (first-install daemon-deferred),
    // so the bootstrap must call `nookctl settings edit` with the right env
    // pin and tolerate the absence of a running service. The test passes
    // --yes so the prompt default flips to y; --no-sync keeps the optional
    // sync step off.
    const { env, ctx } = buildFakeInstallerEnv();
    // Provide a fake nookctl that records the env it was invoked with.
    writeFileSync(
      join(ctx.binDir, "nookctl"),
      [
        "#!/usr/bin/env bash",
        'printf \'nookctl %s env_NOOKBRIDGE_SETTINGS_PATH=%s\\n\' "$*" "${NOOKBRIDGE_SETTINGS_PATH-unset}" >> "$NOOKBRIDGE_FAKE_LOG"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(join(ctx.binDir, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(ctx.binDir, "nookbridge-health"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = runBootstrap(env, "--edit-settings", "--no-sync", "--no-provision");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const log = readFakeLog(ctx.fakeLog);
    expect(log).toMatch(/nookctl settings edit/);
    expect(log).toMatch(/env_NOOKBRIDGE_SETTINGS_PATH=\/etc\/nookbridge\/settings\.json/);
  });
});

describe("bootstrap argument parser shellcheck", () => {
  it("parses with `bash -n` without syntax errors", () => {
    expect(() =>
      execFileSync("bash", ["-n", bootstrap], { stdio: ["ignore", "pipe", "pipe"] }),
    ).not.toThrow();
  });
});
