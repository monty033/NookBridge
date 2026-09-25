/* global process */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const verifier = join(repositoryRoot, "scripts", "verify-linux-artifact.sh");
const manifestSchema = join(repositoryRoot, "packaging", "linux", "release-manifest.schema.json");
const linuxArtifactWorkflow = join(repositoryRoot, ".forgejo", "workflows", "linux-artifact.yml");

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
  // The operator socket spawns this helper to read SO_PEERCRED; the verifier
  // rejects an artifact that omits it.
  writeFileSync(join(root, "app", "operator-peercred-helper"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "app", "operator-peercred-helper"), 0o755);
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

function runVerifier(artifact: string, checksumFile: string, extraArgs: readonly string[] = []) {
  return spawnSync(
    "bash",
    [verifier, "--artifact", artifact, "--checksum-file", checksumFile, ...extraArgs],
    { encoding: "utf8" },
  );
}

function runReleaseDescriptionBuilder(
  tag: string,
  changelog: string,
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly payload?: { body?: string; name?: string; target_commitish?: string };
} {
  const root = mkdtempSync(join(tmpdir(), "nookbridge-release-description-test-"));
  fixtureRoots.push(root);
  const workflow = readFileSync(linuxArtifactWorkflow, "utf8");
  const marker =
    '          RELEASE_TAG="$RELEASE_TAG" RELEASE_SHA="$RELEASE_SHA" PAYLOAD="$PAYLOAD" node <<\'NODE\'\n';
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error("release payload builder was not found in the workflow");
  const bodyStart = start + marker.length;
  const end = workflow.indexOf("\n          NODE\n", bodyStart);
  if (end < 0) throw new Error("release payload builder terminator was not found");
  const script = workflow
    .slice(bodyStart, end)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
  const scriptPath = join(root, "build-release-payload.cjs");
  const payloadPath = join(root, "payload.json");
  writeFileSync(scriptPath, script);
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_TAG: tag,
      RELEASE_SHA: "a".repeat(40),
      PAYLOAD: payloadPath,
    },
  });
  let payload: { body?: string; name?: string; target_commitish?: string } | undefined;
  if (result.status === 0) {
    payload = JSON.parse(readFileSync(payloadPath, "utf8")) as typeof payload;
  }
  return payload
    ? { status: result.status, stdout: result.stdout, stderr: result.stderr, payload }
    : { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("Linux artifact manifest contract", () => {
  it("selects only numeric GLIBCXX ABI symbols in the release workflow", () => {
    const workflow = readFileSync(linuxArtifactWorkflow, "utf8");

    expect(workflow).toContain("grep -E '^GLIBCXX_[0-9]+(\\.[0-9]+){1,2}$'");
    expect(workflow).not.toContain("grep '^GLIBCXX_' | sort -V");
    expect(workflow).toContain('test -n "$LIBSTDCXX_BASELINE"');
  });

  it("publishes useful release context from the exact versioned summary", () => {
    const workflow = readFileSync(linuxArtifactWorkflow, "utf8");

    expect(workflow).toContain(
      "const changelog = fs.readFileSync('CHANGELOG.md', 'utf8').split('\\n');",
    );
    expect(workflow).toContain("const releaseHeading = /^## \\[([^\\]]+)\\](?:\\s+-.*)?$/;");
    expect(workflow).toContain("const summarySections = section.flatMap((line, index) =>");
    expect(workflow).toContain("line === '### Summary' ? [index] : []");
    expect(workflow).not.toContain("startsWith(heading)");
    expect(workflow).not.toContain("v0.1.2");
    expect(workflow).toContain("fresh Debian Linux container");
    expect(workflow).toContain(
      "installation, service startup, and verifying that the application renders correctly",
    );
    expect(workflow).not.toContain("awaiting clean-LXC rendered acceptance");
    expect(workflow).not.toContain("Candidate release. Verified by the Linux artifact job");

    const collision = runReleaseDescriptionBuilder(
      "v1.2.3",
      [
        "## [1.2.30] - 2026-01-30",
        "",
        "### Summary",
        "",
        "- wrong release summary",
        "",
        "## [1.2.3] - 2026-01-03",
        "",
        "### Summary",
        "",
        "- correct release summary",
        "",
        "### Fixed",
        "",
        "- internal detail stays in the source changelog",
        "",
      ].join("\n"),
    );
    expect(collision.status).toBe(0);
    expect(collision.payload?.name).toBe("v1.2.3");
    expect(collision.payload?.body).toContain("- correct release summary");
    expect(collision.payload?.body).not.toContain("- wrong release summary");
    expect(collision.payload?.body).not.toContain(
      "- internal detail stays in the source changelog",
    );
    expect(collision.payload?.body).toContain("fresh Debian Linux container");

    const actual = runReleaseDescriptionBuilder(
      "v0.1.2",
      readFileSync(join(repositoryRoot, "CHANGELOG.md"), "utf8"),
    );
    expect(actual.status).toBe(0);
    expect(actual.payload?.body).toContain("Added guarded release commands");
    expect(actual.payload?.body).not.toContain("nodejs.org");
    expect(actual.payload?.body).not.toContain("GITHUB_PATH");
    expect(actual.payload?.body).not.toContain("/nix/store");
    expect(actual.payload?.body).not.toContain("Forgejo/NixOS");
    expect(actual.payload?.body).not.toContain("offline-pinned");
    expect(actual.payload?.body).not.toContain("SSH account");
    expect(actual.payload?.body).not.toContain("### Added");

    const duplicateVersion = runReleaseDescriptionBuilder(
      "v1.2.3",
      [
        "## [1.2.3] - 2026-01-03",
        "",
        "### Summary",
        "",
        "- first summary",
        "",
        "## [1.2.3] - 2026-01-04",
        "",
        "### Summary",
        "",
        "- duplicate summary",
        "",
      ].join("\n"),
    );
    expect(duplicateVersion.status).not.toBe(0);
    expect(duplicateVersion.stderr).toContain("exactly one release section");

    const missingVersion = runReleaseDescriptionBuilder(
      "v1.2.3",
      "## [1.2.30] - 2026-01-30\n\n### Summary\n\n- wrong version\n",
    );
    expect(missingVersion.status).not.toBe(0);
    expect(missingVersion.stderr).toContain("exactly one release section");

    const missingSummary = runReleaseDescriptionBuilder(
      "v1.2.3",
      "## [1.2.3] - 2026-01-03\n\n### Fixed\n\n- no summary\n",
    );
    expect(missingSummary.status).not.toBe(0);
    expect(missingSummary.stderr).toContain("exactly one Summary");

    const falseSummary = runReleaseDescriptionBuilder(
      "v1.2.3",
      [
        "## [1.2.3] - 2026-01-03",
        "",
        "- See ### Summary for details",
        "",
        "### Summary (internal)",
        "",
        "- not the public summary",
        "",
      ].join("\n"),
    );
    expect(falseSummary.status).not.toBe(0);
    expect(falseSummary.stderr).toContain("exactly one Summary");

    const duplicateSummary = runReleaseDescriptionBuilder(
      "v1.2.3",
      [
        "## [1.2.3] - 2026-01-03",
        "",
        "### Summary",
        "",
        "- first summary",
        "",
        "### Summary",
        "",
        "- duplicate summary",
        "",
      ].join("\n"),
    );
    expect(duplicateSummary.status).not.toBe(0);
    expect(duplicateSummary.stderr).toContain("exactly one Summary");

    const emptySummary = runReleaseDescriptionBuilder(
      "v1.2.3",
      "## [1.2.3] - 2026-01-03\n\n### Summary\n\n### Fixed\n\n- no summary\n",
    );
    expect(emptySummary.status).not.toBe(0);
    expect(emptySummary.stderr).toContain("release summary for 1.2.3 is empty");
  });

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

  it("packages a runtime without executing the foreign runtime binary", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "nookbridge-builder-test-"));
    fixtureRoots.push(tempRoot);
    const source = join(tempRoot, "source");
    const output = join(tempRoot, "artifacts");
    const packagedNode = join(tempRoot, "node-v22.23.2-linux-x64", "bin", "node");
    const runtimeTarball = join(tempRoot, "node-v22.23.2-linux-x64.tar.gz");
    const buildNode = join(tempRoot, "build-node");
    mkdirSync(join(source, "dist", "mcp"), { recursive: true });
    mkdirSync(join(source, "node_modules"), { recursive: true });
    mkdirSync(dirname(packagedNode), { recursive: true });
    writeFileSync(join(source, "dist", "nookd.js"), "nookd\n");
    writeFileSync(join(source, "dist", "cli.js"), "cli\n");
    writeFileSync(join(source, "dist", "mcp", "cli.js"), "mcp\n");
    writeFileSync(join(source, "dist", "provision.js"), "provision\n");
    writeFileSync(join(source, "dist", "sync.js"), "sync\n");
    writeFileSync(join(source, "dist", "health.js"), "health\n");
    writeFileSync(join(source, "dist", "runtime-check.js"), "runtime-check\n");
    writeFileSync(join(source, "node_modules", "native.node"), "native\n");
    writeFileSync(join(source, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    writeFileSync(
      join(source, "package-lock.json"),
      '{"name":"fixture","version":"1.0.0","lockfileVersion":3}\n',
    );
    writeFileSync(join(source, "LICENSE"), "license\n");
    const peercredHelper = join(tempRoot, "operator-peercred-helper");
    writeFileSync(peercredHelper, "#!/bin/sh\nexit 0\n");
    chmodSync(peercredHelper, 0o755);
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", source]);
    execFileSync("git", ["-C", source, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", source, "config", "user.name", "Artifact Test"]);
    execFileSync("git", ["-C", source, "add", "."]);
    execFileSync("git", ["-C", source, "commit", "-qm", "fixture"]);

    writeFileSync(
      packagedNode,
      "#!/bin/sh\nprintf 'foreign runtime must not execute\\n' >&2\nexit 99\n",
    );
    chmodSync(packagedNode, 0o755);
    execFileSync("tar", ["-czf", runtimeTarball, "-C", tempRoot, "node-v22.23.2-linux-x64"]);
    writeFileSync(
      buildNode,
      "#!/bin/sh\ncase \"$1\" in --version) printf 'v22.23.2\\n' ;; -p) printf '127\\n' ;; *) exit 98 ;; esac\n",
    );
    chmodSync(buildNode, 0o755);

    execFileSync(
      "bash",
      [
        join(repositoryRoot, "scripts", "build-linux-artifact.sh"),
        "--source-dir",
        source,
        "--build-node",
        buildNode,
        "--runtime-tarball",
        runtimeTarball,
        "--operator-peercred-helper",
        peercredHelper,
        "--output-dir",
        output,
        "--version",
        "1.2.3",
        "--source-date-epoch",
        "0",
        "--min-glibc",
        "2.31",
        "--min-libstdcxx",
        "GLIBCXX_3.4.29",
      ],
      { encoding: "utf8" },
    );

    const packaged = execFileSync(
      "tar",
      [
        "-xOzf",
        join(output, "nookbridge-v1.2.3-linux-x64-gnu.tar.gz"),
        "nookbridge-v1.2.3/runtime/bin/node",
      ],
      { encoding: "utf8" },
    );
    expect(packaged).toContain("foreign runtime must not execute");
  });

  /**
   * T12 — source SHA association.  The verifier must be able to prove the
   * artifact was built from the commit being released; a manifest that merely
   * contains a well-formed 40-hex string proves nothing on its own.
   */
  it("binds the artifact to the expected source commit", () => {
    const fixture = createValidArtifact();
    const result = runVerifier(fixture.artifact, fixture.checksumFile, [
      "--expect-git-commit",
      "0123456789abcdef0123456789abcdef01234567",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("nookbridge-artifact verification ok\n");
    expect(result.stderr).toBe("");
  });

  it("rejects an artifact built from a different source commit", () => {
    const fixture = createValidArtifact();
    const result = runVerifier(fixture.artifact, fixture.checksumFile, [
      "--expect-git-commit",
      "f".repeat(40),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("nookbridge-artifact verification failed\n");
  });

  it("rejects a malformed expected source commit", () => {
    const fixture = createValidArtifact();
    const result = runVerifier(fixture.artifact, fixture.checksumFile, [
      "--expect-git-commit",
      "not-a-sha",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("nookbridge-artifact verification failed\n");
  });

  it("stays usable without an expected commit so downloaders can still verify", () => {
    const fixture = createValidArtifact();
    const result = runVerifier(fixture.artifact, fixture.checksumFile);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("nookbridge-artifact verification ok\n");
  });

  it("pins the released artifact to the building source SHA in the workflow", () => {
    const workflow = readFileSync(linuxArtifactWorkflow, "utf8");

    expect(workflow).toContain("--expect-git-commit");
    expect(workflow).toContain("GITHUB_SHA");
  });

  it("builds and asserts a portable static peer-credential helper", () => {
    const workflow = readFileSync(linuxArtifactWorkflow, "utf8");

    expect(workflow).toContain('STATIC_GLIBC="$(find /nix/store');
    expect(workflow).toContain("-name '*-glibc-*-static'");
    expect(workflow).not.toContain("-name 'glibc-*-static'");
    expect(workflow).toContain("static glibc output not found");
    expect(workflow).toContain('test -f "$STATIC_GLIBC/lib/libc.a"');
    expect(workflow).toContain("cc -O2 -std=c11 -Wall -Wextra -Werror -ffreestanding -fno-builtin");
    expect(workflow).toContain("-nostdlib -static -Wl,-e,_start");
    expect(workflow).toContain('-L"$STATIC_GLIBC/lib"');
    expect(workflow).toContain('readelf -l "$HELPER"');
    expect(workflow).toContain("grep -E 'INTERP'");
    expect(workflow).toContain("peer-credential helper contains a host path");
    expect(workflow).toContain('strings "$HELPER" | grep -E');
    expect(workflow).not.toContain('|| cc -O2 -o "$HELPER"');
  });

  it("keeps the static peer-credential helper free of Nix NSS path leakage", () => {
    if (process.platform !== "linux") return;

    const helperSource = readFileSync(
      join(repositoryRoot, "native", "operator-peercred.c"),
      "utf8",
    );
    const tempRoot = mkdtempSync(join(tmpdir(), "nookbridge-peercred-test-"));
    fixtureRoots.push(tempRoot);
    const helper = join(tempRoot, "operator-peercred-helper");
    const staticGlibc = spawnSync(
      "find",
      ["/nix/store", "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-name", "*-glibc-*-static"],
      { encoding: "utf8" },
    )
      .stdout.trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .sort()
      .at(-1);
    if (staticGlibc === undefined) return;
    const compile = spawnSync(
      "cc",
      [
        "-O2",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-ffreestanding",
        "-fno-builtin",
        "-fno-stack-protector",
        "-fno-asynchronous-unwind-tables",
        "-fno-unwind-tables",
        "-fno-pie",
        "-no-pie",
        "-nostdlib",
        "-static",
        "-Wl,-e,_start",
        "-Wl,--build-id=none",
        `-L${staticGlibc}/lib`,
        "-o",
        helper,
        join(repositoryRoot, "native", "operator-peercred.c"),
      ],
      { encoding: "utf8" },
    );

    expect(compile.status).toBe(0);
    expect(helperSource).not.toContain("getgrgid_r");
    expect(helperSource).toContain("/etc/group");

    const strings = spawnSync("strings", [helper], { encoding: "utf8" });
    expect(strings.status).toBe(0);
    expect(strings.stdout).not.toMatch(/\/nix\/store\/[A-Za-z0-9]+/u);
  });

  /**
   * T12 — candidate promotion.  A tag push must never land on the general
   * install path: the candidate is published as a prerelease and an explicit
   * promotion step re-verifies provenance before clearing that flag.
   */
  it("installs its pinned runtime before requiring it, in a job that holds no token", () => {
    const workflow = parseYaml(readFileSync(linuxArtifactWorkflow, "utf8")) as {
      jobs: Record<
        string,
        {
          env?: Record<string, string>;
          steps: { name: string; env?: Record<string, string>; run?: string }[];
        }
      >;
    };

    // Later steps build with the runner's Node, so the runtime must be the pinned one
    // and must sit outside the directories a source-controlled step can write. The
    // upstream archive is a generic Linux build that this NixOS runner cannot execute,
    // so it is verified for packaging but never unpacked and never put on PATH.
    for (const jobName of ["linux-artifact", "promote-release"]) {
      const job = workflow.jobs[jobName]!;
      const runtimeStep = job.steps.find((step) =>
        (step.name ?? "").startsWith("Verify pinned Node runtime"),
      )!;
      const body = runtimeStep.run ?? "";
      expect(body).toContain('test "$(node --version)" = "v${NODE_VERSION}"');
      expect(body).toContain('test "$(npm --version)" = "10.9.8"');
      expect(body).toContain("refusing to build with a Node inside a workflow-writable directory");
      expect(body).not.toContain('>> "$GITHUB_PATH"');
      expect(body).not.toContain("export PATH=");
      expect(body).not.toContain("tar -xzf");
      expect(runtimeStep.env?.NODE_VERSION).toBe("22.23.2");

      if (jobName === "linux-artifact") {
        // The archive that ships in the artifact is verified against a digest that is a
        // constant of this workflow, so the check needs no network at all: a runner that
        // already holds the archive must not reach nodejs.org, and the network must not
        // be able to decide what the expected digest is.
        expect(runtimeStep.env?.NODE_ARCHIVE_SHA256).toMatch(/^[0-9a-f]{64}$/);
        expect(body).not.toContain("SHASUMS256.txt");
        expect(body).toContain('if [ "$cached_sha256" != "$NODE_ARCHIVE_SHA256" ]');
        // ...and it says what to do when it must fetch and cannot.
        expect(body).toContain("pre-seed");
      } else {
        // The promote job republishes an artifact it does not build, so it must not
        // depend on the upstream archive at all.
        expect(body).not.toContain("nodejs.org");
        expect(runtimeStep.env?.NODE_ARCHIVE_SHA256).toBeUndefined();
      }

      // Forgejo exports its automatic token as FORGEJO_TOKEN and GITHUB_TOKEN, either of
      // which can write to the repository, so a job that clears one name and not the
      // other still hands repository write access to the tagged code it runs.
      expect(job.env?.FORGEJO_TOKEN).toBe("");
      expect(job.env?.GITHUB_TOKEN).toBe("");
      const guard = job.steps[0]!;
      expect(guard.name).toBe("Refuse an injected workflow token");
      expect(guard.run ?? "").toContain("for refused_name in FORGEJO_TOKEN GITHUB_TOKEN; do");
      expect(guard.run ?? "").toContain("refusing to run repository code with it");
    }
  });

  it("starts from an empty workspace and checks the commands the build invokes", () => {
    const workflow = parseYaml(readFileSync(linuxArtifactWorkflow, "utf8")) as {
      jobs: Record<string, { steps: { name: string; run?: string }[] }>;
    };

    // A runner reuses its workspace. Without cleaning it, a previous failed run leaves a
    // repository, build output, or release context files that the next run trips over —
    // and `git init` fails outright when `.git` already exists.
    for (const [jobName, stepName] of [
      ["linux-artifact", "Checkout"],
      ["promote-release", "Checkout promotion tooling"],
    ] as const) {
      const step = workflow.jobs[jobName]?.steps.find((candidate) => candidate.name === stepName);
      const run = step?.run ?? "";
      expect(run).toContain('case "$PWD" in');
      expect(run).toContain("refusing to clean");
      expect(run).toContain("rm -rf ./* ./.[!.]* 2>/dev/null");
      // Every job clears the automatic token, so the checkout can only read
      // anonymously; a token-bearing branch would be unreachable code holding a
      // credential.
      expect(run).not.toContain("http.extraheader");
      // The build invokes all of these, so their absence belongs here rather than
      // halfway through artifact assembly.
      const prerequisites = /for command_name in ([^;]+); do/.exec(run)?.[1] ?? "";
      for (const command of ["getconf", "strings", "grep", "sort", "tail"]) {
        expect(`${jobName}: ${prerequisites}`).toContain(command);
      }
    }
  });

  it("accepts trusted Nix store tool paths in every promotion gate", () => {
    const workflow = readFileSync(linuxArtifactWorkflow, "utf8");
    const curlGates = [...workflow.matchAll(/case "\$curl_path" in[\s\S]*?\n {10}esac/g)].map(
      (match) => match[0],
    );
    const awkGates = [...workflow.matchAll(/case "\$awk_path" in[\s\S]*?\n {10}esac/g)].map(
      (match) => match[0],
    );

    expect(curlGates).toHaveLength(2);
    expect(awkGates).toHaveLength(4);
    for (const [name, gates] of [
      ["curl_path", curlGates],
      ["awk_path", awkGates],
    ] as const) {
      for (const gate of gates) {
        expect(gate).toContain("/nix/store/*");
        for (const candidate of [
          "/nix/store/hash-tool/bin/tool",
          "/run/current-system/sw/bin/tool",
        ]) {
          const result = spawnSync(
            "bash",
            ["-c", `set -eu\n${name}="$1"\n${gate}`, "guard", candidate],
            { encoding: "utf8" },
          );
          expect(result.status, `${name} should accept ${candidate}`).toBe(0);
        }
        const rejected = spawnSync(
          "bash",
          ["-c", `set -eu\n${name}="$1"\n${gate}`, "guard", "/tmp/untrusted-tool"],
          { encoding: "utf8" },
        );
        expect(rejected.status, `${name} should reject /tmp/untrusted-tool`).not.toBe(0);
      }
    }
  });

  it("reads a release identity from a real payload with the workflow's own awk helper", () => {
    // The token-bearing steps decide what to delete or flip from this helper, and it has
    // never run: an awk that silently returns nothing would make those steps fail closed
    // but would also make every release fail. It is extracted from the workflow so the
    // test exercises the shipped text rather than a copy of it.
    const workflow = readFileSync(linuxArtifactWorkflow, "utf8");
    const helper = /^ {10}# Reads one top-level field[\s\S]*?^ {10}\}\n/m.exec(workflow);
    expect(helper).not.toBeNull();

    const root = mkdtempSync(join(tmpdir(), "nookbridge-release-field-"));
    fixtureRoots.push(root);
    const payload = join(root, "payload.json");
    writeFileSync(
      payload,
      JSON.stringify(
        {
          url: "https://api.github.com/repos/monty033/NookBridge/releases/12345",
          id: 12345,
          tag_name: "v0.1.2",
          target_commitish: "aa2a9934e90df50d6daf201b3de45a96f0288e10",
          draft: true,
          prerelease: false,
          author: { login: "monty", id: 999 },
          // A nested object repeating a name must not win over the top-level field.
          assets: [{ id: 777, name: "install.sh", draft: false, prerelease: false }],
        },
        null,
        2,
      ),
    );

    const script = join(root, "field.sh");
    writeFileSync(
      script,
      [
        "set -euo pipefail",
        'awk_path="$(command -v awk)"',
        "export awk_path",
        helper?.[0] ?? "",
        'printf "id=%s\\n" "$(release_field id "$1")"',
        'printf "tag=%s\\n" "$(release_field tag_name "$1")"',
        'printf "draft=%s\\n" "$(release_field draft "$1")"',
        'printf "prerelease=%s\\n" "$(release_field prerelease "$1")"',
        'printf "absent=%s\\n" "$(release_field nope "$1")"',
        'printf "archived=%s\\n" "$(release_field archived "$1")"',
      ].join("\n"),
    );

    const result = spawnSync("bash", [script, payload], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toStrictEqual([
      "id=12345",
      "tag=v0.1.2",
      "draft=true",
      "prerelease=false",
      "absent=",
      "archived=",
    ]);
  });

  it("publishes a tag push as a candidate and gates promotion behind a separate ref", () => {
    const raw = readFileSync(linuxArtifactWorkflow, "utf8");
    const doc = parseYaml(raw) as {
      on: { push: { branches: string[]; tags: string[] } };
      jobs: Record<
        string,
        {
          if?: string;
          steps?: Array<{ if?: string; name?: string; env?: Record<string, string>; run?: string }>;
        }
      >;
    };

    const buildJob = doc.jobs["linux-artifact"];
    const promoteJob = doc.jobs["promote-release"];
    const artifactStep = buildJob?.steps?.find(
      (step) => step.name === "Build and verify x86_64 glibc artifact",
    );
    const preflightStep = buildJob?.steps?.find(
      (step) => step.name === "Require successful main runner preflight",
    );
    const assetsStep = buildJob?.steps?.find(
      (step) => step.name === "Prepare GitHub release assets",
    );
    const uploadStep = buildJob?.steps?.find(
      (step) => step.name === "Prepare the GitHub release upload",
    );
    const publishStep = buildJob?.steps?.find((step) => step.name === "Publish release assets");
    const publishedVerifyStep = buildJob?.steps?.find(
      (step) => step.name === "Re-verify the published release",
    );
    const promotionCheckoutStep = promoteJob?.steps?.find(
      (step) => step.name === "Checkout promotion tooling",
    );
    const promotionVerifyStep = promoteJob?.steps?.find(
      (step) => step.name === "Verify the candidate artifact",
    );

    expect(doc.on.push.branches).toEqual(["main", "runner-test/**"]);
    expect(doc.on.push.tags).toEqual(["v*", "promote-v*"]);
    expect(raw).toContain("workflow_dispatch:");
    expect(raw).toContain("release_tag:");
    expect(promotionCheckoutStep?.env?.PROMOTION_TAG).toContain("inputs.release_tag");
    expect(promotionCheckoutStep?.run).toContain('checkout_ref="refs/tags/$PROMOTION_TAG"');
    expect(promotionVerifyStep?.env?.PROMOTE_REF).toContain("workflow_dispatch");
    const promotionInputGuard =
      /case "\$PROMOTION_TAG" in[\s\S]*?esac[\s\S]*?case "\$PROMOTION_TAG" in[\s\S]*?esac/.exec(
        promotionCheckoutStep?.run ?? "",
      )?.[0];
    expect(promotionInputGuard).toBeDefined();
    for (const candidate of ["v1.2.3", "v1.2.3-rc.1"]) {
      const result = spawnSync(
        "bash",
        ["-c", `set -eu\nPROMOTION_TAG="$1"\n${promotionInputGuard ?? ""}`, "guard", candidate],
        { encoding: "utf8" },
      );
      expect(result.status, candidate).toBe(0);
    }
    for (const candidate of ["v1.2.3;rm", "refs/heads/main", "x1.2.3"]) {
      const result = spawnSync(
        "bash",
        ["-c", `set -eu\nPROMOTION_TAG="$1"\n${promotionInputGuard ?? ""}`, "guard", candidate],
        { encoding: "utf8" },
      );
      expect(result.status, candidate).not.toBe(0);
    }
    expect(buildJob?.if).toContain("!startsWith(github.ref, 'refs/tags/promote-v')");
    expect(promoteJob?.if).toContain("workflow_dispatch");
    expect(promoteJob?.if).toContain("refs/tags/promote-v");
    expect(preflightStep?.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(artifactStep?.if).toBe(
      "startsWith(github.ref, 'refs/tags/v') || startsWith(github.ref, 'refs/heads/runner-test/') || github.ref == 'refs/heads/main'",
    );
    expect(artifactStep?.env?.GITHUB_TOKEN).toBe("");
    expect(assetsStep?.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(uploadStep?.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(publishStep?.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(publishedVerifyStep?.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    // The publishing step must not resolve its tools from a PATH an earlier step can
    // extend, and it must refuse a resolved tool from outside the trusted prefixes.
    expect(publishStep?.env?.PATH).toContain("/run/current-system/sw/bin");
    expect(publishStep?.env?.PATH).not.toContain("$");
    expect(publishStep?.run).toContain("refusing an untrusted curl");
    expect(publishStep?.run).toContain('curl_path="$(command -v curl)"');
    expect(publishStep?.run).not.toContain("/usr/bin/curl");
    // The candidate is created in the token-free step; the token step writes only
    // what the earlier step decided.
    expect(uploadStep?.env?.RELEASE_PUBLISH_TOKEN).toBeUndefined();
    expect(publishedVerifyStep?.env?.RELEASE_PUBLISH_TOKEN).toBeUndefined();

    // The candidate is created off the general install path...
    // Every parser that decides on the release requires the field rather than
    // defaulting it: an absent `draft` would otherwise read as "not a draft". Naming
    // the steps keeps this from passing on a count that a rename could satisfy.
    const draftDecidingSteps = [
      ["linux-artifact", "Prepare the GitHub release upload"],
      ["linux-artifact", "Re-verify the published release"],
      ["promote-release", "Verify the candidate artifact"],
      ["promote-release", "Re-verify the promoted release"],
    ] as const;
    // Promotion compares downloads with cmp before and after the token-bearing step,
    // so the tool must be established as present rather than discovered missing.
    const promoteTooling = (
      parseYaml(raw) as {
        jobs: Record<string, { steps?: { name?: string; run?: string }[] }>;
      }
    ).jobs["promote-release"]?.steps?.find((step) => step.name === "Checkout promotion tooling");
    expect(promoteTooling?.run).toContain(
      "for command_name in git curl cmp getconf strings grep sort tail cut tr sleep;",
    );
    expect(raw).toContain("printf '%s' \"$RELEASE_PUBLISH_TOKEN\"");
    expect(raw).not.toContain("Authorization: Bearer ***");

    for (const [jobName, stepName] of draftDecidingSteps) {
      const step = (
        parseYaml(raw) as {
          jobs: Record<string, { steps?: { name?: string; run?: string }[] }>;
        }
      ).jobs[jobName]?.steps?.find((candidate) => candidate.name === stepName);
      expect(`${jobName}/${stepName}: ${step === undefined ? "missing" : ""}`).toBe(
        `${jobName}/${stepName}: `,
      );
      expect(step?.run ?? "").toContain("typeof release.draft !== 'boolean'");
    }
    // The artifact must be bound to the release version, not only the commit.
    expect((raw.match(/--expect-version/g) ?? []).length).toBe(3);
    expect(raw).toContain("github.com/monty033/NookBridge");
    expect(raw).toContain('API_ORIGIN="https://api.github.com"');
    expect(raw).toContain('REPO_API="$API_ORIGIN/repos/monty033/NookBridge"');
    expect(raw).toContain("printf 'api_origin\\t%s\\n' \"$API_ORIGIN\"");
    expect(raw).toContain('api_origin="$(field api_origin)"');
    expect(raw).not.toContain(`printf 'api_base\\t%s\\n' "$API"`);
    expect(raw).not.toContain('api_base="$(field api_base)"');
    expect(raw).not.toContain('}\' "$2" | head -1');
    expect(raw).not.toContain("| head -1 | tr -dc");
    expect(raw).toContain("trap on_exit EXIT");
    expect(raw).toContain("PROMOTION_PHASE");
    expect(raw).toContain("api_origin_validation");
    // A partial candidate is recreated on a re-run, because a tag cannot be moved and
    // an interrupted upload would otherwise be unrecoverable.
    expect(raw).toContain("action\\trecreate");
    expect(raw).toContain("-X DELETE");
    expect(raw).toContain('"$repo_api/releases/tags/$rel_tag"');
    // The retry path must accept the shape the publishing path creates — draft:false,
    // prerelease:true — or every retry of a partial upload would abort.
    expect(raw).toContain("draft: false");
    expect(raw).toContain('test "$existing_draft" = "false"');
    expect(raw).toContain('test "$existing_prerelease" = "true"');
    // The publishing step is given the runner's commit and compares both the payload and
    // the live release against it before any authenticated request.
    expect(raw).toContain("RELEASE_SHA: ${{ github.sha }}");
    expect(raw).toContain("the release payload names a different commit");
    expect(raw).toContain("the release to recreate names a different commit");
    expect(raw).toContain("the release to promote names a different commit");
    expect(raw).not.toContain('existing_id="$(cat "$decision"');
    // Nothing authenticated may happen before the payload is known to be the right one:
    // the retry path deletes a release, so a tampered payload would otherwise take the
    // immutable tag's candidate with it and leave nothing to retry from.
    expect(raw.indexOf("the release payload names a different commit")).toBeLessThan(
      raw.indexOf('if [ "$action" = recreate ]'),
    );
    expect(raw).toContain("prerelease: true");
    expect(raw).toContain("release.prerelease !== true");
    expect(raw).toContain("release.target_commitish");
    expect(raw).toContain("existing GitHub release is not the matching prerelease candidate");
    // ...and promotion is the only thing that clears the flag.
    expect(raw).toContain('{"prerelease":false}');
    // A failed authenticated write must expose its HTTP status and bounded response
    // body; otherwise a rerun can fail closed without revealing whether the token,
    // endpoint, or release state was rejected.
    expect(raw).toContain("patch-response.json");
    expect(raw).toContain("GitHub promotion failed (curl exit %s, HTTP %s)");
    expect(raw).toContain("tr '\\n\\t' '  '");
    const patchBlockStart = raw.indexOf('patch_response="$PWD/.promote-work/patch-response.json"');
    const patchBlockEnd = raw.indexOf("printf 'prerelease flag cleared", patchBlockStart);
    expect(patchBlockStart).toBeGreaterThanOrEqual(0);
    expect(patchBlockEnd).toBeGreaterThan(patchBlockStart);
    const workDirMkdirIndex = raw.indexOf('mkdir -p "$work_dir"');
    expect(workDirMkdirIndex).toBeGreaterThanOrEqual(0);
    expect(workDirMkdirIndex).toBeLessThan(patchBlockStart);
    const patchBlock = raw.slice(patchBlockStart, patchBlockEnd);
    const guardedCurlIndex = patchBlock.indexOf("if patch_status=");
    const curlElseIndex = patchBlock.indexOf("\n          else", guardedCurlIndex);
    const curlExitIndex = patchBlock.indexOf("patch_curl_exit=$?");
    const curlGuardEndIndex = patchBlock.indexOf("\n          fi", guardedCurlIndex);
    const promoteStepStart = raw.indexOf("- name: Promote candidate release");
    const promoteSetEIndex = raw.indexOf("set -eu", promoteStepStart);
    expect(guardedCurlIndex).toBeGreaterThanOrEqual(0);
    expect(curlElseIndex).toBeGreaterThan(guardedCurlIndex);
    expect(curlExitIndex).toBeGreaterThan(curlElseIndex);
    expect(curlGuardEndIndex).toBeGreaterThan(curlExitIndex);
    const guardedCurlAbsolute = patchBlockStart + guardedCurlIndex;
    expect(promoteStepStart).toBeGreaterThanOrEqual(0);
    expect(promoteSetEIndex).toBeGreaterThan(promoteStepStart);
    expect(promoteSetEIndex).toBeLessThan(guardedCurlAbsolute);
    expect(patchBlock).toContain("set +e");
    expect(patchBlock).toContain('patch_status=""');
    expect(patchBlock).toContain("set -e");
    const diagnosticsWriteIndex = patchBlock.indexOf('> "$patch_diagnostics"');
    expect(diagnosticsWriteIndex).toBeGreaterThanOrEqual(0);
    const errexitRestoreIndex = patchBlock.indexOf("\n          set -e");
    const guardedCurlRelativeIndex = patchBlock.indexOf("if patch_status=");
    expect(errexitRestoreIndex).toBeGreaterThan(guardedCurlRelativeIndex);
    expect(errexitRestoreIndex).toBeLessThan(diagnosticsWriteIndex);
    expect(patchBlock).toContain('[ -s "$patch_response" ]');
    expect(patchBlock).toContain("<no response body>");
    expect(patchBlock).toContain(': > "$patch_response"');
    expect(patchBlock).toContain("curl exit %s");
    expect(patchBlock).toContain("cut -c 1-1000");
    expect(patchBlock).toContain('response_body="$(tr');
    expect(patchBlock).toContain("<redacted response body>");
    expect(patchBlock).toContain("printf 'response_body\\t%s\\n' \"$response_body\"");
    expect(patchBlock).not.toContain("FORGEJO_OUTPUT");
    expect(patchBlock).not.toContain("exit 1");
    expect(patchBlock).toContain(
      "printf 'promotion diagnostics captured; deferring failure to the final diagnostics gate\\n'",
    );
    expect(patchBlock).toContain("exit 0");
    expect(patchBlock).toContain('case "$response_body" in');
    expect(patchBlock).toContain('*"$RELEASE_PUBLISH_TOKEN"*)');
    const diagnosticsResetIndex = raw.indexOf('rm -f "$patch_diagnostics"');
    const patchRequestIndex = raw.indexOf('patch_status="$("$curl_path"');
    expect(raw).toContain('patch_diagnostics="$PWD/.promote-work/promotion-diagnostics.tsv"');
    expect(diagnosticsResetIndex).toBeGreaterThanOrEqual(0);
    expect(diagnosticsResetIndex).toBeLessThan(patchRequestIndex);
    expect(patchRequestIndex).toBeGreaterThanOrEqual(0);
    expect(raw).toContain("promotion-diagnostics.tsv");
    expect(patchBlock).toContain("printf 'curl_exit\\t%s\\n' \"$patch_curl_exit\"");
    expect(patchBlock).toContain("printf 'http_status\\t%s\\n' \"$patch_status\"");
    const promotionJob = (
      parseYaml(raw) as {
        jobs: Record<
          string,
          {
            steps?: {
              name?: string;
              id?: string;
              if?: string;
              run?: string;
              uses?: string;
              "continue-on-error"?: boolean;
              with?: Record<string, string>;
              env?: Record<string, string>;
            }[];
          }
        >;
      }
    ).jobs["promote-release"];
    const promotionDiagnostics = promotionJob?.steps?.find(
      (step) => step.name === "Report promotion diagnostics",
    );
    expect(promotionDiagnostics?.if).toBe("always()");
    expect(promotionDiagnostics?.["continue-on-error"]).toBeUndefined();
    expect(promotionDiagnostics?.run ?? "").toContain("PROMOTION_CURL_EXIT");
    expect(promotionDiagnostics?.run ?? "").toContain("PROMOTION_HTTP_STATUS");
    expect(promotionDiagnostics?.run ?? "").toContain("PROMOTION_RESPONSE_BODY");
    expect(promotionDiagnostics?.run ?? "").toContain("PROMOTION_DIAGNOSTICS_OUTPUT_MISSING");
    expect(promotionDiagnostics?.run ?? "").toContain("promotion-diagnostics.tsv");
    expect(promotionDiagnostics?.run ?? "").toContain("mkdir -p");
    expect(promotionDiagnostics?.run ?? "").toContain('> "$report"');
    expect(promotionDiagnostics?.run ?? "").toContain("::error title=GitHub promotion::");
    expect(promotionDiagnostics?.run ?? "").toContain(
      "PROMOTION_DIAGNOSTICS phase=%s reason=%s curl_exit=%s http_status=%s",
    );
    expect(promotionDiagnostics?.run ?? "").toContain("PROMOTION_RESPONSE_BODY %s");
    expect(promotionDiagnostics?.run ?? "").toContain("promotion-diagnostics.tsv");
    expect(promotionDiagnostics?.run ?? "").not.toContain("RELEASE_PUBLISH_TOKEN");
    expect(promotionDiagnostics?.env).toEqual({
      FORGEJO_TOKEN: "",
      GITHUB_TOKEN: "",
      PROMOTION_STEP_OUTCOME: "${{ steps.promote_candidate.outcome }}",
    });
    const promotionSteps = promotionJob?.steps ?? [];
    const promoteIndex = promotionSteps.findIndex(
      (step) => step.name === "Promote candidate release",
    );
    const diagnosticsIndex = promotionSteps.findIndex(
      (step) => step.name === "Report promotion diagnostics",
    );
    const reverifyIndex = promotionSteps.findIndex(
      (step) => step.name === "Re-verify the promoted release",
    );
    const promoteStep = promotionSteps.find((step) => step.name === "Promote candidate release");
    expect(promoteStep?.id).toBe("promote_candidate");
    expect(promoteStep?.env?.RELEASE_PUBLISH_TOKEN).toBe("${{ secrets.RELEASE_PUBLISH_TOKEN }}");
    const diagnosticsArtifact = promotionSteps.find(
      (step) => step.name === "Upload promotion diagnostics artifact",
    );
    const deferredFailure = promotionSteps.find(
      (step) => step.name === "Fail after promotion diagnostics",
    );
    expect(diagnosticsArtifact?.if).toBe("always()");
    expect(diagnosticsArtifact?.["continue-on-error"]).toBe(true);
    expect(diagnosticsArtifact?.uses).toBe("https://code.forgejo.org/actions/upload-artifact@v3");
    const diagnosticsPath = ".promote-work/promotion-diagnostics.tsv";
    expect(raw).toContain(`patch_diagnostics="$PWD/${diagnosticsPath}"`);
    const diagnosticsWriterStart = patchBlock.indexOf("printf 'curl_exit");
    const diagnosticsWriteBlock = patchBlock.slice(diagnosticsWriterStart, diagnosticsWriteIndex);
    expect(diagnosticsWriterStart).toBeGreaterThanOrEqual(0);
    expect((diagnosticsWriteBlock.match(/RELEASE_PUBLISH_TOKEN/g) ?? []).length).toBe(0);
    expect(diagnosticsArtifact?.with?.path).toBe(diagnosticsPath);
    expect(deferredFailure?.if).toBe("always()");
    expect(deferredFailure?.["continue-on-error"]).toBeUndefined();
    expect(deferredFailure?.env).toBeUndefined();
    expect(deferredFailure?.run ?? "").toContain('if [ -s "$report" ]; then');
    expect(deferredFailure?.run ?? "").toContain(
      "GitHub promotion failed after diagnostics handling",
    );
    expect(deferredFailure?.run ?? "").toContain("exit 1");
    expect(raw).toContain("promotion-diagnostics-${{ github.run_id }}");
    expect(raw).toContain("if-no-files-found: ignore");
    expect(raw).toContain("retention-days: 7");
    expect(promoteIndex).toBeGreaterThanOrEqual(0);
    expect(diagnosticsIndex).toBeGreaterThan(promoteIndex);
    const deferredFailureIndex = promotionSteps.findIndex(
      (step) => step.name === "Fail after promotion diagnostics",
    );
    expect(deferredFailureIndex).toBeGreaterThan(diagnosticsIndex);
    const diagnosticsArtifactIndex = promotionSteps.findIndex(
      (step) => step.name === "Upload promotion diagnostics artifact",
    );
    expect(diagnosticsArtifactIndex).toBeGreaterThan(diagnosticsIndex);
    expect(deferredFailureIndex).toBeGreaterThan(diagnosticsArtifactIndex);
    expect(reverifyIndex).toBeGreaterThan(deferredFailureIndex);
    // Promotion re-verifies provenance against the release's own target commit.
    expect(raw).toContain('--expect-git-commit "$target_commit"');
    // Promotion reads the state back in a step that holds no secret; a successful
    // PATCH is not proof of its own effect.
    expect(raw).toMatch(/release\.prerelease !== false/);
    expect(raw).toContain("the release is still a prerelease after promotion");
    // Promotion requires the complete published asset set, not just the two
    // files its own steps download, so a vanished installer cannot ship.
    expect(raw).toContain("missing GitHub release asset");
    for (const required of [
      "install.sh",
      "install-systemd.sh",
      "verify-linux-artifact.sh",
      "SHA256SUMS",
    ]) {
      expect(raw).toContain(`'${required}'`);
    }
    // The versioned artifact name is supplied by the job, not hard-coded.
    expect(raw).toContain("process.argv[1]");
    // The promotion ref must name the commit the canonical release tag points
    // at, so a hand-pushed promote-* ref cannot clear the flag for another
    // revision...
    expect(raw).toContain("git rev-parse --verify 'FETCH_HEAD^{commit}'");
    expect(raw).toContain('test "$canonical_tag_commit" = "$target_commit"');
    // ...and the verification tooling is taken from that tagged revision rather
    // than from the ref that triggered the job.
    expect(raw).toContain('git checkout -q --detach "$canonical_tag_commit"');
    // The published installers must match the tagged sources byte-for-byte,
    // because the checksum file does not cover install.sh.
    expect(raw).toContain('cmp -s "$work_dir/$installer" "$installer_source"');
    expect(raw).toContain("scripts/install-from-github.sh");
    // The asset set is checked again after the flip, not only before it.
    expect(raw).toContain("missing GitHub release asset after promotion");
    // The triggering ref must itself name the canonical commit, and the version
    // must be well formed before it is interpolated into API paths.
    expect(raw).toContain("promote_ref_commit=\"$(git rev-parse --verify 'HEAD^{commit}')\"");
    expect(raw).toContain('test "$promote_ref_commit" = "$canonical_tag_commit"');
    expect(raw).toContain("malformed promotion version");
    // The promoted release must still be the verified one after the flip.
    expect(raw).toContain("target !== process.argv[2]");
    // Installer bytes are re-verified after the flip as well, because an asset
    // can be replaced between the pre-flip checks and the PATCH.
    expect(raw).toContain('"$after_dir/$installer"');
    // The artifact and its checksum file are re-verified too, so the promoted
    // release is not verified only in part.
    expect(raw).toContain('--checksum-file "$after_dir/SHA256SUMS"');
    // The asset set must be exactly the expected one, before and after the flip.
    expect(raw).toContain("unexpected GitHub release asset");
    // Asset names become query-string values and are encoded, not interpolated.
    // An asset name becomes a query-string value, so a name outside the permitted
    // character set is refused rather than encoded.
    expect(raw).toContain("unusable asset name");
    expect(raw).toContain("*[!A-Za-z0-9._-]*)");
    // The promotion version must satisfy the release policy, checked by the same
    // script the operator command's rules are tested against rather than by a
    // second inline copy that can drift.
    expect(raw).toContain('bash scripts/check-release-version.sh "$VERSION"');
    expect(raw).not.toContain("*[!0-9A-Za-z.-]*|*+*|*.|*-|.*)");
    // A hand-pushed tag must not publish an artifact whose manifest disagrees with
    // the release version.
    expect(raw).toContain('test "$package_version" = "$VERSION"');
    expect(raw).toContain('test "$lock_version" = "$VERSION"');
    // A numeric prerelease identifier may not carry a leading zero. The rule lives
    // in the shared validator now, and the agreement test pins both callers to it.
    expect(
      readFileSync(resolve(process.cwd(), "scripts", "check-release-version.sh"), "utf8"),
    ).toContain("IFS=.");
    // No script from the released revision runs in a step that holds the publishing
    // token: the write is its own step and uses curl plus embedded Node only.
    const parsedJobs = (
      parseYaml(raw) as {
        jobs: Record<
          string,
          { steps: { name: string; env?: Record<string, string>; run?: string }[] }
        >;
      }
    ).jobs;
    const buildSteps = parsedJobs["linux-artifact"]!.steps as {
      name: string;
      env?: Record<string, string>;
      run?: string;
    }[];
    const promoteSteps = parsedJobs["promote-release"]!.steps as {
      name: string;
      env?: Record<string, string>;
      run?: string;
    }[];
    // Every step that holds the token, in either job, is held to the same rules: a
    // rule asserted only for the promotion step leaves the publish step free to break
    // it.
    const allSteps = (
      [
        ["linux-artifact", buildSteps],
        ["promote-release", promoteSteps],
      ] as const
    ).flatMap(([jobName, steps]) =>
      steps
        .filter((step) => step.env?.RELEASE_PUBLISH_TOKEN !== undefined)
        .map((step) => ({ jobName, step })),
    );
    expect(allSteps.map(({ jobName, step }) => `${jobName}/${step.name}`)).toStrictEqual([
      "linux-artifact/Publish release assets",
      "promote-release/Promote candidate release",
    ]);
    const tokenSteps = allSteps.map(({ step }) => step);
    for (const step of tokenSteps) {
      const run = step.run ?? "";
      expect(run).not.toContain("scripts/");
      // The step must not source cross-step shell state or depend on PATH: an earlier
      // step the released revision can influence could otherwise hand it a shell
      // fragment or an alternate `curl`, and the token would go with it.
      expect(run).not.toContain('. "$PWD');
      expect(run).not.toContain("source ");
      // The tool is resolved from an explicit PATH and validated against the trusted
      // prefixes, rather than hardcoding a path that does not exist on every runner
      // (a NixOS runner has no /usr/bin/curl).
      expect(run).toContain('curl_path="$(command -v curl)"');
      expect(run).toContain("refusing an untrusted curl");
      expect(step.env?.PATH).toContain("/run/current-system/sw/bin");
      // A non-interactive shell sources BASH_ENV before its first line, so a value an
      // earlier tagged step wrote to GITHUB_ENV would otherwise run with the token.
      expect(step.env?.BASH_ENV).toBe("");
      expect(step.env?.ENV).toBe("");
      // curl reads a default configuration file even when given --config, and the
      // loader honours LD_PRELOAD, so both are cleared and every call passes -q.
      expect(step.env?.LD_PRELOAD).toBe("");
      // LD_PRELOAD is not the only way in: the loader also searches LD_LIBRARY_PATH and
      // honours LD_AUDIT, and a planted trust anchor would let the request be rewritten
      // rather than stopped.
      expect(step.env?.LD_LIBRARY_PATH).toBe("");
      expect(step.env?.LD_AUDIT).toBe("");
      expect(step.env?.SSL_CERT_FILE).toBe("");
      // The TLS stack is configured by environment too: OpenSSL loads a configuration
      // file and provider modules named by these, before any request is made.
      expect(step.env?.OPENSSL_CONF).toBe("");
      expect(step.env?.OPENSSL_MODULES).toBe("");
      expect(step.env?.OPENSSL_ENGINES).toBe("");
      expect(step.env?.CURL_HOME).toBe("");
      expect(step.env?.https_proxy).toBe("");
      expect(run).toContain("for refused_variable in BASH_ENV ENV LD_PRELOAD LD_LIBRARY_PATH");
      for (const line of run.split("\n")) {
        // An invocation starts the line; the guard's own `case` does not.
        if (/^\s*"\$curl_path"/.test(line)) expect(line).toContain("-q");
      }
      // The write step reads its inputs from a line-oriented file rather than from
      // shell it would source; the promotion and publishing paths name it differently.
      expect(run).toContain(".tsv");
      // The release it acts on is read from the API by tag inside the step, because a
      // file written by an earlier step can be replaced by a process that step left
      // behind and this step is the one holding the token.
      expect(run).toContain("/releases/tags/$rel_tag");
      expect(run).not.toContain("field release_id");
      // Forgejo exports its automatic token under both names.
      expect(run).toContain("FORGEJO_TOKEN GITHUB_TOKEN");
      // The commit the release names is rechecked inside the step that deletes,
      // creates, or flips it, not only by the token-free steps around it.
      expect(run).toContain("names a different commit");
      expect(run).toContain("OPENSSL_CONF OPENSSL_MODULES");
      // No interpreter from PATH in the token-bearing step.
      expect(run).not.toMatch(/^\s*node /m);
      expect(run).not.toContain("node -e");
    }
    // The public mirror is readable anonymously, so the verification steps hold no
    // secret at all.
    for (const name of ["Verify the candidate artifact", "Re-verify the promoted release"]) {
      const step = promoteSteps.find((candidate) => candidate.name === name);
      expect(step?.env?.RELEASE_PUBLISH_TOKEN).toBeUndefined();
    }
  });

  it("keeps the promote step successful when the PATCH fails and writes diagnostics", () => {
    const raw = readFileSync(linuxArtifactWorkflow, "utf8");
    const patchStart = raw.indexOf(
      '          patch_response="$PWD/.promote-work/patch-response.json"',
    );
    const patchEnd = raw.indexOf("          printf 'prerelease flag cleared", patchStart);
    expect(patchStart).toBeGreaterThanOrEqual(0);
    expect(patchEnd).toBeGreaterThan(patchStart);
    const patchScript = raw
      .slice(patchStart, patchEnd)
      .split("\n")
      .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
      .join("\n");
    const root = mkdtempSync(join(tmpdir(), "nookbridge-promotion-curl-test-"));
    fixtureRoots.push(root);
    mkdirSync(join(root, ".promote-work"));
    const fakeCurl = join(root, "curl");
    writeFileSync(fakeCurl, "#!/bin/sh\nexit 22\n");
    chmodSync(fakeCurl, 0o755);
    const result = spawnSync(
      "bash",
      [
        "-eu",
        "-c",
        [
          'curl_path="$PWD/curl"',
          'curl_config="$PWD/curl.conf"',
          'repo_api="https://api.example.test/repos/monty033/NookBridge"',
          "release_id=1",
          'rel_tag="v0.1.2"',
          'RELEASE_PUBLISH_TOKEN="fixture-token"',
          'phase="patch"',
          "write_result() { :; }",
          'patch_diagnostics="$PWD/.promote-work/promotion-diagnostics.tsv"',
          patchScript,
        ].join("\n"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, ".promote-work", "promotion-diagnostics.tsv"), "utf8")).toBe(
      "phase\tpatch\nreason\tpatch_failed\ncurl_exit\t22\nhttp_status\t\nresponse_body\t<no response body>\n",
    );
  });

  it("preserves an HTTP error body in promotion diagnostics", () => {
    const raw = readFileSync(linuxArtifactWorkflow, "utf8");
    const patchStart = raw.indexOf(
      '          patch_response="$PWD/.promote-work/patch-response.json"',
    );
    const patchEnd = raw.indexOf("          printf 'prerelease flag cleared", patchStart);
    const patchScript = raw
      .slice(patchStart, patchEnd)
      .split("\n")
      .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
      .join("\n");
    const root = mkdtempSync(join(tmpdir(), "nookbridge-promotion-body-test-"));
    fixtureRoots.push(root);
    mkdirSync(join(root, ".promote-work"));
    const fakeCurl = join(root, "curl");
    writeFileSync(
      fakeCurl,
      '#!/bin/sh\nprintf \'403\'\nprintf \'{"message":"denied"}\' > "$PWD/.promote-work/patch-response.json"\nexit 0\n',
    );
    chmodSync(fakeCurl, 0o755);
    const result = spawnSync(
      "bash",
      [
        "-eu",
        "-c",
        [
          'curl_path="$PWD/curl"',
          'curl_config="$PWD/curl.conf"',
          'repo_api="https://api.example.test/repos/monty033/NookBridge"',
          "release_id=1",
          'rel_tag="v0.1.2"',
          'RELEASE_PUBLISH_TOKEN="fixture-token"',
          'phase="patch"',
          "write_result() { :; }",
          'patch_diagnostics="$PWD/.promote-work/promotion-diagnostics.tsv"',
          patchScript,
        ].join("\n"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, ".promote-work", "promotion-diagnostics.tsv"), "utf8")).toBe(
      'phase\tpatch\nreason\tpatch_failed\ncurl_exit\t0\nhttp_status\t403\nresponse_body\t{"message":"denied"}\n',
    );
  });

  it("executes the deferred promotion report gate for failed, successful, and missing results", () => {
    const raw = readFileSync(linuxArtifactWorkflow, "utf8");
    const steps = (
      parseYaml(raw) as { jobs: Record<string, { steps: { name: string; run?: string }[] }> }
    ).jobs["promote-release"]!.steps;
    const reportRun = steps.find((step) => step.name === "Report promotion diagnostics")?.run;
    expect(reportRun).toBeTruthy();

    const runReport = (resultBody?: string, reportBody?: string) => {
      const root = mkdtempSync(join(tmpdir(), "nookbridge-promotion-report-test-"));
      fixtureRoots.push(root);
      mkdirSync(join(root, ".promote-work"));
      if (resultBody !== undefined)
        writeFileSync(join(root, ".promote-work", "promotion-result.tsv"), resultBody);
      if (reportBody !== undefined)
        writeFileSync(join(root, ".promote-work", "promotion-diagnostics.tsv"), reportBody);
      return spawnSync("bash", ["-eu", "-c", reportRun!], { cwd: root, encoding: "utf8" });
    };

    const failed = runReport(
      "status\tfailed\nphase\tpatch\nreason\tpatch_failed\ncurl_exit\t22\nhttp_status\t\nresponse_body\t<no response body>\n",
      "phase\tpatch\nreason\tpatch_failed\ncurl_exit\t22\nhttp_status\t\nresponse_body\t<no response body>\n",
    );
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("PROMOTION_DIAGNOSTICS phase=patch reason=patch_failed");

    const successful = runReport(
      "status\tsuccess\nphase\tpatch\nreason\tsucceeded\ncurl_exit\t0\nhttp_status\t200\nresponse_body\t\n",
    );
    expect(successful.status).toBe(0);

    const missing = runReport();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("PROMOTION_RESULT_OUTPUT_MISSING");
  });

  it("executes public GET failure capture and the non-failure branch", () => {
    const raw = readFileSync(linuxArtifactWorkflow, "utf8");
    const promoteStart = raw.indexOf("- name: Promote candidate release");
    const runStart = raw.indexOf("          set -eu\n          patch_diagnostics=", promoteStart);
    const setupEnd = raw.indexOf('          rm -f "$patch_diagnostics"', runStart);
    const publicStart = raw.indexOf("          phase=public_get", setupEnd);
    const publicEnd = raw.indexOf("          phase=release_validation", publicStart);
    expect(runStart).toBeGreaterThanOrEqual(0);
    expect(publicStart).toBeGreaterThan(runStart);
    expect(publicEnd).toBeGreaterThan(publicStart);
    const extract = (start: number, end: number) =>
      raw
        .slice(start, end)
        .split("\n")
        .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
        .join("\n");
    const setupScript = extract(runStart, setupEnd);
    const publicScript = extract(publicStart, publicEnd);

    const runPublicGet = (mode: "fail" | "success") => {
      const root = mkdtempSync(join(tmpdir(), "nookbridge-public-get-test-"));
      fixtureRoots.push(root);
      mkdirSync(join(root, ".promote-work"));
      writeFileSync(
        join(root, "curl"),
        `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ "${mode}" = fail ]; then
  printf '{"message":"denied"}' > "$out"
  exit 22
fi
printf '{"id":1,"tag_name":"v0.1.2","prerelease":true,"draft":false}' > "$out"
printf '200'
`,
      );
      chmodSync(join(root, "curl"), 0o755);
      return {
        root,
        result: spawnSync(
          "bash",
          [
            "-eu",
            "-c",
            [
              setupScript,
              'curl_path="$PWD/curl"',
              'repo_api="https://api.github.com/repos/monty033/NookBridge"',
              'rel_tag="v0.1.2"',
              'promote_json="$PWD/.promote-work/promote-existing.json"',
              publicScript,
            ].join("\n"),
          ],
          { cwd: root, encoding: "utf8" },
        ),
      };
    };

    const failed = runPublicGet("fail");
    expect(failed.result.status).toBe(0);
    expect(
      readFileSync(join(failed.root, ".promote-work", "promotion-result.tsv"), "utf8"),
    ).toContain("phase\tpublic_get\nreason\tpublic_get_failed\n");
    expect(
      readFileSync(join(failed.root, ".promote-work", "promotion-diagnostics.tsv"), "utf8"),
    ).toContain('response_body\t{"message":"denied"}\n');

    const successful = runPublicGet("success");
    expect(successful.result.status).toBe(0);
    expect(
      readFileSync(join(successful.root, ".promote-work", "promotion-result.tsv"), "utf8"),
    ).toContain("phase\tpublic_get\nreason\trunning\n");
  });

  it("records pre-PATCH contract failures through the promotion trap", () => {
    const raw = readFileSync(linuxArtifactWorkflow, "utf8");
    const promoteStart = raw.indexOf("- name: Promote candidate release");
    const runStart = raw.indexOf("          set -eu\n          patch_diagnostics=", promoteStart);
    const setupEnd = raw.indexOf('          rm -f "$patch_diagnostics"', runStart);
    expect(runStart).toBeGreaterThanOrEqual(0);
    expect(setupEnd).toBeGreaterThan(runStart);
    const setupScript = raw
      .slice(runStart, setupEnd)
      .split("\n")
      .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
      .join("\n");
    const root = mkdtempSync(join(tmpdir(), "nookbridge-promotion-trap-test-"));
    fixtureRoots.push(root);
    mkdirSync(join(root, ".promote-work"));
    const result = spawnSync(
      "bash",
      [
        "-eu",
        "-c",
        [
          setupScript,
          'phase="api_origin_validation"',
          'test "https://api.github.com/repos/monty033/NookBridge" = "https://api.github.com"',
        ].join("\n"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, ".promote-work", "promotion-diagnostics.tsv"), "utf8")).toBe(
      "phase\tapi_origin_validation\nreason\tstep_failed\ncurl_exit\t1\nhttp_status\t\nresponse_body\t<no response body>\n",
    );
    expect(readFileSync(join(root, ".promote-work", "promotion-result.tsv"), "utf8")).toBe(
      "status\tfailed\nphase\tapi_origin_validation\nreason\tstep_failed\ncurl_exit\t1\nhttp_status\t\nresponse_body\t<no response body>\n",
    );
  });

  it("does not clobber rich PATCH diagnostics when the deferred shell exits", () => {
    const raw = readFileSync(linuxArtifactWorkflow, "utf8");
    const promoteStart = raw.indexOf("- name: Promote candidate release");
    const runStart = raw.indexOf("          set -eu\n          patch_diagnostics=", promoteStart);
    const setupEnd = raw.indexOf('          rm -f "$patch_diagnostics"', runStart);
    const setupScript = raw
      .slice(runStart, setupEnd)
      .split("\n")
      .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
      .join("\n");
    const root = mkdtempSync(join(tmpdir(), "nookbridge-promotion-trap-preserve-test-"));
    fixtureRoots.push(root);
    mkdirSync(join(root, ".promote-work"));
    const result = spawnSync(
      "bash",
      [
        "-eu",
        "-c",
        [
          setupScript,
          'phase="patch"',
          '{ printf \'phase\\tpatch\\nreason\\tpatch_failed\\ncurl_exit\\t0\\nhttp_status\\t403\\nresponse_body\\t{\\"message\\":\\"denied\\"}\\n\'; } > "$patch_diagnostics"',
          "exit 1",
        ].join("\n"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, ".promote-work", "promotion-diagnostics.tsv"), "utf8")).toBe(
      'phase\tpatch\nreason\tpatch_failed\ncurl_exit\t0\nhttp_status\t403\nresponse_body\t{"message":"denied"}\n',
    );
  });
  it("retries an eventually consistent promoted-release readback", () => {
    const raw = readFileSync(linuxArtifactWorkflow, "utf8");
    const reverifyStart = raw.indexOf('          state_json="$work_dir/promoted-state.json"');
    const reverifyEnd = raw.indexOf("          # Re-verify the installer bytes", reverifyStart);
    expect(reverifyStart).toBeGreaterThanOrEqual(0);
    expect(reverifyEnd).toBeGreaterThan(reverifyStart);
    const readbackScript = raw
      .slice(reverifyStart, reverifyEnd)
      .split("\n")
      .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
      .join("\n");
    const root = mkdtempSync(join(tmpdir(), "nookbridge-promotion-readback-test-"));
    fixtureRoots.push(root);
    mkdirSync(join(root, ".promote-work"));
    writeFileSync(
      join(root, "curl"),
      `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
count=0
if [ -f "$PWD/curl-count" ]; then count="$(cat "$PWD/curl-count")"; fi
count=$((count + 1))
printf '%s' "$count" > "$PWD/curl-count"
prerelease=true
if [ "$count" -ge 2 ]; then prerelease=false; fi
printf '{"prerelease":%s,"draft":false,"target_commitish":"0123456789abcdef0123456789abcdef01234567","assets":[{"name":"install.sh"},{"name":"install-systemd.sh"},{"name":"verify-linux-artifact.sh"},{"name":"SHA256SUMS"},{"name":"nookbridge-v0.1.2-linux-x64-gnu.tar.gz"}]}' "$prerelease" > "$out"
`,
    );
    writeFileSync(join(root, "sleep"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(root, "curl"), 0o755);
    chmodSync(join(root, "sleep"), 0o755);
    const result = spawnSync(
      "bash",
      [
        "-eu",
        "-c",
        [
          'rel_tag="v0.1.2"',
          'target_commit="0123456789abcdef0123456789abcdef01234567"',
          'canonical_tag_commit="0123456789abcdef0123456789abcdef01234567"',
          'artifact="nookbridge-v0.1.2-linux-x64-gnu.tar.gz"',
          'work_dir="$PWD/.promote-work"',
          readbackScript,
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` },
      },
    );
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(readFileSync(join(root, "curl-count"), "utf8")).toBe("2");
    expect(result.stdout).toContain("promotion readback still sees the candidate state");
  });

  it("treats an already-promoted exact release as a verified no-op", () => {
    const raw = readFileSync(linuxArtifactWorkflow, "utf8");
    const decisionStart = raw.indexOf("          export RELEASE_JSON\n");
    const decisionEnd = raw.indexOf(
      "          IFS=$'\\t' read -r release_id promotion_action < \"$PWD/.promote-release-id\"",
      decisionStart,
    );
    expect(decisionStart).toBeGreaterThanOrEqual(0);
    expect(decisionEnd).toBeGreaterThan(decisionStart);
    const decisionScript = raw
      .slice(decisionStart, decisionEnd)
      .split("\n")
      .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
      .join("\n");
    const root = mkdtempSync(join(tmpdir(), "nookbridge-promotion-idempotent-test-"));
    fixtureRoots.push(root);
    writeFileSync(
      join(root, "promote.json"),
      JSON.stringify({
        id: 394888968,
        prerelease: false,
        draft: false,
        target_commitish: "0123456789abcdef0123456789abcdef01234567",
      }),
    );
    const result = spawnSync(
      "bash",
      ["-eu", "-c", ['RELEASE_JSON="$PWD/promote.json"', decisionScript].join("\n")],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(readFileSync(join(root, ".promote-release-id"), "utf8")).toBe(
      "394888968\talready_promoted\n",
    );
  });

  it("skips the authenticated mutation for an already-promoted release", () => {
    const raw = readFileSync(linuxArtifactWorkflow, "utf8");
    const noOpStart = raw.indexOf(
      "          phase=tag_validation\n",
      raw.indexOf("- name: Promote candidate release"),
    );
    const noOpEnd = raw.indexOf("          # The release to flip is read here", noOpStart);
    expect(noOpStart).toBeGreaterThanOrEqual(0);
    expect(noOpEnd).toBeGreaterThan(noOpStart);
    const noOpScript = raw
      .slice(noOpStart, noOpEnd)
      .split("\n")
      .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
      .join("\n");
    const root = mkdtempSync(join(tmpdir(), "nookbridge-promotion-noop-test-"));
    fixtureRoots.push(root);
    const result = spawnSync(
      "bash",
      [
        "-eu",
        "-c",
        [
          'promotion_result="$PWD/promotion-result.tsv"',
          'write_result() { printf "status\\t%s\\nphase\\t%s\\nreason\\t%s\\ncurl_exit\\t%s\\nhttp_status\\t%s\\nresponse_body\\t%s\\n" "$1" "$2" "$3" "$4" "$5" "$6" > "$promotion_result"; }',
          'rel_tag="v0.1.2"',
          'promotion_action="already_promoted"',
          noOpScript,
        ].join("\n"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain("no mutation needed for v0.1.2");
    expect(readFileSync(join(root, "promotion-result.tsv"), "utf8")).toContain(
      "status\tsuccess\nphase\talready_promoted\nreason\talready_promoted\n",
    );
  });

  it("runs the real artifact build on main and runner-test refs without publishing", () => {
    const raw = readFileSync(linuxArtifactWorkflow, "utf8");
    expect(raw).toContain("refs/heads/runner-test/");
    expect(raw).toContain("github.ref == 'refs/heads/main'");
    expect(raw).toContain('VERSION="ci-${GITHUB_SHA:0:12}"');
    // The preflight gate holds no token: the runs API is readable anonymously, and a
    // secret must not be reachable by the tagged revision's own script.
    expect(raw).not.toContain("RELEASE_PREFLIGHT_TOKEN");
    // A draft must not be accepted as the matching candidate: users cannot install
    // from a draft, so publishing assets onto one would report success for a release
    // nobody can reach.
    expect(raw).toContain("release.draft === true");
    expect(raw).toContain(
      'PREFLIGHT_RUNS_URL="${GITHUB_SERVER_URL}/api/v1/repos/${GITHUB_REPOSITORY}/actions/runs"',
    );
    expect(raw).toContain("node scripts/check-forgejo-preflight.mjs");
    expect(raw).toContain('GITHUB_TOKEN: ""');
    expect(raw).toContain("unexpected artifact-build ref");
    expect(raw).toContain("if: startsWith(github.ref, 'refs/tags/v')");
    // The provenance check is bound to the build step that produces the artifact,
    // not merely present somewhere in the file.
    const buildStep = (
      parseYaml(raw) as {
        jobs: Record<string, { steps: { name: string; run?: string }[] }>;
      }
    ).jobs["linux-artifact"]!.steps.find(
      (step) => step.name === "Build and verify x86_64 glibc artifact",
    );
    expect(buildStep?.run).toContain('--expect-git-commit "$GITHUB_SHA"');
    // The archive the packaging step consumes must be the one this step staged, at the
    // same deterministic path, and the runtime that runs the build must not be an
    // unpacked copy of it: the upstream binary cannot execute on this NixOS runner.
    expect(raw).toContain('RUNTIME_TARBALL="${RUNNER_TEMP:-/tmp}/node-v22.23.2-linux-x64.tar.gz"');
    expect(raw).toContain('archive_path="${RUNNER_TEMP:-/tmp}/$archive_name"');
    expect(raw).toContain("cached_sha256");
    expect(raw).not.toContain("tar -xzf");
    expect(raw).not.toContain('echo "$node_root/bin" >> "$GITHUB_PATH"');
  });
});
