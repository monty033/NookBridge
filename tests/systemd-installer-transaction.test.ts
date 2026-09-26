import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
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
const artifactRoots: string[] = [];
const fakeRoots: InstallerFakeRoot[] = [];

function createArtifact(): { artifact: string; checksum: string } {
  const root = mkdtempSync(join(tmpdir(), "nookbridge-task6-artifact-"));
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

function envFor(ctx: InstallerFakeRoot): Record<string, string | undefined> {
  return { ...process.env, ...ctx.env };
}

afterEach(() => {
  disposeInstallerFakeRoot();
  fakeRoots.length = 0;
  for (const root of artifactRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("generic systemd installer — health rollback and retention", () => {
  it("restores the previous current release when the health gate fails", () => {
    const ctx = createInstallerFakeRoot();
    fakeRoots.push(ctx);
    const { artifact, checksum } = createArtifact();
    mkdirSync(join(ctx.optDir, "releases", "0.9.0", "bin"), { recursive: true });
    symlinkSync("releases/0.9.0", join(ctx.optDir, "current"));
    writeFileSync(ctx.healthPath, "#!/bin/sh\nexit 1\n");
    chmodSync(ctx.healthPath, 0o755);

    const result = spawnSync(
      "bash",
      [installer, "upgrade", "--artifact", artifact, "--checksum-file", checksum],
      { cwd: repositoryRoot, env: envFor(ctx), encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/health.*rollback|rollback.*health/);
    expect(readlinkSync(join(ctx.optDir, "current"))).toBe("releases/0.9.0");
  });

  it("retains the active and immediate previous releases when pruning", () => {
    const ctx = createInstallerFakeRoot();
    fakeRoots.push(ctx);
    for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]) {
      mkdirSync(join(ctx.optDir, "releases", version), { recursive: true });
    }
    symlinkSync("releases/0.4.0", join(ctx.optDir, "current"));

    const result = spawnSync("bash", [installer, "prune", "--keep", "2"], {
      cwd: repositoryRoot,
      env: envFor(ctx),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("retain 2");
    expect(readlinkSync(join(ctx.optDir, "current"))).toBe("releases/0.4.0");
    expect(existsSync(join(ctx.optDir, "releases", "0.3.0"))).toBe(true);
    expect(existsSync(join(ctx.optDir, "releases", "0.2.0"))).toBe(false);
    expect(existsSync(join(ctx.optDir, "releases", "0.1.0"))).toBe(false);
  });

  it("keeps the release tree traversable under a restrictive installer umask", () => {
    const ctx = createInstallerFakeRoot();
    fakeRoots.push(ctx);
    const { artifact, checksum } = createArtifact();
    rmSync(ctx.optDir, { recursive: true, force: true });
    rmSync(ctx.etcDir, { recursive: true, force: true });

    const result = spawnSync(
      "bash",
      [
        "-c",
        'umask 077; exec bash "$1" install --artifact "$2" --checksum-file "$3"',
        "bash",
        installer,
        artifact,
        checksum,
      ],
      { cwd: repositoryRoot, env: envFor(ctx), encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(statSync(ctx.optDir).mode & 0o777).toBe(0o701);
    expect(statSync(join(ctx.optDir, "releases")).mode & 0o777).toBe(0o701);
    expect(statSync(ctx.etcDir).mode & 0o777).toBe(0o701);
  });

  it("creates the release directory on a fresh target", () => {
    const ctx = createInstallerFakeRoot();
    fakeRoots.push(ctx);
    const { artifact, checksum } = createArtifact();
    rmSync(join(ctx.optDir, "releases"), { recursive: true, force: true });

    const result = spawnSync(
      "bash",
      [installer, "install", "--artifact", artifact, "--checksum-file", checksum],
      { cwd: repositoryRoot, env: envFor(ctx), encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(readlinkSync(join(ctx.optDir, "current"))).toBe("releases/1.2.3");
    const serviceConfig = JSON.parse(readFileSync(join(ctx.etcDir, "service.json"), "utf8")) as {
      readPolicy?: unknown;
    };
    expect(serviceConfig.readPolicy).toEqual([
      "notes.search",
      "notes.status",
      "notes.list_notebooks",
      "notes.get",
      "notes.path_diagnostic",
    ]);
    expect(lstatSync(join(ctx.usrLocalBinDir, "nookbridge-provision")).isSymbolicLink()).toBe(
      false,
    );
    expect(readFileSync(join(ctx.usrLocalBinDir, "nookbridge-provision"), "utf8")).toContain(
      "systemd-run --quiet --pty --wait --collect \\\n",
    );
    const provisionWrapper = readFileSync(join(ctx.usrLocalBinDir, "nookbridge-provision"), "utf8");
    expect(provisionWrapper).toContain("systemctl stop nookd.service");
    expect(provisionWrapper).toContain("systemctl start nookd.service");
    expect(readFileSync(join(ctx.usrLocalBinDir, "nookbridge-sync"), "utf8")).not.toContain(
      "systemctl restart nookd.service",
    );
    for (const name of ["nookbridge", "notesbridge"]) {
      const wrapper = readFileSync(join(ctx.usrLocalBinDir, name), "utf8");
      expect(wrapper).toContain(
        `provision) shift; exec "${ctx.usrLocalBinDir}/nookbridge-provision" "$@"`,
      );
      expect(wrapper).toContain(`sync) shift; exec "${ctx.usrLocalBinDir}/nookbridge-sync" "$@"`);
    }
    expect(lstatSync(join(ctx.usrLocalBinDir, "nookbridge-runtime-check")).isSymbolicLink()).toBe(
      true,
    );
  });

  /**
   * Regression: `systemctl enable --now` is a no-op for an already-running
   * unit.  Using it on the upgrade path left the *previous* release's process
   * serving while `current` and the ledger advanced to the new version, and
   * the health gate then passed against that stale process.  An upgrade must
   * restart the daemon, and it must do so before the health gate runs.
   */
  it("restarts the daemon on upgrade, before the health gate", () => {
    const ctx = createInstallerFakeRoot();
    fakeRoots.push(ctx);
    const { artifact, checksum } = createArtifact();
    mkdirSync(join(ctx.optDir, "releases", "0.9.0", "bin"), { recursive: true });
    symlinkSync("releases/0.9.0", join(ctx.optDir, "current"));

    const logPath = join(ctx.rootDir, "invocations.log");
    const result = spawnSync(
      "bash",
      [installer, "upgrade", "--artifact", artifact, "--checksum-file", checksum],
      {
        cwd: repositoryRoot,
        env: { ...ctx.env, NOOKBRIDGE_FAKE_LOG: logPath },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);

    const invocations = readFileSync(logPath, "utf8");
    expect(invocations).toContain("systemctl restart nookd.service");
    expect(invocations.indexOf("systemctl restart nookd.service")).toBeLessThan(
      invocations.indexOf("nookbridge-health"),
    );
  });
});
