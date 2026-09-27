/* global process */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd());
const classifier = resolve(repositoryRoot, "scripts", "release-channel.sh");
const releaseScript = resolve(repositoryRoot, "scripts", "release.sh");
const validator = resolve(repositoryRoot, "scripts", "check-release-version.sh");
const linuxArtifactWorkflow = resolve(
  repositoryRoot,
  ".forgejo",
  "workflows",
  "linux-artifact.yml",
);

function classify(version: string): { readonly status: number | null; readonly stdout: string } {
  const result = spawnSync("bash", [classifier, version], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout.trim() };
}

describe("release channel classifier", () => {
  it("classifies stable and beta versions, and refuses every other version", () => {
    const table: [string, string | null][] = [
      // Stable: the normal release line and the only promotable channel.
      ["0.1.2", "stable"],
      ["1.0.0", "stable"],
      // Beta: a pre-release testing track that is never promoted in place.
      ["0.2.0-beta.1", "beta"],
      ["0.2.0-beta.10", "beta"],
      ["1.0.0-beta.0", "beta"],
      // Valid SemVer, but not on a defined NookBridge channel: an unnumbered
      // beta, another maturity marker, or a non-numeric beta counter.
      ["0.2.0-beta", null],
      ["0.2.0-beta.x", null],
      ["0.2.0-beta.1.2", null],
      ["0.2.0-rc.1", null],
      ["1.0.0-alpha.2", null],
      ["1.0.0-0", null],
      // Not SemVer at all.
      ["foo", null],
      ["1.2", null],
      ["1.2.3+build", null],
      ["0.2.0-beta.01", null],
    ];

    for (const [version, expected] of table) {
      const result = classify(version);
      if (expected === null) {
        expect(result.status, version).not.toBe(0);
      } else {
        expect({ version, status: result.status, stdout: result.stdout }).toStrictEqual({
          version,
          status: 0,
          stdout: expected,
        });
      }
    }
  });

  it("delegates the version grammar to the shared release-version validator", () => {
    // The channel rule may not become a second copy of the SemVer policy: a
    // version the operator accepts and the workflow rejects would burn an
    // immutable tag before the release fails.
    const source = readFileSync(classifier, "utf8");
    expect(source).toContain('bash "$script_dir/check-release-version.sh" "$version"');
  });

  it("is the one channel implementation the operator command delegates to", () => {
    const source = readFileSync(releaseScript, "utf8");
    expect(source).toContain("release-channel.sh");
  });

  it("is the validator the workflow uses to refuse a non-stable promotion", () => {
    const workflow = readFileSync(linuxArtifactWorkflow, "utf8");
    expect(workflow).toContain("release-channel.sh");
  });

  it("accepts the same beta versions the grammar validator accepts", () => {
    // A beta version must be accepted by the grammar validator; otherwise the
    // workflow's first gate would reject it before the channel gate sees it.
    const grammar = spawnSync("bash", [validator, "0.2.0-beta.1"], { encoding: "utf8" });
    expect(grammar.status).toBe(0);
    expect(classify("0.2.0-beta.1").status).toBe(0);
  });
});
