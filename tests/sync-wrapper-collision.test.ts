/**
 * Fetch-only sync wrapper collision contract.
 *
 * Regression coverage for the documented live failure mode:
 *   `/var/lib/nookbridge/nookbridge.lock` is held by the active
 *   `nookd` process; the operator `nookbridge-sync` wrapper used to
 *   start a second process that opened the same state and exited 3
 *   because PersistentStorage deliberately enforces a single-instance
 *   lock (src/storage/persistent-storage.ts + src/config/lock.ts).
 *
 * The contract under test (install-systemd.sh install_operator_wrapper):
 *
 *   1. The generated `/usr/local/bin/nookbridge-sync` wrapper stops
 *      `nookd.service` BEFORE invoking the sync transient unit so the
 *      transient unit is the only DB-owning process on the state.
 *   2. The wrapper always restarts `nookd.service` after the sync
 *      command exits — both on success and on failure (trap-driven
 *      cleanup so a failing sync never leaves the daemon stopped).
 *   3. The wrapper preserves the sync command's categorical exit
 *      status; the wrapper does NOT mask sync failures with its own
 *      "restart failed" exit code unless the restart itself failed.
 *   4. The wrapper still routes the sync command through the
 *      hardened `systemd-run --quiet --pty --wait --collect` transient
 *      unit with fixed LoadCredential labels (regression guard).
 *   5. The wrapper source contains NO credential values and does NOT
 *      echo state paths.
 *   6. The wrapper is still root-gated (a non-root invocation exits
 *      with a categorical 77 before touching systemctl).
 *
 * The tests deliberately avoid inspecting live state contents,
 * credentials, or note corpus data; everything routes through the
 * installer-fake-root + shimmed systemctl/systemd-run.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createInstallerFakeRoot,
  disposeInstallerFakeRoot,
  type InstallerFakeRoot,
} from "./fixtures/installer-fake-root.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(repositoryRoot, "scripts/install-systemd.sh");
const builder = join(repositoryRoot, "scripts/build-linux-artifact.sh");

const fakeRoots: InstallerFakeRoot[] = [];
const artifactRoots: string[] = [];
const logRoots: string[] = [];

function createArtifact(): { artifact: string; checksum: string } {
  const root = mkdtempSync(join(tmpdir(), "nookbridge-sync-wrapper-artifact-"));
  artifactRoots.push(root);
  const source = join(root, "source");
  const runtime = join(root, "node-runtime");
  const output = join(root, "output");
  mkdirSync(join(source, "dist", "mcp"), { recursive: true });
  mkdirSync(join(source, "node_modules"), { recursive: true });
  mkdirSync(output, { recursive: true });
  for (const file of [
    "nookd.js",
    "cli.js",
    "provision.js",
    "sync.js",
    "health.js",
    "runtime-check.js",
  ]) {
    writeFileSync(join(source, "dist", file), "#!/bin/sh\n");
  }
  writeFileSync(join(source, "dist", "mcp", "cli.js"), "#!/bin/sh\n");
  writeFileSync(join(source, "node_modules", "marker.js"), "module.exports = {};\n");
  writeFileSync(join(source, "package.json"), '{"name":"fixture"}\n');
  writeFileSync(join(source, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(source, "LICENSE"), "fixture license\n");
  // The portable artifact must ship the operator peer-credential helper.
  const peercredHelper = join(root, "operator-peercred-helper");
  writeFileSync(peercredHelper, "#!/bin/sh\nexit 0\n");
  chmodSync(peercredHelper, 0o755);
  writeFileSync(
    runtime,
    '#!/bin/sh\ncase "$1" in --version) printf "%s\\n" v22.23.2 ;; -p) printf "%s\\n" 127 ;; esac\n',
  );
  chmodSync(runtime, 0o755);
  execFileSync("git", ["-C", source, "init", "-q"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Fixture"]);
  execFileSync("git", ["-C", source, "config", "user.email", "fixture@example.invalid"]);
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "fixture"]);
  execFileSync("bash", [
    builder,
    "--source-dir",
    source,
    "--node-runtime",
    runtime,
    "--operator-peercred-helper",
    peercredHelper,
    "--output-dir",
    output,
    "--version",
    "1.2.3",
    "--source-date-epoch",
    "1790000000",
    "--min-glibc",
    "2.31",
    "--min-libstdcxx",
    "GLIBCXX_3.4.29",
  ]);
  return {
    artifact: join(output, "nookbridge-v1.2.3-linux-x64-gnu.tar.gz"),
    checksum: join(output, "SHA256SUMS"),
  };
}

function envFor(
  ctx: InstallerFakeRoot,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  return { ...process.env, ...ctx.env, ...overrides };
}

/**
 * Build a wrapper-direct test context.
 *
 * Installs the artifact under the installer fake root (which generates
 * the `nookbridge-sync` operator wrapper), then replaces the shimmed
 * `systemctl` and `systemd-run` binaries with deterministic recorders
 * so the wrapper's behavior can be observed end-to-end without
 * touching the real host.
 *
 * Returns the resolved wrapper path and the recorder log path.
 */
function setupSyncWrapper(opts: {
  syncExitStatus: number;
  stopExitStatus?: number;
  startExitStatus?: number;
  syncStderr?: string;
}): { ctx: InstallerFakeRoot; wrapperPath: string; logPath: string } {
  const ctx = createInstallerFakeRoot();
  fakeRoots.push(ctx);
  const { artifact, checksum } = createArtifact();
  const result = spawnSync(
    "bash",
    [installer, "install", "--artifact", artifact, "--checksum-file", checksum],
    { cwd: repositoryRoot, env: envFor(ctx), encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `install failed: status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }

  const logRoot = mkdtempSync(join(tmpdir(), "nookbridge-sync-wrapper-log-"));
  logRoots.push(logRoot);
  const logPath = join(logRoot, "wrapper-trace.log");

  // Replace the fake systemctl with a recorder that captures every
  // invocation and exits according to the test's configured stop/start
  // behavior. The original installer-fake-root shim only knows how to
  // answer `is-active`; the wrapper under test never calls `is-active`,
  // so we can replace it without affecting other tests.
  const systemctlRecorder = [
    "#!/usr/bin/env bash",
    "# Wrapper-direct systemctl recorder. Logs every invocation.",
    "set -eu",
    `printf '%s\\n' "systemctl $*" >> "${logPath}"`,
    'case "$1" in',
    "  stop)",
    `    exit ${opts.stopExitStatus ?? 0}`,
    "    ;;",
    "  start)",
    `    exit ${opts.startExitStatus ?? 0}`,
    "    ;;",
    "  restart)",
    "    # The legacy provision wrapper still uses restart; keep recording.",
    `    exit ${opts.startExitStatus ?? 0}`,
    "    ;;",
    "  *)",
    "    exit 0",
    "    ;;",
    "esac",
    "",
  ].join("\n");
  writeFileSync(join(ctx.binDir, "systemctl"), systemctlRecorder, { mode: 0o755 });

  // The wrapper's root gate inspects `id -u`. The test runner is
  // not actually root, but the wrapper only enforces a structural
  // precondition we are explicitly proving here; shadow `id` so the
  // wrapper's gate reports uid 0. Tests that probe the non-root
  // branch re-shadow this shim with one that reports a non-zero uid.
  writeFileSync(
    join(ctx.binDir, "id"),
    [
      "#!/usr/bin/env bash",
      'if [ "${1:-}" = "-u" ]; then printf "%s\\n" 0; exit 0; fi',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  // Replace systemd-run with a recorder that simulates the transient
  // sync unit. The wrapper passes --unit, --uid, --gid, --setenv, the
  // hardening --property= flags, and finally the sync CLI path with
  // the operator-supplied args. We extract the binary name and exit
  // with the test's configured status, optionally emitting a stderr
  // line so the wrapper's status propagation can be exercised.
  const systemdRunRecorder = [
    "#!/usr/bin/env bash",
    "# Wrapper-direct systemd-run recorder. Logs the call and exits.",
    "set -eu",
    `printf 'systemd-run ' >> "${logPath}"`,
    `printf '%s\\n' "$*" >> "${logPath}"`,
    // Find the last non-flag token; that is the sync CLI path. The
    // wrapper always appends it as the final argument.
    `sync_cli=''`,
    `for arg in "$@"; do`,
    `  case "$arg" in`,
    `    --*) ;;`,
    `    -*) ;;`,
    `    *) sync_cli="$arg" ;;`,
    `  esac`,
    `done`,
    `printf 'sync_cli=%s\\n' "$sync_cli" >> "${logPath}"`,
    // The shim's exit status is the test's configured sync exit
    // status; that is what the wrapper must propagate to its caller.
    `exit ${opts.syncExitStatus}`,
    "",
  ].join("\n");
  writeFileSync(join(ctx.binDir, "systemd-run"), systemdRunRecorder, { mode: 0o755 });

  const wrapperPath = join(ctx.usrLocalBinDir, "nookbridge-sync");
  if (!existsSync(wrapperPath)) {
    throw new Error(`wrapper not generated at ${wrapperPath}`);
  }
  return { ctx, wrapperPath, logPath };
}

afterEach(() => {
  disposeInstallerFakeRoot();
  fakeRoots.length = 0;
  for (const root of artifactRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const root of logRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("nookbridge-sync operator wrapper — single-instance lock collision contract", () => {
  it("stops nookd.service before invoking the sync transient unit", () => {
    const { ctx, wrapperPath, logPath } = setupSyncWrapper({ syncExitStatus: 0 });

    const result = spawnSync(wrapperPath, [], {
      cwd: repositoryRoot,
      env: envFor(ctx),
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const trace = readFileSync(logPath, "utf8");
    const stopIndex = trace.indexOf("systemctl stop nookd.service");
    const systemdRunIndex = trace.indexOf("systemd-run ");
    expect(stopIndex, `trace=${trace}`).toBeGreaterThanOrEqual(0);
    expect(systemdRunIndex, `trace=${trace}`).toBeGreaterThanOrEqual(0);
    // The stop must precede the systemd-run invocation. If the wrapper
    // invokes systemd-run first, the sync transient unit will collide
    // with the live nookd process on nookbridge.lock — the exact
    // failure mode this contract is meant to prevent.
    expect(stopIndex).toBeLessThan(systemdRunIndex);
  });

  it("restarts nookd.service after a successful sync command", () => {
    const { ctx, wrapperPath, logPath } = setupSyncWrapper({ syncExitStatus: 0 });

    const result = spawnSync(wrapperPath, [], {
      cwd: repositoryRoot,
      env: envFor(ctx),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const trace = readFileSync(logPath, "utf8");
    expect(trace).toMatch(/systemctl start nookd\.service/);
    // Restart-on-success must come AFTER the systemd-run invocation;
    // otherwise the live daemon would be torn down after sync has
    // already returned and never restored.
    const runIndex = trace.indexOf("systemd-run ");
    const startIndex = trace.indexOf("systemctl start nookd.service");
    expect(runIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(runIndex);
  });

  it("restarts nookd.service after a failed sync command", () => {
    // The wrapper MUST restart the daemon even when the sync command
    // itself fails; otherwise a transient fetch-only sync failure
    // would leave the daemon permanently stopped, breaking every
    // downstream MCP client. This is the trap/finally-equivalent
    // contract the task requires.
    const { ctx, wrapperPath, logPath } = setupSyncWrapper({ syncExitStatus: 7 });

    const result = spawnSync(wrapperPath, [], {
      cwd: repositoryRoot,
      env: envFor(ctx),
      encoding: "utf8",
    });

    // The wrapper must propagate the sync command's categorical exit
    // status. Exit 7 here is arbitrary but stable; any non-zero
    // status must round-trip without being masked.
    expect(result.status).toBe(7);
    const trace = readFileSync(logPath, "utf8");
    expect(trace).toMatch(/systemctl start nookd\.service/);
    const runIndex = trace.indexOf("systemd-run ");
    const startIndex = trace.indexOf("systemctl start nookd.service");
    expect(runIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(runIndex);
  });

  it("does not run sync when stopping nookd.service fails", () => {
    const { ctx, wrapperPath, logPath } = setupSyncWrapper({
      syncExitStatus: 0,
      stopExitStatus: 9,
    });

    const result = spawnSync(wrapperPath, [], {
      cwd: repositoryRoot,
      env: envFor(ctx),
      encoding: "utf8",
    });

    expect(result.status).toBe(9);
    const trace = readFileSync(logPath, "utf8");
    expect(trace).toMatch(/systemctl stop nookd\.service/);
    expect(trace).toMatch(/systemctl start nookd\.service/);
    expect(trace).not.toMatch(/systemd-run/);
  });

  it("propagates the sync command's exit status without masking it", () => {
    // The wrapper must NOT collapse categorical upstream failures
    // into its own status. If the sync exits 3 (the value the live
    // probe observed when the lock collided), the operator must see
    // 3, not 0 and not 1.
    for (const syncStatus of [0, 1, 2, 3, 7]) {
      const { ctx, wrapperPath } = setupSyncWrapper({ syncExitStatus: syncStatus });

      const result = spawnSync(wrapperPath, [], {
        cwd: repositoryRoot,
        env: envFor(ctx),
        encoding: "utf8",
      });

      expect(result.status, `syncStatus=${syncStatus}`).toBe(syncStatus);
    }
  });

  it("uses the hardened systemd-run transient unit (regression guard)", () => {
    // The sync wrapper must continue to route the sync command
    // through the hardened `systemd-run --quiet --pty --wait --collect`
    // transient unit with the fixed LoadCredential labels. Stopping
    // nookd is the new behavior; this is the existing behavior that
    // must NOT be broken in the same change.
    const { ctx, wrapperPath, logPath } = setupSyncWrapper({ syncExitStatus: 0 });

    const result = spawnSync(wrapperPath, [], {
      cwd: repositoryRoot,
      env: envFor(ctx),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const trace = readFileSync(logPath, "utf8");
    expect(trace).toMatch(/systemd-run [^]*--quiet/);
    expect(trace).toMatch(/--pty/);
    expect(trace).toMatch(/--wait/);
    expect(trace).toMatch(/--collect/);
    expect(trace).toMatch(/--unit=nookbridge-sync\.service/);
    expect(trace).toMatch(/--setenv=NOOKBRIDGE_ENABLE_LIVE_SYNC=1/);
    expect(trace).toMatch(/--property=LoadCredential=nookbridge-db-key:\/etc\/nookbridge\/db-key/);
    expect(trace).toMatch(/--uid=nookbridge/);
    expect(trace).toMatch(/--gid=nookbridge-clients/);
    expect(trace).toMatch(/--property=ProtectSystem=strict/);
    expect(trace).toMatch(/--property=NoNewPrivileges=yes/);
    expect(trace).toMatch(/nookbridge-sync-cli/);
  });

  it("never embeds credentials, env secrets, or note corpus data in the wrapper source", () => {
    // The wrapper is shipped on disk; the contract requires it stay
    // free of credential-shaped values regardless of how it was
    // generated. Use the post-install wrapper content rather than the
    // installer source so this stays focused on the artifact.
    const { wrapperPath } = setupSyncWrapper({ syncExitStatus: 0 });
    const source = readFileSync(wrapperPath, "utf8");
    expect(source).not.toMatch(/NOOKBRIDGE_(?:PASSWORD|TOKEN|SECRET)=/);
    expect(source).not.toMatch(/Environment\s*=[^#\n]*NOOKBRIDGE_(?:PASSWORD|TOKEN|SECRET|KEY)/);
    expect(source).not.toMatch(/[0-9a-fA-F]{64}/);
    expect(source).not.toMatch(/db-key contents/i);
    expect(source).not.toContain("nookbridge.lock");
  });

  it("emits the suspend preamble and trap pattern in the generated wrapper", () => {
    // Sanity: the wrapper source itself contains the stop/trap/start
    // sequence the contract requires. This guards against a regression
    // where install_operator_wrapper silently drops the suspend
    // branch — for example, if a future refactor turns the parameter
    // into a no-op. The end-to-end tests above already exercise the
    // behavior; this test pins the wrapper source shape.
    const { wrapperPath } = setupSyncWrapper({ syncExitStatus: 0 });
    const source = readFileSync(wrapperPath, "utf8");
    // Stop runs before the systemd-run invocation.
    const stopIndex = source.indexOf("systemctl stop nookd.service");
    const runIndex = source.indexOf("systemd-run --quiet --pty --wait --collect");
    expect(stopIndex, `source=${source}`).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThan(stopIndex);
    // The trap runs systemctl start; the start call comes BEFORE the
    // systemd-run invocation in the source (it is registered as a
    // trap before systemd-run is invoked).
    const trapIndex = source.indexOf("systemctl start nookd.service");
    expect(trapIndex, `source=${source}`).toBeGreaterThanOrEqual(0);
    expect(trapIndex).toBeLessThan(runIndex);
    expect(source).toMatch(/trap 'restore_nookd' EXIT INT TERM HUP/);
    expect(source).toMatch(/systemctl is-active --quiet nookd\.service/);
    // The sync wrapper does NOT use `systemctl restart nookd.service`
    // (which would mask a sync failure). It only uses start in the
    // state-preserving trap and stop in the preamble.
    expect(source).not.toMatch(/systemctl restart nookd\.service/);
  });

  it("is still a regular file that is root-executable, not a symlink", () => {
    // The wrapper must remain a real script with the correct mode so
    // the operator invocation path stays unchanged. Existing
    // assertions in the suite already verify this for provision; the
    // sync wrapper must match.
    const { wrapperPath } = setupSyncWrapper({ syncExitStatus: 0 });
    const stat = lstatSync(wrapperPath);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o755).toBe(0o755);
  });

  it("exits with 77 and never touches systemctl when invoked without root", () => {
    // The existing root-gate contract must be preserved. The test
    // installs the wrapper, then forces the id shim to report a
    // non-zero uid so the wrapper's root check fails. If the gate is
    // broken, the test process's lack of systemctl permissions would
    // mask the real regression.
    const ctx = createInstallerFakeRoot();
    fakeRoots.push(ctx);
    const { artifact, checksum } = createArtifact();
    const installResult = spawnSync(
      "bash",
      [installer, "install", "--artifact", artifact, "--checksum-file", checksum],
      { cwd: repositoryRoot, env: envFor(ctx), encoding: "utf8" },
    );
    expect(installResult.status).toBe(0);

    // Override id so the wrapper's root check fails, then record what
    // (if anything) the wrapper invoked.
    const logRoot = mkdtempSync(join(tmpdir(), "nookbridge-sync-wrapper-noroot-"));
    logRoots.push(logRoot);
    const logPath = join(logRoot, "trace.log");
    // Force the systemctl shim to log every invocation. If the root
    // gate is broken, the wrapper will reach this shim and the trace
    // will catch it.
    writeFileSync(
      join(ctx.binDir, "systemctl"),
      ["#!/usr/bin/env bash", `printf '%s\\n' "systemctl $*" >> "${logPath}"`, "exit 99", ""].join(
        "\n",
      ),
      { mode: 0o755 },
    );
    // Replace id with a shim that reports a non-zero uid regardless
    // of the real test runner's identity. The wrapper's `[ "$(id -u)"
    // -ne 0 ]` check then trips and exits 77 before touching systemctl.
    writeFileSync(
      join(ctx.binDir, "id"),
      [
        "#!/usr/bin/env bash",
        'if [ "${1:-}" = "-u" ]; then printf "%s\\n" 1000; exit 0; fi',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const wrapperPath = join(ctx.usrLocalBinDir, "nookbridge-sync");
    const result = spawnSync(wrapperPath, [], {
      cwd: repositoryRoot,
      env: envFor(ctx),
      encoding: "utf8",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(77);
    expect(result.stderr).toMatch(/must be run as root/);
    // The root gate must be the FIRST observable side effect; no
    // systemctl invocation can sneak past it.
    let trace = "";
    try {
      trace = readFileSync(logPath, "utf8");
    } catch {
      trace = "";
    }
    expect(trace).not.toMatch(/systemctl/);
  });
});
