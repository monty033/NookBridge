/**
 * Deterministic fake-root transaction fixture for the generic Linux
 * artifact-installer (Task 1 of the approved plan).
 *
 * This fixture is intentionally narrow: it only shapes the small slice
 * of host state the rewritten installer is permitted to inspect or
 * mutate, without touching the real host filesystem, systemd, accounts,
 * or processes. All state changes happen inside a temporary directory
 * created via `mkdtempSync(join(tmpdir(), …))` and torn down by the
 * caller's `afterEach`.
 *
 * The fixture does not implement the new installer behavior — it
 * exposes hooks the future installer will be expected to honor. The
 * RED tests in `tests/systemd-installer.test.ts` assert the contract
 * against the existing installer source and any candidate replacement;
 * they fail RED today because the candidate installer does not yet
 * exist.
 *
 * The fixture deliberately avoids:
 *  - writing under /etc, /opt, /var/lib, /run, /usr/local/bin;
 *  - invoking the real systemctl, groupadd, useradd, or id;
 *  - touching any path the test harness itself depends on;
 *  - embedding credentials, tokens, passwords, or note content.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Shape of a single fake-root transaction context.
 *
 * The contract under test (per the approved plan, §6) treats the
 * installer as a transaction that operates on a virtualized root
 * (`rootDir`), an isolated command `bin` directory that shadows the
 * host's privileged helpers, and a fixed release-layout template. Tests
 * pass this context to the installer via environment variables the
 * future installer must consume.
 */
export type InstallerFakeRoot = Readonly<{
  /** Isolated root the future installer is expected to treat as `/`. */
  rootDir: string;
  /** Isolated bin dir pre-populated with shimmed privileged commands. */
  binDir: string;
  /** Path inside `rootDir` that mirrors the new managed layout. */
  optDir: string;
  /** Path inside `rootDir` that mirrors `/etc/nookbridge`. */
  etcDir: string;
  /** Path inside `rootDir` that mirrors `/var/lib/nookbridge`. */
  stateDir: string;
  /** Path inside `rootDir` that mirrors `/run/nookbridge`. */
  runtimeDir: string;
  /** Path inside `rootDir` that mirrors `/etc/systemd/system`. */
  systemdDir: string;
  /** Path inside `rootDir` that mirrors `/usr/local/bin`. */
  usrLocalBinDir: string;
  /** Path of the shimmed `systemctl` recording invocations. */
  systemctlPath: string;
  /** Path of the shimmed `nookbridge-health` recording invocations. */
  healthPath: string;
  /** Path of the installer-state ledger the future installer must write. */
  installerStatePath: string;
  /**
   * Environment map the future installer must consume when invoked.
   * Today the installer ignores these — the RED tests assert the
   * candidate installer reads them. Real `/etc`, `/opt`, `/var/lib`,
   * `/run`, and `/usr/local/bin` are NEVER touched because all
   * paths below are private to the temp directory.
   */
  env: Readonly<Record<string, string>>;
}>;

/**
 * Options for {@link createInstallerFakeRoot}.
 */
export type CreateInstallerFakeRootOptions = Readonly<{
  /**
   * Working directory for the fake root. Defaults to a unique entry
   * under `os.tmpdir()` so each test starts from a clean slate.
   */
  cwd?: string;
  /**
   * Optional override for the systemctl failure mode the shim should
   * use for `is-active` probes. Today the shim does nothing — these
   * flags only describe the contract the future installer must
   * observe.
   */
  systemctlIsActive?: "active" | "inactive" | "failed";
}>;

const createdDirectories: string[] = [];

/**
 * Mark a directory for cleanup. The test file's `afterEach` must call
 * {@link disposeInstallerFakeRoot} to actually remove them.
 */
function track(directory: string): string {
  createdDirectories.push(directory);
  return directory;
}

/**
 * Tear down every fake-root directory created by
 * {@link createInstallerFakeRoot} in this process.
 *
 * Tests should call this from their `afterEach`. The function is
 * idempotent and safe to call multiple times.
 */
export function disposeInstallerFakeRoot(): void {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

/**
 * Create a fresh fake-root transaction context.
 *
 * The returned context lays down:
 *
 *  - `<rootDir>/opt/nookbridge/releases` (empty)
 *  - `<rootDir>/opt/nookbridge/current` (empty, will be a symlink)
 *  - `<rootDir>/etc/nookbridge` (empty)
 *  - `<rootDir>/etc/systemd/system` (empty)
 *  - `<rootDir>/var/lib/nookbridge` (empty)
 *  - `<rootDir>/run/nookbridge` (empty)
 *  - `<rootDir>/usr/local/bin` (empty)
 *  - `<rootDir>/bin/systemctl` (shim that records invocations)
 *  - `<rootDir>/bin/nookbridge-health` (shim that records invocations)
 *
 * The `env` map contains the variable names the future installer must
 * consume to redirect its privileged operations into the fake root.
 * Tests assert the candidate installer reads these — today it does not,
 * which is exactly the RED signal we want.
 *
 * The fake-root paths are absolute and never overlap the host's real
 * privileged directories. They live entirely under `os.tmpdir()`.
 */
export function createInstallerFakeRoot(
  options: CreateInstallerFakeRootOptions = {},
): InstallerFakeRoot {
  const base = options.cwd ?? mkdtempSync(join(tmpdir(), "nookbridge-installer-fake-"));
  track(base);

  const rootDir = base;
  const binDir = join(rootDir, "bin");
  const optDir = join(rootDir, "opt", "nookbridge");
  const releasesDir = join(optDir, "releases");
  const etcDir = join(rootDir, "etc", "nookbridge");
  const stateDir = join(rootDir, "var", "lib", "nookbridge");
  const runtimeDir = join(rootDir, "run", "nookbridge");
  const systemdDir = join(rootDir, "etc", "systemd", "system");
  const usrLocalBinDir = join(rootDir, "usr", "local", "bin");

  for (const directory of [
    binDir,
    releasesDir,
    etcDir,
    stateDir,
    runtimeDir,
    systemdDir,
    usrLocalBinDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  const systemctlPath = join(binDir, "systemctl");
  writeFileSync(
    systemctlPath,
    [
      "#!/usr/bin/env bash",
      "# Fake systemctl shim. Records every invocation to ${NOOKBRIDGE_FAKE_LOG}.",
      "set -euo pipefail",
      'printf \'%s\\n\' "systemctl $*" >> "${NOOKBRIDGE_FAKE_LOG:-/dev/null}"',
      'case "$1" in',
      "  is-active)",
      '    case "${NOOKBRIDGE_FAKE_IS_ACTIVE:-active}" in',
      "      active) printf '%s\\n' active; exit 0 ;;",
      "      inactive) printf '%s\\n' inactive; exit 3 ;;",
      "      failed) printf '%s\\n' failed; exit 3 ;;",
      "    esac",
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const healthPath = join(binDir, "nookbridge-health");
  writeFileSync(
    healthPath,
    [
      "#!/usr/bin/env bash",
      "# Fake nookbridge-health shim. Records every invocation.",
      "set -euo pipefail",
      'printf \'%s\\n\' "nookbridge-health $*" >> "${NOOKBRIDGE_FAKE_LOG:-/dev/null}"',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const installerStatePath = join(etcDir, "installer-state.json");

  const env: Record<string, string> = {
    NOOKBRIDGE_FAKE_ROOT: rootDir,
    NOOKBRIDGE_FAKE_BIN: binDir,
    NOOKBRIDGE_FAKE_IS_ACTIVE: options.systemctlIsActive ?? "active",
    NOOKBRIDGE_INSTALLER_STATE: installerStatePath,
    NOOKBRIDGE_RELEASES_DIR: releasesDir,
    NOOKBRIDGE_OPT_DIR: optDir,
    NOOKBRIDGE_ETC_DIR: etcDir,
    NOOKBRIDGE_STATE_DIR: stateDir,
    NOOKBRIDGE_RUNTIME_DIR: runtimeDir,
    NOOKBRIDGE_SYSTEMD_DIR: systemdDir,
    NOOKBRIDGE_USR_LOCAL_BIN: usrLocalBinDir,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };

  return Object.freeze({
    rootDir,
    binDir,
    optDir,
    etcDir,
    stateDir,
    runtimeDir,
    systemdDir,
    usrLocalBinDir,
    systemctlPath,
    healthPath,
    installerStatePath,
    env: Object.freeze(env),
  });
}
