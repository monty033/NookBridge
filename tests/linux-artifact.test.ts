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

    // The step that selects the pinned runtime also installs it, so `node` cannot be a
    // precondition of that step: on a runner without a host Node the job would exit
    // before it could install the runtime it is about to use.
    for (const jobName of ["linux-artifact", "promote-release"]) {
      const job = workflow.jobs[jobName]!;
      const runtimeStep = job.steps.find(
        (step) => step.name === "Verify pinned Node runtime and prepare portable runtime",
      )!;
      expect(runtimeStep.run ?? "").not.toMatch(/for command_name in [^\n]*\bnode\b/);
      expect(runtimeStep.run ?? "").toContain("command -v node");
      expect(runtimeStep.run ?? "").toContain('test "$(node --version)" = "v${NODE_VERSION}"');

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
        "set -eu",
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
    expect(promoteTooling?.run).toContain("for command_name in git curl cmp; do");

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
    // A partial candidate is recreated on a re-run, because a tag cannot be moved and
    // an interrupted upload would otherwise be unrecoverable.
    expect(raw).toContain("action\\trecreate");
    expect(raw).toContain("-X DELETE");
    expect(raw).toContain('"$api_base/repos/monty033/NookBridge/releases/tags/$rel_tag"');
    // The retry path must accept the shape the publishing path creates — draft:false,
    // prerelease:true — or every retry of a partial upload would abort.
    expect(raw).toContain("draft: false");
    expect(raw).toContain('test "$existing_draft" = "false"');
    expect(raw).toContain('test "$existing_prerelease" = "true"');
    expect(raw).not.toContain('existing_id="$(cat "$decision"');
    expect(raw).toContain("prerelease: true");
    expect(raw).toContain("release.prerelease !== true");
    expect(raw).toContain("release.target_commitish");
    expect(raw).toContain("existing GitHub release is not the matching prerelease candidate");
    // ...and promotion is the only thing that clears the flag.
    expect(raw).toContain('{"prerelease":false}');
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
      expect(step.env?.CURL_HOME).toBe("");
      expect(step.env?.https_proxy).toBe("");
      expect(run).toContain("for refused_variable in BASH_ENV ENV LD_PRELOAD CURL_HOME");
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
    // The pinned runtime is verified on every run and put on PATH, so later steps
    // package the runtime that was verified.
    expect(raw).toContain('echo "$node_root/bin" >> "$GITHUB_PATH"');
    expect(raw).toContain('test "$(command -v node)" = "$node_root/bin/node"');
    expect(raw).toContain("cached_sha256");
    // The extraction is rebuilt from the verified archive every run: trusting a
    // cached runtime because it reports the pinned version lets a preceding
    // source-controlled step substitute the binary that later gets packaged.
    expect(raw).not.toContain('"$node_root/bin/node" --version');
    expect(raw).toContain('rm -rf "$node_root"');
  });
});
