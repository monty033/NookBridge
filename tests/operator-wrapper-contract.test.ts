import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
const temporaryRoots: string[] = [];

function createArtifact(): { artifact: string; checksum: string } {
  const root = mkdtempSync(join(tmpdir(), "nookbridge-operator-wrapper-artifact-"));
  temporaryRoots.push(root);
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

function envFor(ctx: InstallerFakeRoot, logPath: string): Record<string, string | undefined> {
  return {
    ...process.env,
    ...ctx.env,
    PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`,
    NOOKBRIDGE_FAKE_LOG: logPath,
  };
}

function setupWrappers(options: {
  operatorExitStatus?: number;
  stopExitStatus?: number;
  activeStatus?: "active" | "inactive";
}) {
  const ctx = createInstallerFakeRoot();
  fakeRoots.push(ctx);
  const { artifact, checksum } = createArtifact();
  const install = spawnSync(
    "bash",
    [installer, "install", "--artifact", artifact, "--checksum-file", checksum],
    {
      cwd: repositoryRoot,
      env: envFor(ctx, "/dev/null"),
      encoding: "utf8",
    },
  );
  if (install.status !== 0) {
    throw new Error(`install failed: ${install.stdout}\n${install.stderr}`);
  }

  const logRoot = mkdtempSync(join(tmpdir(), "nookbridge-operator-wrapper-log-"));
  temporaryRoots.push(logRoot);
  const logPath = join(logRoot, "trace.log");
  writeFileSync(
    join(ctx.binDir, "id"),
    '#!/usr/bin/env bash\nif [ "${1:-}" = "-u" ]; then printf "%s\\n" 0; else exit 0; fi\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(ctx.binDir, "systemctl"),
    [
      "#!/usr/bin/env bash",
      "set -eu",
      'printf \'systemctl %s\\n\' "$*" >> "$NOOKBRIDGE_FAKE_LOG"',
      'case "$1" in',
      '  is-active) [ "${ACTIVE_STATUS:-active}" = active ] && exit 0 || exit 3 ;;',
      "  stop) exit ${STOP_STATUS:-0} ;;",
      "  start|restart) exit 0 ;;",
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(ctx.binDir, "systemd-run"),
    [
      "#!/usr/bin/env bash",
      "set -eu",
      'printf \'systemd-run %s\\n\' "$*" >> "$NOOKBRIDGE_FAKE_LOG"',
      'exit "${OPERATOR_STATUS:-0}"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const env = envFor(ctx, logPath);
  env.OPERATOR_STATUS = String(options.operatorExitStatus ?? 0);
  env.STOP_STATUS = String(options.stopExitStatus ?? 0);
  env.ACTIVE_STATUS = options.activeStatus ?? "active";
  return { ctx, env, logPath };
}

afterEach(() => {
  disposeInstallerFakeRoot();
  fakeRoots.length = 0;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("operator wrapper lifecycle", () => {
  it("suspends nookd before provisioning and restores it afterward", () => {
    const { ctx, env, logPath } = setupWrappers({});
    const result = spawnSync(join(ctx.usrLocalBinDir, "nookbridge-provision"), [], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const trace = readFileSync(logPath, "utf8");
    expect(trace.indexOf("systemctl stop nookd.service")).toBeLessThan(
      trace.indexOf("systemd-run "),
    );
    expect(trace.indexOf("systemctl start nookd.service")).toBeGreaterThan(
      trace.indexOf("systemd-run "),
    );
  });

  it("restores nookd and preserves a provisioning failure", () => {
    const { ctx, env, logPath } = setupWrappers({ operatorExitStatus: 7 });
    const result = spawnSync(join(ctx.usrLocalBinDir, "nookbridge-provision"), [], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(7);
    const trace = readFileSync(logPath, "utf8");
    expect(trace).toMatch(/systemctl start nookd\.service/);
  });

  it("does not launch provisioning when stopping nookd fails", () => {
    const { ctx, env, logPath } = setupWrappers({ stopExitStatus: 9 });
    const result = spawnSync(join(ctx.usrLocalBinDir, "nookbridge-provision"), [], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(9);
    const trace = readFileSync(logPath, "utf8");
    expect(trace).not.toMatch(/systemd-run/);
    expect(trace).toMatch(/systemctl start nookd\.service/);
  });

  it("prints usable help for the umbrella launcher", () => {
    const { ctx, env } = setupWrappers({});
    const result = spawnSync(join(ctx.usrLocalBinDir, "notesbridge"), ["help"], {
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Usage: notesbridge <provision|sync>\n");
    expect(result.stderr).toBe("");
  });

  it("rejects unknown umbrella subcommands with usage on stderr", () => {
    const { ctx, env } = setupWrappers({});
    const result = spawnSync(join(ctx.usrLocalBinDir, "notesbridge"), ["unknown"], {
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Usage: notesbridge <provision|sync>\n");
  });

  it.each([
    ["success", 0],
    ["failure", 7],
  ])("restores an originally active daemon after sync %s", (_label, operatorExitStatus) => {
    const { ctx, env, logPath } = setupWrappers({
      activeStatus: "active",
      operatorExitStatus,
    });
    const result = spawnSync(join(ctx.usrLocalBinDir, "notesbridge"), ["sync"], {
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(operatorExitStatus);
    const trace = readFileSync(logPath, "utf8");
    expect(trace.indexOf("systemctl stop nookd.service")).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf("systemd-run")).toBeGreaterThan(
      trace.indexOf("systemctl stop nookd.service"),
    );
    expect(trace.indexOf("systemctl start nookd.service")).toBeGreaterThan(
      trace.indexOf("systemd-run"),
    );
  });

  it("leaves an originally inactive daemon down after sync", () => {
    const { ctx, env, logPath } = setupWrappers({ activeStatus: "inactive" });
    const result = spawnSync(join(ctx.usrLocalBinDir, "notesbridge"), ["sync"], {
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const trace = readFileSync(logPath, "utf8");
    expect(trace).toContain("systemd-run");
    expect(trace).not.toContain("systemctl start nookd.service");
  });

  it("starts an originally inactive daemon after successful provisioning", () => {
    const { ctx, env, logPath } = setupWrappers({ activeStatus: "inactive" });
    const result = spawnSync(join(ctx.usrLocalBinDir, "nookbridge-provision"), [], {
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const trace = readFileSync(logPath, "utf8");
    expect(trace.indexOf("systemd-run")).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf("systemctl start nookd.service")).toBeGreaterThan(
      trace.indexOf("systemd-run"),
    );
  });

  it("does not start an originally inactive daemon after provisioning fails", () => {
    const { ctx, env, logPath } = setupWrappers({
      operatorExitStatus: 7,
      activeStatus: "inactive",
    });
    const result = spawnSync(join(ctx.usrLocalBinDir, "nookbridge-provision"), [], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(7);
    const trace = readFileSync(logPath, "utf8");
    expect(trace).toMatch(/systemctl is-active/);
    expect(trace).not.toMatch(/systemctl start nookd\.service/);
  });

  it("routes provision and sync subcommands through both launcher names", () => {
    const { ctx, env, logPath } = setupWrappers({});
    for (const [name, subcommand] of [
      ["nookbridge", "provision"],
      ["nookbridge", "sync"],
      ["notesbridge", "provision"],
      ["notesbridge", "sync"],
    ] as const) {
      const path = join(ctx.usrLocalBinDir, name);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toMatch(/provision|sync/);
      const result = spawnSync(path, [subcommand], {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
      });
      expect(result.status, `${name} ${subcommand}: ${result.stdout}\n${result.stderr}`).toBe(0);
    }
    expect(readFileSync(logPath, "utf8")).toMatch(/systemd-run/);
  });
});
