/* global process, URL */

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function createFixture(
  options: { installerVersion?: string; lockVersion?: string; packageVersion?: string } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "nookbridge-release-"));
  fixtureRoots.push(root);
  const canonical = join(root, "canonical.git");
  const work = join(root, "work");
  git(["init", "--bare", "--initial-branch=main", canonical], root);
  git(["init", "--initial-branch=main", work], root);
  git(["config", "user.email", "release-test@example.invalid"], work);
  git(["config", "user.name", "Release Test"], work);
  mkdirSync(join(work, "scripts"), { recursive: true });
  writeFileSync(
    join(work, "package.json"),
    `${JSON.stringify({ name: "nookbridge", version: options.packageVersion ?? version })}\n`,
  );
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
  readonly releaseStatus?: number;
  readonly releaseRedirect?: string;
  readonly fullPages?: boolean;
  readonly runsPayload?: unknown;
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
      if (options.runsPayload !== undefined) {
        response.end(JSON.stringify(options.runsPayload));
        return;
      }
      const runs =
        options.fullPages === true || page === 1 ? (options.runsFor?.(runRequests) ?? []) : [];
      response.end(JSON.stringify({ workflow_runs: runs }));
      return;
    }
    if (url.pathname.endsWith("/redirected-release")) {
      response.end(JSON.stringify(options.release ?? {}));
      return;
    }
    if (url.pathname.includes("/releases/tags/")) {
      if (options.releaseRedirect !== undefined) {
        // Redirect to a reachable endpoint that answers 200, so following the
        // redirect would actually satisfy the caller.
        response.statusCode = 302;
        response.setHeader("location", `http://${request.headers.host}/redirected-release`);
        response.end(JSON.stringify({ message: "moved" }));
        return;
      }
      if (options.releaseStatus !== undefined && options.releaseStatus !== 200) {
        response.statusCode = options.releaseStatus;
        response.end(JSON.stringify({ message: "release unavailable" }));
        return;
      }
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
    // A push that fails without publishing anything.
    'if [ "${1:-}" = "push" ] && [ -n "${NOOKBRIDGE_SHIM_PUSH_FAILS:-}" ]; then',
    '  printf "fatal: unable to access the remote repository\\n" >&2',
    "  exit 128",
    "fi",
    'if [ "${1:-}" = "push" ] && [ -n "${NOOKBRIDGE_SHIM_PUSH_AMBIGUOUS:-}" ]; then',
    '  "$real_git" "$@" || exit $?',
    '  printf "fatal: the remote end hung up unexpectedly\\n" >&2',
    "  exit 128",
    "fi",
    // Repoint the remote's push URL immediately before the real push runs, so a
    // configuration change racing the push is observable in the fixture.
    'if [ "${1:-}" = "push" ] && [ -n "${NOOKBRIDGE_SHIM_REPOINT_PUSH:-}" ]; then',
    '  "$real_git" remote set-url --push upstream "$NOOKBRIDGE_SHIM_REPOINT_PUSH" >/dev/null 2>&1 || true',
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

/**
 * Source the real script with its entry point removed so a guard function can be
 * called directly. Going through the CLI would only ever report the first remote
 * that failed, which cannot show that a specific URL form is what was rejected.
 */
function releaseFunctionsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "nookbridge-release-fn-"));
  fixtureRoots.push(dir);
  const source = readFileSync(releaseScript, "utf8").replace(/^main "\$@"\n?$/m, "");
  const target = join(dir, "release-functions.sh");
  writeFileSync(target, source);
  return target;
}

function guardAccepts(guard: string, values: readonly string[]): boolean[] {
  const script = [
    `source ${JSON.stringify(releaseFunctionsPath())}`,
    ...values.map(
      (value, index) =>
        `${guard} ${JSON.stringify(value)} && printf '${index}:accepted\\n' || printf '${index}:refused\\n'`,
    ),
  ].join("\n");
  const output = execFileSync("bash", ["-c", script], { encoding: "utf8" });
  return values.map((_, index) => output.includes(`${index}:accepted`));
}

async function runReleaseApi(args: readonly string[], env: Record<string, string>) {
  try {
    const result = await execFileAsync(
      "node",
      [resolve(process.cwd(), "scripts", "release-api.mjs"), ...args],
      {
        env: { ...process.env, ...env },
        maxBuffer: 1024 * 1024,
      },
    );
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

/** Run without any fixture override, so the real trust boundary is in force. */
function withoutFixtures(): Record<string, string | undefined> {
  return {
    NOOKBRIDGE_RELEASE_TEST_MODE: undefined,
    NOOKBRIDGE_CANONICAL_REMOTE: undefined,
    NOOKBRIDGE_FORGEJO_API_BASE: undefined,
    NOOKBRIDGE_GITHUB_API_BASE: undefined,
    NOOKBRIDGE_GITHUB_REPOSITORY: undefined,
  };
}

function createAttackerRepository(fixture: Fixture): string {
  const attacker = join(fixture.root, "attacker.git");
  git(["init", "--bare", "--initial-branch=main", attacker], fixture.root);
  return attacker;
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

  it("accepts only the exact canonical repository identity", () => {
    const accepted = [
      "https://git.montycasa.net/patrick/NookBridge.git",
      "https://git.montycasa.net/patrick/NookBridge",
      "https://git.montycasa.net/patrick/NookBridge/",
      "ssh://git@git.montycasa.net/patrick/NookBridge.git",
      "git@git.montycasa.net:patrick/NookBridge.git",
    ];
    const refused = [
      // A non-default port selects a different service.
      "https://git.montycasa.net:8443/patrick/NookBridge.git",
      // A lookalike host that mirrors the repository path.
      "https://git.montycasa.net.attacker.invalid/patrick/NookBridge.git",
      "https://attacker.invalid/patrick/NookBridge.git",
      // A different repository or a path that only extends the real one.
      "https://git.montycasa.net/patrick/NookBridge-extra.git",
      "https://git.montycasa.net/openclaw/NookBridge.git",
      "https://user:pw@attacker.invalid/patrick/NookBridge.git",
      "https://git.elsewhere.invalid:443/patrick/NookBridge.git",
      // A `.git` path segment is a different endpoint, not the same repository.
      "https://git.montycasa.net/patrick/NookBridge/.git",
      "https://git.montycasa.net/patrick/NookBridge/.git/",
      "https://git.montycasa.net/patrick/NookBridge.git/.git",
      // A principal other than the hosting account may select another
      // destination on the same host.
      "ssh://root@git.montycasa.net/patrick/NookBridge.git",
      "ssh://someone:else@git.montycasa.net/patrick/NookBridge.git",
      "root@git.montycasa.net:patrick/NookBridge.git",
      "/tmp/canonical.git",
      "attacker.example:patrick/NookBridge.git",
    ];

    expect(guardAccepts("canonical_url_ok", [...accepted, ...refused])).toStrictEqual([
      ...accepted.map(() => true),
      ...refused.map(() => false),
    ]);
  });

  it("treats only a filesystem path as a local test remote", () => {
    const accepted = [
      "/tmp/canonical.git",
      "./canonical.git",
      "../canonical.git",
      "~/canonical.git",
    ];
    const refused = [
      "https://git.montycasa.net/patrick/NookBridge.git",
      "git@git.montycasa.net:patrick/NookBridge.git",
      // A scp-style destination without a user is still a network destination.
      "attacker.example:repo",
      "attacker.example:patrick/NookBridge.git",
      "plain-relative.git",
    ];

    expect(guardAccepts("local_path_url", [...accepted, ...refused])).toStrictEqual([
      ...accepted.map(() => true),
      ...refused.map(() => false),
    ]);
  });

  it("refuses a remote that also pushes to a second destination", async () => {
    const fixture = createFixture();
    const canonicalUrl = "https://git.montycasa.net/patrick/NookBridge.git";
    git(["remote", "set-url", "upstream", canonicalUrl], fixture.work);
    git(["remote", "set-url", "--push", "upstream", canonicalUrl], fixture.work);
    git(
      [
        "remote",
        "set-url",
        "--add",
        "--push",
        "upstream",
        "https://attacker.invalid/patrick/NookBridge.git",
      ],
      fixture.work,
    );
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    // No fixture override: the real trust boundary is in force. Nothing reaches
    // the network, because the push URL is validated before the fetch.
    const result = await runRelease(
      ["tag", "--yes", "--no-watch"],
      fixture,
      stub.base,
      withoutFixtures(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("does not push to");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
    expect(stub.requests).toStrictEqual([]);
  });

  it("refuses a canonical-host remote that names an explicit port", async () => {
    const fixture = createFixture();
    git(
      ["remote", "set-url", "upstream", "https://git.montycasa.net:8443/patrick/NookBridge.git"],
      fixture.work,
    );
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(
      ["tag", "--yes", "--no-watch"],
      fixture,
      stub.base,
      withoutFixtures(),
    );

    // No remote qualifies, so the command fails closed before touching the API.
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no remote fetches from and pushes to");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
    expect(stub.requests).toStrictEqual([]);
  });

  it("pushes to the validated destination when the remote is repointed mid-run", async () => {
    const fixture = createFixture();
    const attacker = createAttackerRepository(fixture);
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(
      ["tag", "--yes", "--no-watch"],
      fixture,
      stub.base,
      { NOOKBRIDGE_SHIM_REPOINT_PUSH: attacker },
      gitShim(),
    );

    expect(result.code).toBe(0);
    // Rewriting the push URL after validation must not redirect the release.
    expect(tagPresent(fixture.canonical, tag)).toBe(true);
    expect(tagPresent(attacker, tag)).toBe(false);
  });

  it("refuses a test-mode remote that is a network destination", async () => {
    const fixture = createFixture();
    git(["remote", "set-url", "upstream", "attacker.example:patrick/NookBridge.git"], fixture.work);
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(["tag", "--yes", "--no-watch"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("does not fetch from");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
  });

  it("does not print credentials from a rejected remote URL", async () => {
    const fixture = createFixture();
    git(
      [
        "remote",
        "set-url",
        "upstream",
        "https://release-bot:sup3rsecret@attacker.invalid/patrick/NookBridge.git",
      ],
      fixture.work,
    );
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(["tag", "--yes", "--no-watch"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("does not fetch from");
    expect(result.stderr).not.toContain("sup3rsecret");
    expect(result.stdout).not.toContain("sup3rsecret");
  });

  it("refuses a redirect from the release API", async () => {
    const fixture = createFixture();
    const stub = await startStub({
      runsFor: () => [mainPreflight(fixture.commit), tagRun(fixture.commit, "success")],
      // The redirect target answers with a complete, valid candidate, so a
      // client that followed redirects would accept it.
      release: candidateRelease(fixture.commit),
      releaseRedirect: "self",
    });

    const result = await runRelease(["tag", "--yes"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("could not be read");
    expect(result.stdout).not.toContain("Candidate");
  });

  it("fails when the mirror release cannot be read after a successful run", async () => {
    const fixture = createFixture();
    const stub = await startStub({
      runsFor: () => [mainPreflight(fixture.commit), tagRun(fixture.commit, "success")],
      releaseStatus: 500,
    });

    const result = await runRelease(["tag", "--yes"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("verify");
    // The tag did publish; the failure is about the unverified candidate.
    expect(tagPresent(fixture.canonical, tag)).toBe(true);
  });

  it("is not fooled by forged asset names in the release response", async () => {
    const fixture = createFixture();
    git(["tag", "-a", tag, fixture.commit, "-m", `NookBridge ${tag}`], fixture.work);
    git(["push", "--quiet", "upstream", `refs/tags/${tag}`], fixture.work);
    // Every expected asset name is reachable only by splitting a single name on
    // its embedded newlines.
    const forged = [
      "install.sh",
      "install-systemd.sh",
      "verify-linux-artifact.sh",
      "SHA256SUMS",
      artifactName,
    ].join("\n");
    const stub = await startStub({
      runsFor: () => [mainPreflight(fixture.commit)],
      release: {
        tag_name: tag,
        prerelease: true,
        target_commitish: fixture.commit,
        assets: [{ name: forged }],
      },
    });

    const result = await runRelease(["promote", "--yes"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("missing release assets");
    expect(tagPresent(fixture.canonical, promoteTag)).toBe(false);
  });

  it("does not let a forged newline in a run field become a matched status", async () => {
    const commit = "b".repeat(40);
    const stub = await startStub({
      runsFor: () => [
        {
          workflow_id: "linux-artifact.yml",
          event: "push",
          prettyref: tag,
          commit_sha: commit,
          status: "running",
          html_url: "https://forgejo.example.invalid/actions/runs/1\nstatus=success",
        },
      ],
    });

    const result = await runReleaseApi(["find-run"], {
      RUNS_URL: `${stub.base}/actions/runs`,
      EXPECT_WORKFLOW: "linux-artifact.yml",
      EXPECT_EVENT: "push",
      EXPECT_REF: tag,
      EXPECT_COMMIT: commit,
      EXPECT_STATUS: "",
    });

    const lines = result.stdout.split("\n");
    expect(lines).toContain("status=running");
    expect(lines).not.toContain("status=success");
  });

  it("refuses a remote whose destination is rewritten by a Git URL rule", async () => {
    const fixture = createFixture();
    const attacker = createAttackerRepository(fixture);
    // The configured value is the canonical path, but git expands the rewrite
    // whenever the URL is reported, so the reported URL differs from the one the
    // configuration actually holds.
    git(["config", `url.${attacker}.insteadOf`, fixture.canonical], fixture.work);
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(["tag", "--yes", "--no-watch"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("rewrite rule");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
    expect(tagPresent(attacker, tag)).toBe(false);
  });

  it("does not print a credential carried in a remote URL query string", async () => {
    const fixture = createFixture();
    git(
      [
        "remote",
        "set-url",
        "upstream",
        "https://attacker.invalid/patrick/NookBridge.git?token=sup3rsecret",
      ],
      fixture.work,
    );
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(["tag", "--yes", "--no-watch"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("does not fetch from");
    expect(result.stderr).not.toContain("sup3rsecret");
    expect(result.stdout).not.toContain("sup3rsecret");
  });

  it("never sends a token while test mode is on", async () => {
    const fixture = createFixture();
    const stub = await startStub({
      runsFor: () => [mainPreflight(fixture.commit)],
      release: candidateRelease(fixture.commit),
    });

    const result = await runRelease(["status"], fixture, stub.base, {
      NOOKBRIDGE_API_TOKEN: "leak-me-please",
      NOOKBRIDGE_GITHUB_READ_TOKEN: "leak-me-too",
    });

    expect(result.code).toBe(0);
    expect(stub.requests.length).toBeGreaterThan(0);
    expect(stub.requests.join(",")).not.toContain("leak-me");
    expect(stub.requests.every((entry) => entry.endsWith("|anonymous"))).toBe(true);
  });

  it("refuses to report a mirror release that is no longer a candidate", async () => {
    const fixture = createFixture();
    const stub = await startStub({
      runsFor: () => [mainPreflight(fixture.commit), tagRun(fixture.commit, "success")],
      // Every asset name is present, but the release has already been published.
      release: candidateRelease(fixture.commit, false),
    });

    const result = await runRelease(["tag", "--yes"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not a prerelease candidate");
    expect(result.stdout).not.toContain("has all five assets");
  });

  it("refuses to report a mirror release that targets another commit", async () => {
    const fixture = createFixture();
    const stub = await startStub({
      runsFor: () => [mainPreflight(fixture.commit), tagRun(fixture.commit, "success")],
      release: candidateRelease("d".repeat(40)),
    });

    const result = await runRelease(["tag", "--yes"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("targets");
    expect(result.stdout).not.toContain("has all five assets");
  });

  it("reports page exhaustion as a failed lookup, not as an absent run", async () => {
    const fixture = createFixture();
    // Every page is full and matches nothing, so the paging budget is exhausted.
    const page = Array.from({ length: 50 }, () => ({
      workflow_id: "linux-artifact.yml",
      event: "push",
      prettyref: "runner-test/other",
      commit_sha: "c".repeat(40),
      status: "success",
    }));
    const stub = await startStub({ runsFor: () => page, fullPages: true });

    const result = await runRelease(["tag", "--yes", "--no-watch"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("cannot read Forgejo run state");
    expect(stub.requests.length).toBeGreaterThanOrEqual(1000);
  }, 60000);

  it("forwards Justfile arguments as positional parameters, not as command text", () => {
    // `just --dry-run` prints the command line it would run on stderr.
    const result = spawnSync("just", ["--dry-run", "release-promote", "0.1.2; printf INJECTED"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(output).toContain('"$@"');
    // The argument must never be interpolated into the shell line.
    expect(output).not.toContain("INJECTED");
    expect(readFileSync(resolve(process.cwd(), "Justfile"), "utf8")).toContain(
      "set positional-arguments",
    );
  });

  it("runs the release API command from a checkout path containing a space", async () => {
    const spaced = mkdtempSync(join(tmpdir(), "nookbridge space "));
    fixtureRoots.push(spaced);
    mkdirSync(join(spaced, "scripts"), { recursive: true });
    for (const name of ["release-api.mjs", "check-forgejo-preflight.mjs"]) {
      writeFileSync(
        join(spaced, "scripts", name),
        readFileSync(resolve(process.cwd(), "scripts", name), "utf8"),
      );
    }

    for (const name of ["release-api.mjs", "check-forgejo-preflight.mjs"]) {
      const result = spawnSync("node", [join(spaced, "scripts", name), "find-run"], {
        encoding: "utf8",
        env: { ...process.env, RUNS_URL: "", PREFLIGHT_RUNS_URL: "" },
      });
      // A missing entrypoint match would exit 0 with no output, which reads as a
      // passing gate instead of a failed one.
      expect(result.status).not.toBe(0);
      expect(result.stderr.trim().length).toBeGreaterThan(0);
    }
  });

  it("refuses a rewrite rule that matches only a later push destination", async () => {
    const fixture = createFixture();
    const attacker = createAttackerRepository(fixture);
    const canonicalUrl = "https://git.montycasa.net/patrick/NookBridge.git";
    git(["remote", "set-url", "upstream", canonicalUrl], fixture.work);
    git(["remote", "set-url", "--push", "upstream", canonicalUrl], fixture.work);
    git(
      [
        "remote",
        "set-url",
        "--add",
        "--push",
        "upstream",
        "ssh://git@git.montycasa.net/patrick/NookBridge.git",
      ],
      fixture.work,
    );
    // Only the second destination is rewritten.
    git(["config", `url.${attacker}.pushInsteadOf`, "ssh://git@git.montycasa.net/"], fixture.work);
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(
      ["tag", "--yes", "--no-watch"],
      fixture,
      stub.base,
      withoutFixtures(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("rewrite rule");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
    expect(tagPresent(attacker, tag)).toBe(false);
  });

  it("keeps the local tag when a failed push cannot be confirmed as unpublished", async () => {
    const fixture = createFixture();
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(
      ["tag", "--yes", "--no-watch"],
      fixture,
      stub.base,
      { NOOKBRIDGE_SHIM_PUSH_FAILS: "1" },
      gitShim(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("does not report the tag");
    // An empty lookup is not proof that nothing was published.
    expect(result.stderr).not.toContain("nothing was published");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
    expect(tagPresent(fixture.work, tag)).toBe(true);
  });

  it("refuses a version whose literal value carries whitespace", async () => {
    const fixture = createFixture({ packageVersion: "0.1.2\n" });
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)] });

    const result = await runRelease(["status"], fixture, stub.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("cannot read the version");
    expect(tagPresent(fixture.canonical, tag)).toBe(false);
  });

  it("treats an unrecognized API payload as a failed lookup, not as absence", async () => {
    const stub = await startStub({ runsPayload: { error: "temporary failure" } });

    const result = await runReleaseApi(["find-run"], {
      RUNS_URL: `${stub.base}/actions/runs`,
      EXPECT_WORKFLOW: "linux-artifact.yml",
      EXPECT_EVENT: "push",
      EXPECT_REF: "main",
      EXPECT_COMMIT: "a".repeat(40),
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unrecognized payload");
  });

  it("does not report readiness when a mirror release already exists", async () => {
    const fixture = createFixture();
    const stub = await startStub({
      runsFor: () => [mainPreflight(fixture.commit)],
      release: candidateRelease(fixture.commit),
    });

    const result = await runRelease(["status"], fixture, stub.base);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("mirror_release=candidate-prerelease");
    expect(result.stdout).toContain("release_ready=false");
  });

  it("does not report readiness when the promotion tag already exists", async () => {
    const fixture = createFixture();
    git(["tag", "-a", promoteTag, fixture.commit, "-m", `Promote ${tag}`], fixture.work);
    git(["push", "--quiet", "upstream", `refs/tags/${promoteTag}`], fixture.work);
    const stub = await startStub({ runsFor: () => [mainPreflight(fixture.commit)], release: null });

    const result = await runRelease(["status"], fixture, stub.base);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("release_ready=false");
  });
});
