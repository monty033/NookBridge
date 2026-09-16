import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const verifier = join(repositoryRoot, "scripts", "verify-linux-artifact.sh");
const manifestSchema = join(repositoryRoot, "packaging", "linux", "release-manifest.schema.json");

const topLevel = "nookbridge-v1.2.3";
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots) rmSync(root, { force: true, recursive: true });
  fixtureRoots.length = 0;
});

function validManifest(): Record<string, unknown> {
  return {
    artifactFormat: 1,
    version: "1.2.3",
    gitCommit: "0123456789abcdef0123456789abcdef01234567",
    dirtyTree: false,
    target: { os: "linux", arch: "x86_64", libc: "glibc" },
    node: { version: "22.23.2", abi: "node-v127" },
    minGlibc: "2.31",
    minLibstdcxx: "GLIBCXX_3.4.29",
    packageLockSha256: "a".repeat(64),
    payloadInventorySha256: "b".repeat(64),
    stateCompatibility: "state-v1",
    buildTimestamp: "2026-09-16T00:00:00Z",
  };
}

function createValidArtifact(): {
  readonly root: string;
  readonly artifact: string;
  readonly checksumFile: string;
  readonly tempRoot: string;
} {
  const tempRoot = mkdtempSync(join(tmpdir(), "nookbridge-artifact-test-"));
  const parent = join(tempRoot, "payload");
  const root = join(parent, topLevel);
  const artifact = join(tempRoot, `${topLevel}.tar.gz`);
  const checksumFile = join(tempRoot, "SHA256SUMS");
  fixtureRoots.push(tempRoot);

  execFileSync("mkdir", [
    "-p",
    join(root, "bin"),
    join(root, "runtime", "bin"),
    join(root, "app", "dist"),
    join(root, "app", "node_modules"),
    join(root, "licenses"),
  ]);
  const inventory = "internal payload inventory\n";
  const manifest = validManifest();
  manifest.payloadInventorySha256 = createHash("sha256").update(inventory).digest("hex");
  writeFileSync(join(root, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(root, "SHA256SUMS"), inventory);
  for (const name of [
    "nookd",
    "nookctl",
    "nook-mcp",
    "nookbridge-health",
    "nookbridge-runtime-check",
  ]) {
    writeFileSync(join(root, "bin", name), "#!/bin/sh\nexit 0\n");
  }
  writeFileSync(join(root, "runtime", "bin", "node"), "node runtime placeholder\n");
  writeFileSync(join(root, "app", "package.json"), '{"name":"nookbridge-runtime"}\n');
  writeFileSync(join(root, "app", "dist", "nookd.js"), "runtime payload\n");
  writeFileSync(join(root, "app", "node_modules", "native.node"), "native payload\n");
  writeFileSync(join(root, "licenses", "NOTICE"), "license notices\n");

  execFileSync("tar", ["-czf", artifact, "-C", parent, topLevel]);
  writeChecksum(artifact, checksumFile);
  return { root, artifact, checksumFile, tempRoot };
}

function writeChecksum(artifact: string, checksumFile: string): void {
  const digest = execFileSync("sha256sum", [artifact], { encoding: "utf8" }).split(/\s+/)[0];
  writeFileSync(checksumFile, `${digest}  ${artifact.split("/").pop()}\n`);
}

function runVerifier(artifact: string, checksumFile: string) {
  return spawnSync("bash", [verifier, "--artifact", artifact, "--checksum-file", checksumFile], {
    encoding: "utf8",
  });
}

describe("Linux artifact manifest contract", () => {
  it("defines the strict x86_64 glibc release metadata shape", () => {
    const schema = JSON.parse(readFileSync(manifestSchema, "utf8")) as {
      required: string[];
      properties: Record<string, { const?: unknown; pattern?: string }>;
    };

    expect(schema.required).toEqual(
      expect.arrayContaining([
        "artifactFormat",
        "version",
        "gitCommit",
        "dirtyTree",
        "target",
        "node",
        "packageLockSha256",
        "payloadInventorySha256",
        "stateCompatibility",
        "buildTimestamp",
      ]),
    );
    expect(schema.properties.dirtyTree?.const).toBe(false);
    expect(schema.properties.version?.pattern).toContain("A-Za-z0-9");
  });

  it("accepts a complete artifact without requiring host Node, npm, or Nix", () => {
    const fixture = createValidArtifact();
    const result = runVerifier(fixture.artifact, fixture.checksumFile);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("nookbridge-artifact verification ok\n");
    expect(result.stderr).toBe("");
  });

  it("rejects an outer checksum mismatch categorically", () => {
    const fixture = createValidArtifact();
    writeFileSync(fixture.checksumFile, `${"0".repeat(64)}  ${topLevel}.tar.gz\n`);
    const result = runVerifier(fixture.artifact, fixture.checksumFile);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("nookbridge-artifact verification failed\n");
  });

  it("rejects unsafe archive members before extraction", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "nookbridge-unsafe-"));
    fixtureRoots.push(tempRoot);
    const source = join(tempRoot, "payload");
    const artifact = join(tempRoot, "unsafe.tar.gz");
    const checksumFile = join(tempRoot, "SHA256SUMS");
    writeFileSync(source, "escape\n");
    execFileSync("tar", [
      "-czf",
      artifact,
      "--transform",
      `s,^payload$,${topLevel}/../escape,`,
      "-C",
      tempRoot,
      "payload",
    ]);
    writeChecksum(artifact, checksumFile);

    const result = runVerifier(artifact, checksumFile);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("nookbridge-artifact verification failed\n");
  });

  it("rejects symlink members", () => {
    const fixture = createValidArtifact();
    symlinkSync("/etc/passwd", join(fixture.root, "bin", "unexpected-link"));
    execFileSync("tar", ["-czf", fixture.artifact, "-C", dirname(fixture.root), topLevel]);
    writeChecksum(fixture.artifact, fixture.checksumFile);

    const result = runVerifier(fixture.artifact, fixture.checksumFile);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("nookbridge-artifact verification failed\n");
  });

  it("rejects invalid manifest versions and build-path references", () => {
    const invalidManifest = createValidArtifact();
    writeFileSync(
      join(invalidManifest.root, "release.json"),
      `${JSON.stringify({ ...validManifest(), version: "../etc" }, null, 2)}\n`,
    );
    execFileSync("tar", [
      "-czf",
      invalidManifest.artifact,
      "-C",
      dirname(invalidManifest.root),
      topLevel,
    ]);
    writeChecksum(invalidManifest.artifact, invalidManifest.checksumFile);
    const invalidResult = runVerifier(invalidManifest.artifact, invalidManifest.checksumFile);
    expect(invalidResult.status).not.toBe(0);

    const poisoned = createValidArtifact();
    writeFileSync(join(poisoned.root, "app", "dist", "poison.js"), "/nix/store/forbidden\n");
    execFileSync("tar", ["-czf", poisoned.artifact, "-C", dirname(poisoned.root), topLevel]);
    writeChecksum(poisoned.artifact, poisoned.checksumFile);
    const poisonedResult = runVerifier(poisoned.artifact, poisoned.checksumFile);
    expect(poisonedResult.status).not.toBe(0);
    expect(poisonedResult.stderr).toBe("nookbridge-artifact verification failed\n");
  });
});
