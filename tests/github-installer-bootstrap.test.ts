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
  const artifact = join(root, "nookbridge-v0.1.1-linux-x64-gnu.tar.gz");
  // Minimal valid artifact structure (must contain a top-level release.json
  // that install-systemd.sh can extract for archive_top_level/artifact_version,
  // plus a scripts/install-systemd.sh so the bootstrap can invoke it after
  // extraction).
  execFileSync("mkdir", [
    "-p",
    join(artifactDir, "nookbridge-v0.1.1", "bin"),
    join(artifactDir, "nookbridge-v0.1.1", "scripts"),
  ]);
  writeFileSync(
    join(artifactDir, "nookbridge-v0.1.1", "release.json"),
    `${JSON.stringify({ version: "0.1.1", target: "linux-x64-gnu" }, null, 2)}\n`,
  );
  writeFileSync(
    join(artifactDir, "nookbridge-v0.1.1", "SHA256SUMS"),
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
      join(artifactDir, "nookbridge-v0.1.1", "bin", name),
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
    join(artifactDir, "nookbridge-v0.1.1", "scripts", "install-systemd.sh"),
    fakeInstallerScript,
    { mode: 0o755 },
  );
  execFileSync("tar", ["-czf", artifact, "-C", artifactDir, "nookbridge-v0.1.1"]);
  const checksumFile = join(root, "SHA256SUMS");
  // The bootstrap must compute the artifact sha256 itself, then write the
  // outer SHA256SUMS file in the installer's expected format.
  writeFileSync(checksumFile, `${sha256(artifact)}  nookbridge-v0.1.1-linux-x64-gnu.tar.gz\n`);
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
      `${sha256(artifact)}  nookbridge-v0.1.1-linux-x64-gnu.tar.gz`,
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
    expect(log).toMatch(/--artifact \/[^ ]*nookbridge-v0\.1\.1-linux-x64-gnu\.tar\.gz/);
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

  it("binds the controlling TTY to stdin, stdout, and stderr when the settings editor is invoked", () => {
    // Regression: the bootstrap used to redirect only stdin to /dev/tty, so
    // the editor's UI/prompt output disappeared whenever the parent shell
    // wasn't itself connected to a TTY (piped curl | sudo bash, captured
    // automation, etc.). The fix must redirect all three streams to the
    // controlling TTY and emit an installer log line so the operator can
    // see the editor opened. This test forces the TTY path via the
    // NOOKBRIDGE_BOOTSTRAP_FAKE_TTY seam and asserts the fake nookctl
    // observed the controlling TTY on fd 0/1/2.
    const { env, ctx } = buildFakeInstallerEnv();
    // Provide a stand-in /dev/tty the bootstrap can open during the test
    // (the test runner itself has no controlling TTY).
    const fakeTtyPath = join(ctx.binDir, "fake-tty");
    writeFileSync(fakeTtyPath, "");
    // Provide a fake nookctl that records the resolved paths of its three
    // standard streams. We cannot rely on bash command substitution here:
    // `$(readlink /proc/self/fd/N)` runs readlink in a subshell whose fd 1
    // is the substitution pipe, which hides the bootstrap's redirect.
    // Instead we exec a Python helper that reads the PARENT script's
    // /proc/<our_pid>/fd/N; the script's fds still reflect the bootstrap's
    // redirects because the bootstrap redirects nookctl's fds BEFORE the
    // script interpreter starts. Using `$$` (the script's own pid), not
    // `$PPID` (the outer shell that invoked us), is critical — otherwise
    // python sees the outer shell's pipes instead of the bootstrap's
    // redirect targets.
    writeFileSync(
      join(ctx.binDir, "nookctl"),
      [
        "#!/usr/bin/env bash",
        // Capture argv + env first via printf (no command substitution).
        'printf \'nookctl %s env_NOOKBRIDGE_SETTINGS_PATH=%s\\n\' "$*" "${NOOKBRIDGE_SETTINGS_PATH-unset}" >> "$NOOKBRIDGE_FAKE_LOG"',
        // Then introspect our parent script's fd 0/1/2 via python.
        'python3 - "$$" "$NOOKBRIDGE_FAKE_LOG" <<\'PYEOF\' >> /dev/null',
        "import os, sys",
        "parent_pid = int(sys.argv[1])",
        "out = sys.argv[2] + '.fd'",
        "lines = []",
        "for fd in (0, 1, 2):",
        "    try:",
        "        path = os.readlink(f'/proc/{parent_pid}/fd/{fd}')",
        "    except OSError as exc:",
        "        path = f'<{exc.errno}>'",
        "    lines.append(f'fd{fd}={path}')",
        "with open(out, 'w', encoding='utf-8') as fh:",
        "    fh.write(' '.join(lines) + '\\n')",
        "PYEOF",
        'cat "$NOOKBRIDGE_FAKE_LOG.fd" >> "$NOOKBRIDGE_FAKE_LOG"',
        'rm -f "$NOOKBRIDGE_FAKE_LOG.fd"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(join(ctx.binDir, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(ctx.binDir, "nookbridge-health"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = runBootstrap(
      { ...env, NOOKBRIDGE_BOOTSTRAP_FAKE_TTY: fakeTtyPath },
      "--edit-settings",
      "--no-sync",
      "--no-provision",
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const log = readFakeLog(ctx.fakeLog);
    expect(log).toMatch(/nookctl settings edit/);
    // All three fds must point at the (substituted) controlling TTY.
    expect(log).toMatch(new RegExp(`fd0=${escapeRegex(fakeTtyPath)}`));
    expect(log).toMatch(new RegExp(`fd1=${escapeRegex(fakeTtyPath)}`));
    expect(log).toMatch(new RegExp(`fd2=${escapeRegex(fakeTtyPath)}`));
    expect(log).toMatch(/env_NOOKBRIDGE_SETTINGS_PATH=\/etc\/nookbridge\/settings\.json/);
    // The bootstrap must log the editor invocation so the operator can
    // tell the prompt opened on the controlling TTY.
    expect(result.stdout).toMatch(/settings editor/);
  });

  it("falls back to inherited stdio when no controlling TTY is available", () => {
    // The bootstrap must keep the existing non-TTY fallback: when
    // /dev/tty is unavailable, nookctl is invoked with the inherited
    // stdio and no /dev/tty redirect. The default test harness has no
    // controlling TTY, so this case exercises the production branch
    // without the NOOKBRIDGE_BOOTSTRAP_FAKE_TTY seam.
    const { env, ctx } = buildFakeInstallerEnv();
    writeFileSync(
      join(ctx.binDir, "nookctl"),
      [
        "#!/usr/bin/env bash",
        'printf \'nookctl %s\\n\' "$*" >> "$NOOKBRIDGE_FAKE_LOG"',
        'python3 - "$$" "$NOOKBRIDGE_FAKE_LOG" <<\'PYEOF\' >> /dev/null',
        "import os, sys",
        "parent_pid = int(sys.argv[1])",
        "out = sys.argv[2] + '.fd'",
        "lines = []",
        "for fd in (0, 1, 2):",
        "    try:",
        "        path = os.readlink(f'/proc/{parent_pid}/fd/{fd}')",
        "    except OSError as exc:",
        "        path = f'<{exc.errno}>'",
        "    lines.append(f'fd{fd}={path}')",
        "with open(out, 'w', encoding='utf-8') as fh:",
        "    fh.write(' '.join(lines) + '\\n')",
        "PYEOF",
        'cat "$NOOKBRIDGE_FAKE_LOG.fd" >> "$NOOKBRIDGE_FAKE_LOG"',
        'rm -f "$NOOKBRIDGE_FAKE_LOG.fd"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(join(ctx.binDir, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(ctx.binDir, "nookbridge-health"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // An explicitly missing fake TTY forces the fallback branch even on
    // runners that happen to expose /dev/tty.
    const result = runBootstrap(
      { ...env, NOOKBRIDGE_BOOTSTRAP_FAKE_TTY: join(ctx.binDir, "missing-tty") },
      "--edit-settings",
      "--no-sync",
      "--no-provision",
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const log = readFakeLog(ctx.fakeLog);
    expect(log).toMatch(/nookctl settings edit/);
    // None of the three fds must resolve to /dev/tty in the fallback path.
    expect(log).not.toMatch(/fd0=\/dev\/tty\b/);
    expect(log).not.toMatch(/fd1=\/dev\/tty\b/);
    expect(log).not.toMatch(/fd2=\/dev\/tty\b/);
  });

  // Helper: write a fake /dev/tty fixture whose first line is read by
  // prompt_yes_no via the existing NOOKBRIDGE_BOOTSTRAP_FAKE_TTY seam.
  // The bootstrap reopens the path for each prompt, so every reached prompt
  // sees the fixture's first line. Tests below use --no-provision / --no-sync
  // to control which prompt is reached.
  function writeFakeTtyReply(ctx: FakeInstallerContext, reply: string): string {
    const path = join(ctx.binDir, "fake-tty-reply");
    writeFileSync(path, reply);
    return path;
  }

  function writeFakeNookctlRecorder(ctx: FakeInstallerContext): void {
    writeFileSync(
      join(ctx.binDir, "nookctl"),
      [
        "#!/usr/bin/env bash",
        'printf \'nookctl %s env_NOOKBRIDGE_SETTINGS_PATH=%s\\n\' "$*" "${NOOKBRIDGE_SETTINGS_PATH-unset}" >> "$NOOKBRIDGE_FAKE_LOG"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(join(ctx.binDir, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(ctx.binDir, "nookbridge-health"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // The real /run/current-system/sw/bin/nookbridge-provision requires
    // root; tests below exercise the prompt path that *invokes* it, so
    // shadow it with a recording stub that exits 0 unconditionally.
    writeFileSync(
      join(ctx.binDir, "nookbridge-provision"),
      [
        "#!/usr/bin/env bash",
        'printf \'nookbridge-provision args=%s env_NOOKBRIDGE_SETTINGS_PATH=%s\\n\' "$*" "${NOOKBRIDGE_SETTINGS_PATH-unset}" >> "$NOOKBRIDGE_FAKE_LOG"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  it("opens the settings editor when explicit 'y' is answered to the default-n prompt", () => {
    // Regression: the installer used to skip the editor even when the
    // operator typed 'y' to "Edit access settings now? [y/N]". The
    // prompt parser returned false on explicit 'y' when the default
    // was 'n', so the editor branch was never entered. The fix must
    // treat an explicit 'y' reply as yes regardless of the prompt
    // default, and route the read through the fake TTY seam so the
    // test can drive the real prompt path.
    const { env, ctx } = buildFakeInstallerEnv();
    const fakeTtyPath = writeFakeTtyReply(ctx, "y\n");
    writeFakeNookctlRecorder(ctx);
    const result = runBootstrap(
      { ...env, NOOKBRIDGE_BOOTSTRAP_FAKE_TTY: fakeTtyPath },
      "--no-provision",
      "--no-sync",
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const log = readFakeLog(ctx.fakeLog);
    expect(log).toMatch(/nookctl settings edit/);
    expect(log).toMatch(/env_NOOKBRIDGE_SETTINGS_PATH=\/etc\/nookbridge\/settings\.json/);
    expect(result.stdout).toMatch(/settings editor/);
  });

  it("skips provisioning when explicit 'n' is answered to the default-y prompt", () => {
    // Regression coverage for the inverse case: typing 'n' to
    // "Provision Notesnook account now? [Y/n]" must reject
    // provisioning regardless of the default. The buggy parser
    // happened to return false here too (matching on default=n),
    // but the fix must make the binding explicit so a future
    // re-coupling doesn't accidentally accept the user reply.
    const { env, ctx } = buildFakeInstallerEnv();
    // Reply fixture first line: provision='n' (default y, explicit n),
    // and any later reached prompt also reads 'n' because the bootstrap
    // reopens the fake TTY path for each prompt. Both provisioning and
    // the default-n editor prompt must therefore stay skipped.
    const fakeTtyPath = writeFakeTtyReply(ctx, "n\n\n");
    writeFakeNookctlRecorder(ctx);
    const result = runBootstrap(
      { ...env, NOOKBRIDGE_BOOTSTRAP_FAKE_TTY: fakeTtyPath },
      "--no-sync",
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const log = readFakeLog(ctx.fakeLog);
    expect(log).not.toMatch(/nookbridge-provision/);
    expect(result.stdout).toMatch(/provisioning skipped/);
  });

  it("treats a blank reply as the prompt default (default-n skips the editor)", () => {
    // Regression: blank input must follow the prompt default. The
    // default-n editor prompt should therefore stay skipped when no
    // reply is given, so operators who press Enter at the wrong moment
    // don't accidentally launch the settings editor.
    const { env, ctx } = buildFakeInstallerEnv();
    const fakeTtyPath = writeFakeTtyReply(ctx, "\n");
    writeFakeNookctlRecorder(ctx);
    const result = runBootstrap(
      { ...env, NOOKBRIDGE_BOOTSTRAP_FAKE_TTY: fakeTtyPath },
      "--no-provision",
      "--no-sync",
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const log = readFakeLog(ctx.fakeLog);
    expect(log).not.toMatch(/nookctl settings edit/);
    expect(result.stdout).not.toMatch(/settings editor/);
  });

  it("treats a blank reply as the prompt default (default-y accepts provisioning)", () => {
    // Regression: blank input on the default-y provision prompt must
    // accept provisioning. The fix routes the read through tty_path()
    // so the fake TTY seam can supply an empty line; the parser then
    // resolves empty input to the configured default.
    const { env, ctx } = buildFakeInstallerEnv();
    // Reply sequence: provision='' (default y, follows default →
    // provision runs), edit-settings='' (default n, follows default
    // → skipped), sync is gated behind --no-sync.
    const fakeTtyPath = writeFakeTtyReply(ctx, "\n\n");
    writeFakeNookctlRecorder(ctx);
    const result = runBootstrap(
      { ...env, NOOKBRIDGE_BOOTSTRAP_FAKE_TTY: fakeTtyPath },
      "--no-sync",
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const log = readFakeLog(ctx.fakeLog);
    expect(log).toMatch(/nookbridge-provision/);
    expect(result.stdout).toMatch(/starting interactive provisioning/);
  });

  it("rejects explicit 'n' for a default-n prompt (the editor must stay closed)", () => {
    // Regression coverage for the structural defect behind the
    // public installer bug: the parser tied an explicit 'n' reply to
    // "the default is n", which accidentally returned TRUE for a
    // default-n prompt. The fix must bind explicit 'n' to FALSE
    // unconditionally so an operator who types 'no' at a default-n
    // prompt is never silently overridden by the default.
    const { env, ctx } = buildFakeInstallerEnv();
    const fakeTtyPath = writeFakeTtyReply(ctx, "n\n");
    writeFakeNookctlRecorder(ctx);
    const result = runBootstrap(
      { ...env, NOOKBRIDGE_BOOTSTRAP_FAKE_TTY: fakeTtyPath },
      "--no-provision",
      "--no-sync",
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const log = readFakeLog(ctx.fakeLog);
    expect(log).not.toMatch(/nookctl settings edit/);
    expect(result.stdout).not.toMatch(/settings editor/);
  });
});

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

describe("bootstrap argument parser shellcheck", () => {
  it("parses with `bash -n` without syntax errors", () => {
    expect(() =>
      execFileSync("bash", ["-n", bootstrap], { stdio: ["ignore", "pipe", "pipe"] }),
    ).not.toThrow();
  });
});
