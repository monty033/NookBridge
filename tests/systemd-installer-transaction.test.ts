import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
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
  });
});
