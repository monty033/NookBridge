/* global process, URL */

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const releaseScript = resolve(process.cwd(), "scripts", "release.sh");

const version = "0.1.2";
const tag = `v${version}`;
const promoteTag = `promote-${tag}`;
const artifactName = `nookbridge-${tag}-linux-x64-gnu.tar.gz`;

const fixtureRoots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  for (const root of fixtureRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

type Fixture = {
  readonly root: string;
  readonly work: string;
  readonly canonical: string;
  readonly commit: string;
};

function createFixture(options: { installerVersion?: string; lockVersion?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "nookbridge-release-"));
  fixtureRoots.push(root);
  const canonical = join(root, "canonical.git");
  const work = join(root, "work");
  git(["init", "--bare", "--initial-branch=main", canonical], root);
  git(["init", "--initial-branch=main", work], root);
  git(["config", "user.email", "release-test@example.invalid"], work);
  git(["config", "user.name", "Release Test"], work);
  mkdirSync(join(work, "scripts"), { recursive: true });
  writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "nookbridge", version })}\n`);
  writeFileSync(
    join(work, "package-lock.json"),
    `${JSON.stringify({
      name: "nookbridge",
      version: options.lockVersion ?? version,
      lockfileVersion: 3,
    })}\n`,
  );
  writeFileSync(
    join(work, "scripts", "install-from-github.sh"),
    `#!/usr/bin/env bash\nreadonly RELEASE_VERSION='${options.installerVersion ?? version}'\n`,
  );
  git(["add", "."], work);
  git(["commit", "-m", "fixture commit"], work);
  git(["remote", "add", "upstream", canonical], work);
  git(["push", "--quiet", "upstream", "main"], work);
  return { root, work, canonical, commit: git(["rev-parse", "HEAD"], work).trim() };
}

type StubRun = Record<string, unknown>;

function mainPreflight(commit: string): StubRun {
  return {
    workflow_id: "linux-artifact.yml",
    event: "push",
    prettyref: "main",
    commit_sha: commit,
    status: "success",
    index_in_repo: 304,
    html_url: "https://forgejo.example.invalid/actions/runs/304",
  };
}

function tagRun(commit: string, status: string): StubRun {
  return {
    workflow_id: "linux-artifact.yml",
    event: "push",
    prettyref: tag,
    commit_sha: commit,
    status,
    index_in_repo: 305,
    html_url: "https://forgejo.example.invalid/actions/runs/305",
  };
}

function candidateRelease(prerelease: boolean): Record<string, unknown> {
  return {
    tag_name: tag,
    prerelease,
    assets: [
      { name: "install.sh" },
      { name: "install-systemd.sh" },
      { name: "verify-linux-artifact.sh" },
      { name: "SHA256SUMS" },
      { name: artifactName },
    ],
  };
}

type StubOptions = {
  readonly runsFor?: (requestIndex: number) => StubRun[];
  readonly runsStatus?: number;
  readonly release?: Record<string, unknown> | null;
};

async function startStub(options: StubOptions) {
  let runRequests = 0;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${url.pathname}|${request.headers.authorization ?? "anonymous"}`);
    response.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/actions/runs")) {
      runRequests += 1;
      if (options.runsStatus !== undefined && options.runsStatus !== 200) {
        response.statusCode = options.runsStatus;
        response.end(JSON.stringify({ message: "runner unavailable" }));
        return;
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      const runs = page === 1 ? (options.runsFor?.(runRequests) ?? []) : [];
      response.end(JSON.stringify({ workflow_runs: runs }));
      return;
    }
    if (url.pathname.includes("/releases/tags/")) {
      if (!options.release) {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      response.end(JSON.stringify(options.release));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "Not Found" }));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("attempt to bind failed");
  return { base: `http://127.0.0.1:${address.port}`, requests };
}

function releaseEnv(base: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.NOOKBRIDGE_CANONICAL_REMOTE = "upstream";
  env.NOOKBRIDGE_FORGEJO_API_BASE = base;
  env.NOOKBRIDGE_GITHUB_API_BASE = base;
  env.NOOKBRIDGE_GITHUB_REPOSITORY = "monty033/NookBridge";
  env.NOOKBRIDGE_WATCH_INTERVAL = "1";
  env.NOOKBRIDGE_WATCH_TIMEOUT = "20";
  return env;
}

async function runRelease(args: readonly string[], fixture: Fixture, base: string) {
  try {
    const result = await execFileAsync("bash", [releaseScript, ...args], {
      cwd: fixture.work,
      env: releaseEnv(base),
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function tagType(repository: string, name: string): string {
  return git(["cat-file", "-t", `refs/tags/${name}`], repository).trim();
}

function tagSubject(repository: string, name: string): string {
  return git(
    ["for-each-ref", "--format=%(contents:subject)", `refs/tags/${name}`],
    repository,
  ).trim();
}

function tagCommit(repository: string, name: string): string {
  return git(["rev-parse", `refs/tags/${name}^{}`], repository).trim();
}

function tagPresent(repository: string, name: string): boolean {
  return (
    spawnSync("git", ["-C", repository, "rev-parse", "--verify", "--quiet", `refs/tags/${name}`])
      .status === 0
  );
}

describe("release operator command", () => {
  it("tags the canonical commit, pushes an annotated tag, and reports the candidate", async () => {
    const fixture = createFixture();
    const stub = await startStub({
      runsFor: () => [mainPreflight(fixture.commit), tagRun(fixture.commit, "success")],
      release: candidateRelease(true),
    });

    const result = await runRelease(["tag", "--yes"], fixture, stub.base);

    expect(result.code).toBe(0);
    // Git reports the pushed ref on stderr; only our own diagnostics may not appear.
    expect(result.stderr).not.toContain("release:");
    expect(tagType(fixture.canonical, tag)).toBe("tag");
    expect(tagSubject(fixture.canonical, tag)).toBe(`NookBridge ${tag}`);
    expect(tagCommit(fixture.canonical, tag)).toBe(fixture.commit);
    expect(result.stdout).toContain(`Pushed ${tag}.`);
    expect(result.stdout).toContain("Candidate v0.1.2 has all five assets");
    expect(result.stdout).toContain(`scripts/release.sh promote ${version}`);
    // The operator command reads public state anonymously; it must not carry a token.
    expect(stub.requests.every((entry) => entry.endsWith("|anonymous"))).toBe(true);
  });

  it("refuses to tag without a successful main preflight and pushes nothing", async () => {
    const fixture = createFixture();
    const stub = await startStub({ runsFor: () => [tagRun(fixture.commit, "failure")] });

    const result = await runRelease(["tag", "--yes"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no successful main runner preflight");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
  });

  it("refuses to tag when the installer pin disagrees with the package version", async () => {
    const fixture = createFixture({ installerVersion: "0.1.1" });
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(["tag", "--yes"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("installer pin");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
  });

  it("refuses to tag when the lockfile version disagrees", async () => {
    const fixture = createFixture({ lockVersion: "0.1.0" });
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(["tag", "--yes"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("package-lock.json");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
  });

  it("refuses to move a version that already has a canonical tag", async () => {
    const fixture = createFixture();
    const older = git(["rev-parse", "HEAD~0"], fixture.work).trim();
    git(["tag", "-a", tag, older, "-m", `NookBridge ${tag}`], fixture.work);
    git(["push", "--quiet", "upstream", `refs/tags/${tag}`], fixture.work);
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(["tag", "--yes"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("already exists");
    expect(tagCommit(fixture.canonical, tag)).toBe(older);
  });

  it("fails closed when the run history cannot be read", async () => {
    const fixture = createFixture();
    const stub = await startStub({ runsFor: () => [], runsStatus: 500 });

    const result = await runRelease(["tag", "--yes"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("cannot read Forgejo run state");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
  });

  it("reports the release state without publishing anything", async () => {
    const fixture = createFixture();
    const stub = await startStub({
      runsFor: () => [mainPreflight(fixture.commit)],
      release: null,
    });

    const result = await runRelease(["status"], fixture, stub.base);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`version=${version}`);
    expect(result.stdout).toContain(`canonical_commit=${fixture.commit}`);
    expect(result.stdout).toContain("version_surfaces=synchronized");
    expect(result.stdout).toContain(`tag_${tag}=absent`);
    expect(result.stdout).toContain("main_preflight=success");
    expect(result.stdout).toContain("mirror_release=absent");
    expect(result.stdout).toContain("release_ready=true");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
  });

  it("waits for the run and fails when the release workflow fails", async () => {
    const fixture = createFixture();
    const stub = await startStub({
      runsFor: () => [mainPreflight(fixture.commit), tagRun(fixture.commit, "failure")],
    });

    const result = await runRelease(["tag", "--yes"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("did not succeed");
    // The tag is still published: the workflow result cannot un-push a public tag.
    expect(tagPresent(fixture.canonical, tag)).toBe(true);
  });

  it("promotes a complete candidate release at the tagged commit", async () => {
    const fixture = createFixture();
    git(["tag", "-a", tag, fixture.commit, "-m", `NookBridge ${tag}`], fixture.work);
    git(["push", "--quiet", "upstream", `refs/tags/${tag}`], fixture.work);
    const stub = await startStub({
      runsFor: () => [
        mainPreflight(fixture.commit),
        { ...tagRun(fixture.commit, "success"), prettyref: promoteTag },
      ],
      release: candidateRelease(true),
    });

    const result = await runRelease(["promote", "--yes"], fixture, stub.base);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("release:");
    expect(tagType(fixture.canonical, promoteTag)).toBe("tag");
    expect(tagCommit(fixture.canonical, promoteTag)).toBe(fixture.commit);
    expect(result.stdout).toContain(`Promoted ${tag}.`);
  });

  it("promotes a lightweight candidate tag at its commit", async () => {
    const fixture = createFixture();
    git(["tag", tag, fixture.commit], fixture.work);
    git(["push", "--quiet", "upstream", `refs/tags/${tag}`], fixture.work);
    const stub = await startStub({
      runsFor: () => [
        mainPreflight(fixture.commit),
        { ...tagRun(fixture.commit, "success"), prettyref: promoteTag },
      ],
      release: candidateRelease(true),
    });

    const result = await runRelease(["promote", "--yes"], fixture, stub.base);

    expect(result.code).toBe(0);
    expect(tagCommit(fixture.canonical, promoteTag)).toBe(fixture.commit);
  });

  it("refuses to promote an already published release", async () => {
    const fixture = createFixture();
    git(["tag", "-a", tag, fixture.commit, "-m", `NookBridge ${tag}`], fixture.work);
    git(["push", "--quiet", "upstream", `refs/tags/${tag}`], fixture.work);
    const stub = await startStub({
      runsFor: () => [mainPreflight(fixture.commit)],
      release: candidateRelease(false),
    });

    const result = await runRelease(["promote", "--yes"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not a prerelease candidate");
    expect(tagPresent(fixture.canonical, promoteTag)).toBe(false);
  });

  it("refuses to promote a candidate with an incomplete asset set", async () => {
    const fixture = createFixture();
    git(["tag", "-a", tag, fixture.commit, "-m", `NookBridge ${tag}`], fixture.work);
    git(["push", "--quiet", "upstream", `refs/tags/${tag}`], fixture.work);
    const incomplete = candidateRelease(true);
    incomplete.assets = [{ name: "install.sh" }];
    const stub = await startStub({
      runsFor: () => [mainPreflight(fixture.commit)],
      release: incomplete,
    });

    const result = await runRelease(["promote", "--yes"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("missing release assets");
    expect(tagPresent(fixture.canonical, promoteTag)).toBe(false);
  });
});
