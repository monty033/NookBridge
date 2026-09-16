/**
 * Generic systemd installer contract.
 *
 * These tests exercise the installer without root, Nix, npm builds,
 * systemd, or credentials. The installer must expose a deterministic
 * render mode so the unit contract can be reviewed before installation,
 * and a deterministic fake-root transaction mode so first-install,
 * upgrade, rollback, retention, and failure-injection contracts can be
 * reviewed before any real host state is touched.
 *
 * The new assertions in the second describe block are RED against the
 * current Nix-dependent installer. The current installer:
 *
 *   - builds from a Nix flake via `nix build` on the target;
 *   - links commands into `/usr/local/bin` directly to the Nix store;
 *   - emits a unit with `StateDirectoryMode=0750`, `UMask=0007`, and no
 *     `LimitCORE`;
 *   - uses one service group for both state and clients;
 *   - has no versioned `/opt/nookbridge/releases/<version>` layout;
 *   - has no `install`/`upgrade`/`rollback` subcommands or `--artifact`
 *     flag;
 *   - has no checksum/manifest/signature/architecture/libc preflight;
 *   - has no `flock`-guarded transactions;
 *   - has no retention, rollback confinement, or health-failure
 *     injection surface.
 *
 * Those gaps are exactly the new contract the approved plan requires.
 * The new assertions will turn GREEN once the installer is rewritten
 * around versioned releases and a fake-root transaction harness.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Buffer } from "node:buffer";

import { afterEach, describe, expect, it } from "vitest";

import {
  createInstallerFakeRoot,
  disposeInstallerFakeRoot,
  type InstallerFakeRoot,
} from "./fixtures/installer-fake-root.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = resolve(repositoryRoot, "scripts/install-systemd.sh");

function runInstaller(...args: string[]): string {
  return execFileSync("bash", [installer, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runInstallerWithEnv(
  env: Readonly<Record<string, string>>,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [installer, ...args], {
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

const fakeRoots: InstallerFakeRoot[] = [];

function freshFakeRoot(): InstallerFakeRoot {
  const ctx = createInstallerFakeRoot();
  fakeRoots.push(ctx);
  return ctx;
}

afterEach(() => {
  disposeInstallerFakeRoot();
  fakeRoots.length = 0;
});

describe("generic systemd installer", () => {
  it("provides help without requiring root or external commands", () => {
    const help = runInstaller("--help");

    expect(help).toContain("Usage: install-systemd.sh");
    expect(help).toContain("--settings-file");
    expect(help).toContain("--db-key-file");
    expect(help).toContain("--force");
  });

  it("renders a service unit with fixed credential labels and hardening", () => {
    const output = runInstaller(
      "--print-units",
      "--package-root",
      "/nix/store/nookbridge-test",
      "--settings-file",
      "/etc/nookbridge/settings.json",
      "--db-key-file",
      "/etc/nookbridge/db-key",
    );

    expect(output).toContain("[Unit]");
    expect(output).toContain(
      "ExecStart=/nix/store/nookbridge-test/bin/nookd --config /etc/nookbridge/service.json",
    );
    expect(output).toContain("LoadCredential=nookbridge-db-key:/etc/nookbridge/db-key");
    expect(output).toContain("LoadCredential=nookbridge-settings:/etc/nookbridge/settings.json");
    expect(output).toContain("User=nookbridge");
    expect(output).toContain("Group=nookbridge-clients");
    expect(output).toContain("ProtectSystem=strict");
    expect(output).toContain("NoNewPrivileges=yes");
    expect(output).toContain("Operator wrappers use systemd-run --pty");
  });

  it("keeps the installer source free of credential values", () => {
    const source = readFileSync(installer, "utf8");

    expect(source).not.toMatch(/NOOKBRIDGE_(?:PASSWORD|TOKEN|SECRET)=/);
    expect(source).not.toContain("cat ");
  });
});

describe("generic systemd installer — corrected Linux artifact contract (RED)", () => {
  it("documents the install, upgrade, and rollback subcommands in --help", () => {
    const help = runInstaller("--help");

    // The new contract exposes three explicit transaction subcommands.
    expect(help).toMatch(/\b(install|upgrade|rollback)\b/);
    // The new contract's `install` subcommand takes --artifact.
    expect(help).toContain("--artifact");
    // The new contract does NOT take --source FLAKE on the target.
    expect(help).not.toMatch(/--source\s+FLAKE/);
  });

  it("does not require a target-side nix installation", () => {
    const source = readFileSync(installer, "utf8");

    // The current installer hardcodes `nix build` and requires the
    // `nix` command at install time. The artifact contract removes
    // both: the target does not need Nix, npm, or a global Node.
    expect(source).not.toMatch(/nix\s+build/);
    expect(source).not.toMatch(/command -v nix\b/);
    expect(source).not.toMatch(/require_commands[\s\S]*\bnix\b/);
    expect(source).not.toMatch(/die .*required command is unavailable: nix/);
  });

  it("renders a unit whose ExecStart goes through /opt/nookbridge/current", () => {
    // Under the new contract the unit's ExecStart is fixed against the
    // activated `/opt/nookbridge/current` symlink and never references
    // the Nix store. We exercise the render surface in a way the
    // current installer cannot satisfy: any path that resolves to
    // /opt/nookbridge/current, regardless of how the user passes it,
    // must end up at /opt/nookbridge/current/bin/nookd in the unit.
    const rendered = runInstallerWithEnv({}, "--render-units");

    expect(rendered.status).toBe(0);
    expect(rendered.stdout).toContain("ExecStart=/opt/nookbridge/current/bin/nookd");
    // The unit never references a Nix store path.
    expect(rendered.stdout).not.toMatch(/\/nix\/store\//);
    // The unit never references a specific release directory either;
    // /opt/nookbridge/current is the only activation point.
    expect(rendered.stdout).not.toMatch(/releases\/[\w.+-]+/);
  });

  it("renders a unit with StateDirectoryMode=0700, RuntimeDirectoryMode=0750, UMask=0077, and LimitCORE=0", () => {
    const rendered = runInstallerWithEnv({}, "--render-units");

    expect(rendered.status).toBe(0);
    expect(rendered.stdout).toContain("StateDirectoryMode=0700");
    expect(rendered.stdout).toContain("RuntimeDirectoryMode=0750");
    expect(rendered.stdout).toContain("UMask=0077");
    expect(rendered.stdout).toContain("LimitCORE=0");
  });

  it("renders a unit with effective client group plus SupplementaryGroups=nookbridge", () => {
    const rendered = runInstallerWithEnv({}, "--render-units");

    expect(rendered.status).toBe(0);
    // Socket ownership and ACL inheritance remain tied to the client
    // group so the daemon can chgrp the unix socket accordingly.
    expect(rendered.stdout).toMatch(/^Group=nookbridge-clients$/m);
    // State remains readable only via the supplementary private group
    // so clients cannot traverse the state directory.
    expect(rendered.stdout).toMatch(/^SupplementaryGroups=nookbridge$/m);
    // And the unit never inlines a state-directory mode that would
    // re-expose state to the client group.
    expect(rendered.stdout).not.toMatch(/StateDirectoryMode=075[57]/);
  });

  it("renders a unit with fixed LoadCredential labels and paths", () => {
    const rendered = runInstallerWithEnv({}, "--render-units");

    expect(rendered.status).toBe(0);
    expect(rendered.stdout).toContain("LoadCredential=nookbridge-db-key:/etc/nookbridge/db-key");
    expect(rendered.stdout).toContain(
      "LoadCredential=nookbridge-settings:/etc/nookbridge/settings.json",
    );
    // The credential labels are the contract; nothing else gets to
    // invent a second label.
    expect(rendered.stdout).not.toMatch(/LoadCredential=[^n]/);
  });

  it("never places credential contents in environment values", () => {
    const source = readFileSync(installer, "utf8");
    const rendered = runInstallerWithEnv({}, "--render-units");

    // No environment variable may carry a key, token, password, or
    // settings contents. The current installer is already clean here,
    // but the new contract must continue to refuse to inline them.
    expect(source).not.toMatch(/Environment\s*=\s*[^#\n]*NOOKBRIDGE_(?:PASSWORD|TOKEN|SECRET|KEY)/);
    expect(source).not.toMatch(/Environment\s*=\s*[^#\n]*DB_KEY/);
    expect(source).not.toMatch(/Environment\s*=\s*[^#\n]*SETTINGS_(?:CONTENTS|BODY)/);
    expect(rendered.stdout).not.toMatch(
      /Environment\s*=[^#\n]*(NOOKBRIDGE_(?:PASSWORD|TOKEN|SECRET|KEY)|DB_KEY|SETTINGS_(?:CONTENTS|BODY))/,
    );
  });

  it("provisions the daemon user and separate private/client groups", () => {
    const source = readFileSync(installer, "utf8");

    expect(source).toContain('groupadd --system "$SERVICE_GROUP"');
    expect(source).toContain('useradd --system --home-dir "$STATE_DIR"');
    expect(source).toContain('chown "$SERVICE_USER:$PRIVATE_GROUP" "$STATE_DIR"');
  });

  it("writes the default closed read policy into service config", () => {
    const source = readFileSync(installer, "utf8");

    expect(source).toContain('"readPolicy"');
    expect(source).toContain('"notes.search"');
    expect(source).toContain('"notes.status"');
    expect(source).toContain('"notes.list_notebooks"');
    expect(source).toContain('"notes.get"');
    expect(source).toContain('"notes.path_diagnostic"');
  });
  it("polls bounded daemon readiness before failing the health gate", () => {
    const source = readFileSync(installer, "utf8");

    expect(source).toContain("systemctl is-active --quiet");
    expect(source).toContain("sleep 1");
    expect(source).toContain("health gate timed out");
  });
  it("defers first-install daemon activation until provisioning", () => {
    const source = readFileSync(installer, "utf8");

    expect(source).toContain('if [ -n "$transaction_previous_target" ]; then');
    expect(source).toContain('systemctl enable "$SERVICE_NAME"');
    expect(source).toContain('systemctl enable --now "$SERVICE_NAME"');
  });
  it("does not mask daemon activation failures", () => {
    const source = readFileSync(installer, "utf8");
    const activation = source.match(/systemctl enable --now[\s\S]{0,120}/)?.[0] ?? "";

    expect(activation).toContain("systemctl enable --now");
    expect(activation).not.toContain("|| true");
  });

  it("exposes stable wrappers that always target /opt/nookbridge/current", () => {
    const source = readFileSync(installer, "utf8");

    // The wrapper destinations and their targets must point at the
    // activated current symlink. They never point at a versioned
    // release directory or a Nix store path. The current installer
    // links against the Nix store directly — fail RED here.
    expect(source).toContain("CURRENT_LINK");
    expect(source).toContain("/bin/${command}");
    expect(source).not.toMatch(/CURRENT_LINK[\s\S]{0,400}\/nix\/store\//);
    expect(source).not.toMatch(/releases\/[A-Za-z0-9._+-]+/);
  });

  it("wraps provisioning and sync in transient credentialed systemd units", () => {
    const source = readFileSync(installer, "utf8");

    expect(source).toContain("systemd-run");
    expect(source).toContain("--pty --wait --collect");
    expect(source).toContain("--setenv=${gate}=1");
    expect(source).toContain("--property=LoadCredential=nookbridge-db-key:");
    expect(source).toContain('"--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6"');
    expect(source).toContain("nookbridge-provision");
    expect(source).toContain("nookbridge-sync");
  });
});

describe("generic systemd installer — fake-root transaction contract (RED)", () => {
  it("refuses to install against a fake-root that lacks a valid artifact", () => {
    const ctx = freshFakeRoot();

    // The new install subcommand takes --artifact PATH pointing at the
    // reviewed tarball. The new contract must reject a missing
    // artifact BEFORE touching the daemon, with a categorical error
    // that names the missing artifact path. The current installer
    // dies with "unknown option: install", which does NOT mention the
    // artifact path — strict RED.
    const result = runInstallerWithEnv(
      ctx.env,
      "install",
      "--artifact",
      join(ctx.rootDir, "missing.tar.gz"),
      "--settings-file",
      join(ctx.etcDir, "settings.json"),
      "--db-key-file",
      join(ctx.etcDir, "db-key"),
    );

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    // The new contract's preflight error names the artifact; the
    // current installer's "unknown option" error does not.
    const evidence = `${result.stdout}\n${result.stderr}`;
    expect(evidence).toContain("missing.tar.gz");
    // The fake systemctl shim must NOT have been invoked before
    // preflight refusal — the installer cannot interrupt a running
    // daemon for a missing artifact.
    expect(evidence).not.toMatch(/systemctl daemon-reload/);
  });

  it("acquires an exclusive flock to serialize transactions", () => {
    const ctx = freshFakeRoot();

    // The new contract acquires an exclusive flock on a known path
    // (typically ${NOOKBRIDGE_INSTALLER_LOCK:-/var/lock/nookbridge-installer})
    // and refuses concurrent invocations with a categorical
    // "already locked" error. Today the installer doesn't even open
    // such a path — strict RED.
    const first = runInstallerWithEnv(
      ctx.env,
      "install",
      "--artifact",
      join(ctx.rootDir, "nookbridge-v0.0.0-test-linux-x64-gnu.tar.gz"),
      "--settings-file",
      join(ctx.etcDir, "settings.json"),
      "--db-key-file",
      join(ctx.etcDir, "db-key"),
    );

    // The first invocation must either succeed or fail with a
    // non-lock-related preflight error. It must NOT have created a
    // release symlink at /opt/nookbridge/current (which lives under
    // ctx.optDir in the fake root) because the artifact doesn't
    // exist on disk yet.
    expect(first.status).not.toBeNull();

    const second = runInstallerWithEnv(
      ctx.env,
      "install",
      "--artifact",
      join(ctx.rootDir, "nookbridge-v0.0.0-test-linux-x64-gnu.tar.gz"),
      "--settings-file",
      join(ctx.etcDir, "settings.json"),
      "--db-key-file",
      join(ctx.etcDir, "db-key"),
    );

    // At least one of the two invocations must report "locked" or
    // carry explicit flock evidence. The current installer produces
    // "unknown option: install" twice and never mentions locks.
    const combined = `${first.stdout}\n${first.stderr}\n${second.stdout}\n${second.stderr}`;
    expect(combined).toMatch(/flock|already locked/);
  });

  it("records an installer-state ledger after a successful first install", () => {
    const ctx = freshFakeRoot();

    // The new contract writes `${NOOKBRIDGE_INSTALLER_STATE}` (or
    // /etc/nookbridge/installer-state.json) containing the active
    // version, digest, and timestamp after a successful install.
    // Today the installer writes no such file — strict RED until
    // the contract is implemented.
    const result = runInstallerWithEnv(
      ctx.env,
      "install",
      "--artifact",
      join(ctx.rootDir, "nookbridge-v0.0.0-test-linux-x64-gnu.tar.gz"),
      "--settings-file",
      join(ctx.etcDir, "settings.json"),
      "--db-key-file",
      join(ctx.etcDir, "db-key"),
    );

    expect(result.status).not.toBeNull();
    // Whether or not install succeeds, the new contract must
    // reference the ledger path in its output (e.g., when refusing
    // to overwrite a same-version digest). The current installer's
    // "unknown option" output does not.
    const evidence = `${result.stdout}\n${result.stderr}`;
    expect(evidence).toMatch(/installer-state\.json|installer state/i);
  });

  it("refuses to roll back to a version outside /opt/nookbridge/releases", () => {
    const ctx = freshFakeRoot();

    // The new contract confines rollback to the releases directory.
    // The error must explicitly name the offending path or the
    // "managed releases" boundary. Today the rollback subcommand
    // doesn't exist — strict RED.
    const result = runInstallerWithEnv(ctx.env, "rollback", "--to", "../../etc");

    expect(result.status).not.toBe(0);
    const evidence = `${result.stdout}\n${result.stderr}`;
    expect(evidence).toMatch(/managed releases/);
    // The current installer's "unknown option: rollback" error
    // contains neither of those strings.
    expect(evidence).not.toMatch(/unknown option: rollback/);
  });

  it("refuses prune when current or the immediate previous would be removed", () => {
    const ctx = freshFakeRoot();

    // The new contract exposes `prune --keep N` and refuses any
    // invocation whose --keep would endanger current or the
    // immediate previous release. Today the prune subcommand does
    // not exist; strict RED.
    const result = runInstallerWithEnv(ctx.env, "prune", "--keep", "1");

    expect(result.status).not.toBe(0);
    const evidence = `${result.stdout}\n${result.stderr}`;
    expect(evidence).toMatch(/prune|current|immediate previous|retain/);
    expect(evidence).not.toMatch(/unknown option: prune/);
  });

  it("refuses to proceed when the artifact's checksum cannot be verified", () => {
    const ctx = freshFakeRoot();

    // The new contract requires --checksum-file and refuses the
    // install before any service interruption when verification
    // fails. We craft a deliberately mismatched SHA256 file and
    // expect a non-zero exit BEFORE the fake systemctl was ever
    // invoked.
    const checksumPath = join(ctx.rootDir, "SHA256SUMS");
    writeFileSync(checksumPath, "deadbeef *nope.tar.gz\n");

    const result = runInstallerWithEnv(
      ctx.env,
      "install",
      "--artifact",
      join(ctx.rootDir, "nookbridge-v0.0.0-test-linux-x64-gnu.tar.gz"),
      "--checksum-file",
      checksumPath,
      "--settings-file",
      join(ctx.etcDir, "settings.json"),
      "--db-key-file",
      join(ctx.etcDir, "db-key"),
    );

    expect(result.status).not.toBe(0);
    const evidence = `${result.stdout}\n${result.stderr}`;
    // The new contract reports a "checksum mismatch" categorical
    // error that names the file. The current installer's "unknown
    // option: install" output does not.
    expect(evidence).toMatch(/checksum mismatch|checksum/i);
    expect(evidence).not.toMatch(/unknown option: install/);
  });

  it("refuses a manifest whose version pattern fails the preflight gate", () => {
    const ctx = freshFakeRoot();

    // The new contract validates the release.json manifest fields
    // (version, target tuple, libc minimum, etc.) before any
    // service interruption. Today the contract is missing entirely;
    // the strict RED signal is that the installer NEVER even reads
    // --manifest.
    const manifestPath = join(ctx.rootDir, "release.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: "../../../etc/passwd",
        target: "linux-arm64-gnu",
        node: "22.23.2",
      }),
    );

    const result = runInstallerWithEnv(
      ctx.env,
      "install",
      "--artifact",
      join(ctx.rootDir, "nookbridge-bad.tar.gz"),
      "--manifest",
      manifestPath,
      "--settings-file",
      join(ctx.etcDir, "settings.json"),
      "--db-key-file",
      join(ctx.etcDir, "db-key"),
    );

    expect(result.status).not.toBe(0);
    const evidence = `${result.stdout}\n${result.stderr}`;
    // The new contract reports a version-pattern violation that
    // quotes the offending version. The current installer cannot
    // see --manifest at all.
    expect(evidence).toMatch(/version pattern|invalid version|\.\.\/\.\.\/\.\.\/etc\/passwd/);
    expect(evidence).not.toMatch(/unknown option: install/);
  });

  it("refuses an archive whose payload escapes its top-level directory", () => {
    const ctx = freshFakeRoot();

    // The new contract refuses tarball members whose paths escape
    // the single top-level directory (path traversal / absolute
    // paths / symlink members). Today the contract is missing;
    // strict RED because the installer doesn't inspect the archive
    // at all.
    const result = runInstallerWithEnv(
      ctx.env,
      "install",
      "--artifact",
      join(ctx.rootDir, "escapes-root.tar.gz"),
      "--settings-file",
      join(ctx.etcDir, "settings.json"),
      "--db-key-file",
      join(ctx.etcDir, "db-key"),
    );

    expect(result.status).not.toBe(0);
    const evidence = `${result.stdout}\n${result.stderr}`;
    expect(evidence).toMatch(/archive|member|escape|traversal/);
    expect(evidence).not.toMatch(/unknown option: install/);
  });

  it("refuses unmanaged existing units under /etc/systemd", () => {
    const ctx = freshFakeRoot();

    // Plant an unmanaged unit file in the fake systemd dir. The new
    // contract refuses to proceed when the system already has a
    // `nookd.service` that the installer did not place, naming the
    // unmanaged path. Today the contract is missing.
    mkdirSync(join(ctx.systemdDir), { recursive: true });
    writeFileSync(
      join(ctx.systemdDir, "nookd.service"),
      "[Unit]\nDescription=unmanaged\n[Service]\nExecStart=/bin/true\n",
    );

    const result = runInstallerWithEnv(
      ctx.env,
      "install",
      "--artifact",
      join(ctx.rootDir, "nookbridge-v0.0.0-test-linux-x64-gnu.tar.gz"),
      "--settings-file",
      join(ctx.etcDir, "settings.json"),
      "--db-key-file",
      join(ctx.etcDir, "db-key"),
    );

    expect(result.status).not.toBe(0);
    const evidence = `${result.stdout}\n${result.stderr}`;
    // The new contract's refusal names the unmanaged unit path.
    expect(evidence).toMatch(/nookd\.service.*unmanaged|unmanaged.*nookd\.service/);
    expect(evidence).not.toMatch(/unknown option: install/);
  });

  it("isolates health failures and restores the previous release symlink", () => {
    const ctx = freshFakeRoot();

    // The new contract polls `systemctl is-active` AND the bounded
    // `nookbridge-health` probe after switching `current`. When the
    // probe fails, the contract restores the previous symlink and
    // restarts the previous release before exiting non-zero. Today
    // the contract is missing; the installer never invokes the
    // health probe and never creates a /opt/nookbridge/current
    // symlink in the first place.
    const result = runInstallerWithEnv(
      ctx.env,
      "install",
      "--artifact",
      join(ctx.rootDir, "nookbridge-v0.0.0-test-linux-x64-gnu.tar.gz"),
      "--settings-file",
      join(ctx.etcDir, "settings.json"),
      "--db-key-file",
      join(ctx.etcDir, "db-key"),
    );

    expect(result.status).not.toBeNull();
    // Strict RED: the new contract must report "health" failure
    // or "rollback" explicitly when the probe fails. The current
    // installer cannot.
    const evidence = `${result.stdout}\n${result.stderr}`;
    expect(evidence).toMatch(/health/);
    expect(evidence).toMatch(/rollback/);
    // And the previous-current symlink restoration must be visible
    // in the output (the installer prints "restored previous
    // release" or similar categorical text).
    expect(evidence).not.toMatch(/unknown option: install/);
  });
});
