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

function candidateRelease(commit: string, prerelease = true): Record<string, unknown> {
  return {
    tag_name: tag,
    prerelease,
    target_commitish: commit,
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

function releaseEnv(
  base: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.NOOKBRIDGE_RELEASE_TEST_MODE = "1";
  env.NOOKBRIDGE_CANONICAL_REMOTE = "upstream";
  env.NOOKBRIDGE_FORGEJO_API_BASE = base;
  env.NOOKBRIDGE_GITHUB_API_BASE = base;
  env.NOOKBRIDGE_GITHUB_REPOSITORY = "monty033/NookBridge";
  env.NOOKBRIDGE_WATCH_INTERVAL = "1";
  env.NOOKBRIDGE_WATCH_TIMEOUT = "20";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

const realGit = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/**
 * Put a git wrapper first on PATH that fails a specific subcommand. The release
 * command must survive a transport failure, and a wrapper is the only way to
 * provoke one deterministically from a fixture.
 */
function gitShim(): string {
  const dir = mkdtempSync(join(tmpdir(), "nookbridge-git-shim-"));
  fixtureRoots.push(dir);
  const script = [
    "#!/usr/bin/env bash",
    `real_git=${JSON.stringify(realGit)}`,
    'if [ "${1:-}" = "ls-remote" ] && [ -n "${NOOKBRIDGE_SHIM_FAIL_LS_REMOTE:-}" ]; then',
    '  printf "fatal: unable to access the remote repository\\n" >&2',
    "  exit 128",
    "fi",
    'if [ "${1:-}" = "push" ] && [ -n "${NOOKBRIDGE_SHIM_PUSH_AMBIGUOUS:-}" ]; then',
    '  "$real_git" "$@" || exit $?',
    '  printf "fatal: the remote end hung up unexpectedly\\n" >&2',
    "  exit 128",
    "fi",
    'exec "$real_git" "$@"',
    "",
  ].join("\n");
  writeFileSync(join(dir, "git"), script, { mode: 0o755 });
  return dir;
}

async function runRelease(
  args: readonly string[],
  fixture: Fixture,
  base: string,
  overrides: Record<string, string | undefined> = {},
  pathPrefix?: string,
) {
  const env = releaseEnv(base, overrides);
  if (pathPrefix !== undefined) env.PATH = `${pathPrefix}:${env.PATH ?? ""}`;
  try {
    const result = await execFileAsync("bash", [releaseScript, ...args], {
      cwd: fixture.work,
      env,
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
      release: candidateRelease(fixture.commit),
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
      release: candidateRelease(fixture.commit),
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
      release: candidateRelease(fixture.commit),
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
      release: candidateRelease(fixture.commit, false),
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
    const incomplete = candidateRelease(fixture.commit);
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

  it("refuses a remote whose host is not the canonical host", async () => {
    const fixture = createFixture();
    git(
      ["remote", "add", "lookalike", "https://attacker.invalid/patrick/NookBridge.git"],
      fixture.work,
    );
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(["tag", "--yes", "--no-watch"], fixture, stub.base, {
      NOOKBRIDGE_CANONICAL_REMOTE: "lookalike",
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("does not fetch from");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
  });

  it("refuses a canonical remote whose push URL points somewhere else", async () => {
    const fixture = createFixture();
    git(
      [
        "remote",
        "set-url",
        "--push",
        "upstream",
        "https://attacker.invalid/patrick/NookBridge.git",
      ],
      fixture.work,
    );
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(["tag", "--yes", "--no-watch"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("does not push to");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
  });

  it("refuses the fixture overrides unless test mode is enabled", async () => {
    const fixture = createFixture();
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(["status"], fixture, stub.base, {
      NOOKBRIDGE_RELEASE_TEST_MODE: undefined,
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("NOOKBRIDGE_RELEASE_TEST_MODE");
  });

  it("refuses a non-numeric watch setting before publishing", async () => {
    const fixture = createFixture();
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(["tag", "--yes"], fixture, stub.base, {
      NOOKBRIDGE_WATCH_INTERVAL: "soon",
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("NOOKBRIDGE_WATCH_INTERVAL");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
  });

  it("rejects a positional version for the tag command", async () => {
    const fixture = createFixture();
    const stub = await startStub({ runsFor: () => [] });

    const result = await runRelease(["tag", "0.1.1", "--yes", "--no-watch"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("does not take an argument");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
  });

  it("treats a failed remote tag lookup as an error, not as an absent tag", async () => {
    const fixture = createFixture();
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(
      ["tag", "--yes", "--no-watch"],
      fixture,
      stub.base,
      { NOOKBRIDGE_SHIM_FAIL_LS_REMOTE: "1" },
      gitShim(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("cannot check tag");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
  });

  it("reports an uncertain push instead of claiming nothing was published", async () => {
    const fixture = createFixture();
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(
      ["tag", "--yes", "--no-watch"],
      fixture,
      stub.base,
      { NOOKBRIDGE_SHIM_PUSH_AMBIGUOUS: "1" },
      gitShim(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("may already be running");
    expect(result.stderr).not.toContain("nothing was published");
    // The tag really did land, and the command must not have deleted its local copy.
    expect(tagPresent(fixture.canonical, tag)).toBe(true);
    expect(tagPresent(fixture.work, tag)).toBe(true);
  });

  it("refuses to promote a candidate whose release targets another commit", async () => {
    const fixture = createFixture();
    git(["tag", "-a", tag, fixture.commit, "-m", `NookBridge ${tag}`], fixture.work);
    git(["push", "--quiet", "upstream", `refs/tags/${tag}`], fixture.work);
    const stub = await startStub({
      runsFor: () => [mainPreflight(fixture.commit)],
      release: candidateRelease("a".repeat(40)),
    });

    const result = await runRelease(["promote", "--yes"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("targets");
    expect(tagPresent(fixture.canonical, promoteTag)).toBe(false);
  });
});
