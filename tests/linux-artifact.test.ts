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
import { dirname, join } from "node:path";
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

describe("Linux artifact manifest contract", () => {
  it("selects only numeric GLIBCXX ABI symbols in the release workflow", () => {
    const workflow = readFileSync(linuxArtifactWorkflow, "utf8");

    expect(workflow).toContain("grep -E '^GLIBCXX_[0-9]+(\\.[0-9]+){1,2}$'");
    expect(workflow).not.toContain("grep '^GLIBCXX_' | sort -V");
    expect(workflow).toContain('test -n "$LIBSTDCXX_BASELINE"');
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
  it("publishes a tag push as a candidate and gates promotion behind a separate ref", () => {
    const raw = readFileSync(linuxArtifactWorkflow, "utf8");
    const doc = parseYaml(raw) as {
      on: { push: { branches: string[]; tags: string[] } };
      jobs: Record<
        string,
        {
          if?: string;
          steps?: Array<{ if?: string; name?: string; env?: Record<string, string> }>;
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
    const publishStep = buildJob?.steps?.find((step) => step.name === "Publish GitHub release");

    expect(doc.on.push.branches).toEqual(["main", "runner-test/**"]);
    expect(doc.on.push.tags).toEqual(["v*", "promote-v*"]);
    expect(buildJob?.if).toContain("!startsWith(github.ref, 'refs/tags/promote-v')");
    expect(promoteJob?.if).toContain("refs/tags/promote-v");
    expect(preflightStep?.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(artifactStep?.if).toBe(
      "startsWith(github.ref, 'refs/tags/v') || startsWith(github.ref, 'refs/heads/runner-test/') || github.ref == 'refs/heads/main'",
    );
    expect(artifactStep?.env?.GITHUB_TOKEN).toBe("");
    expect(assetsStep?.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(publishStep?.if).toBe("startsWith(github.ref, 'refs/tags/v')");

    // The candidate is created off the general install path...
    expect(raw).toContain("prerelease: true");
    expect(raw).toContain("release.prerelease !== true");
    expect(raw).toContain("release.target_commitish");
    expect(raw).toContain("existing GitHub release is not the matching prerelease candidate");
    // ...and promotion is the only thing that clears the flag.
    expect(raw).toContain('{"prerelease":false}');
    // Promotion re-verifies provenance against the release's own target commit.
    expect(raw).toContain('--expect-git-commit "$target_commit"');
    // Promotion reads the state back; a successful PATCH is not proof.
    expect(raw).toMatch(/test "\$promoted" = "false"/);
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
    expect(raw).toContain('test "$target_after" = "$canonical_tag_commit"');
    // Installer bytes are re-verified after the flip as well, because an asset
    // can be replaced between the pre-flip checks and the PATCH.
    expect(raw).toContain('"$after_dir/$installer"');
    // The artifact and its checksum file are re-verified too, so the promoted
    // release is not verified only in part.
    expect(raw).toContain('--checksum-file "$after_dir/SHA256SUMS"');
    // The asset set must be exactly the expected one, before and after the flip.
    expect(raw).toContain("unexpected GitHub release asset");
    // Asset names become query-string values and are encoded, not interpolated.
    expect(raw).toContain("encoded_name=");
    // The promotion version must be SemVer, not merely filename-safe.
    expect(raw).toContain("*[!0-9A-Za-z.-]*|*+*|*.|*-|.*)");
    // A hand-pushed tag must not publish an artifact whose manifest disagrees with
    // the release version.
    expect(raw).toContain('test "$package_version" = "$VERSION"');
    expect(raw).toContain('test "$lock_version" = "$VERSION"');
    // A numeric prerelease identifier may not carry a leading zero.
    expect(raw).toContain("IFS=.");
  });

  it("runs the real artifact build on main and runner-test refs without publishing", () => {
    const raw = readFileSync(linuxArtifactWorkflow, "utf8");

    expect(raw).toContain("refs/heads/runner-test/");
    expect(raw).toContain("github.ref == 'refs/heads/main'");
    expect(raw).toContain('VERSION="ci-${GITHUB_SHA:0:12}"');
    expect(raw).toContain("PREFLIGHT_READ_TOKEN: ${{ secrets.RELEASE_PREFLIGHT_TOKEN }}");
    expect(raw).toContain(
      'PREFLIGHT_RUNS_URL="${GITHUB_SERVER_URL}/api/v1/repos/${GITHUB_REPOSITORY}/actions/runs"',
    );
    expect(raw).toContain("node scripts/check-forgejo-preflight.mjs");
    expect(raw).toContain('GITHUB_TOKEN: ""');
    expect(raw).toContain("unexpected artifact-build ref");
    expect(raw).toContain("if: startsWith(github.ref, 'refs/tags/v')");
  });
});
