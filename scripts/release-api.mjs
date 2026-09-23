/* global fetch, URL */

/**
 * Release-state queries shared by the tag-triggered release gate and the
 * operator release command.
 *
 * Both surfaces must answer the same question — "is there a run matching this
 * workflow, ref, event, and commit?" — so pagination and matching live here
 * rather than being reimplemented. Duplicated matching logic is how a gate
 * quietly stops checking what it claims to check.
 *
 * The command-line form prints `key=value` lines so a shell caller can read the
 * result without embedding a JSON parser. Exit status is part of the contract:
 * 0 means a match was found, 2 means the query succeeded but nothing matched,
 * and 1 means the query itself failed.
 */

export const PAGE_SIZE = 50;
const MAX_PAGES = 1000;

export function runEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.workflow_runs)) return payload.workflow_runs;
  if (Array.isArray(payload?.runs)) return payload.runs;
  return [];
}

/**
 * Match a Forgejo Actions run against the exact expected identity. Every
 * supplied field must agree; omitted fields are not constrained. The caller is
 * expected to supply enough fields to identify one run: for a release tag the
 * commit alone is ambiguous because the same commit also carries the `main`
 * preflight run.
 */
export function matchesRun(run, expected) {
  if (run === null || typeof run !== "object") return false;
  const { workflowId, event, ref, commitSha, status } = expected;
  if (workflowId !== undefined && run.workflow_id !== workflowId) return false;
  if (event !== undefined && run.event !== event) return false;
  if (ref !== undefined && run.prettyref !== ref) return false;
  if (commitSha !== undefined && run.commit_sha !== commitSha) return false;
  if (status !== undefined && run.status !== status) return false;
  return true;
}

function requestHeaders(token) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Find the first run matching the expected identity, paginating the Actions
 * API until the list is exhausted. Older runs matter: a valid preflight can sit
 * below the first page once enough runs accumulate.
 */
export async function findRun({ runsUrl, expected, token, fetchImpl = fetch }) {
  if (!runsUrl) throw new Error("Forgejo runs URL is missing");
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(runsUrl);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));
    const response = await fetchImpl(url, { headers: requestHeaders(token) });
    if (!response.ok) throw new Error(`Forgejo runs API returned HTTP ${response.status}`);
    const entries = runEntries(await response.json());
    const match = entries.find((run) => matchesRun(run, expected));
    if (match) return match;
    if (entries.length < PAGE_SIZE) return undefined;
  }
  return undefined;
}

/**
 * Read the public mirror's release state for a tag. A missing release is a
 * normal answer, not an error, so callers can distinguish "not published yet"
 * from "cannot reach the API".
 */
export async function releaseState({ apiBase, repository, tag, token, fetchImpl = fetch }) {
  if (!apiBase || !repository || !tag)
    throw new Error("GitHub release query is missing configuration");
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(`${apiBase}/repos/${repository}/releases/tags/${tag}`, {
    headers,
  });
  if (response.status === 404)
    return { exists: false, prerelease: false, targetCommitish: "", assets: [] };
  if (!response.ok) throw new Error(`GitHub releases API returned HTTP ${response.status}`);
  const release = await response.json();
  return {
    exists: true,
    prerelease: release?.prerelease === true,
    // The promotion workflow re-verifies the artifact against this commit, so
    // the caller must compare it with the canonical tag commit before pushing a
    // promotion ref that would otherwise be rejected after the fact.
    targetCommitish: String(release?.target_commitish ?? ""),
    assets: Array.isArray(release?.assets)
      ? release.assets.map((asset) => String(asset?.name ?? "")).filter(Boolean)
      : [],
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function printRun(run) {
  const fields = [
    ["status", run.status],
    ["workflow_id", run.workflow_id],
    ["event", run.event],
    ["ref", run.prettyref],
    ["commit_sha", run.commit_sha],
    ["index", run.index_in_repo ?? run.index],
    ["url", run.html_url],
  ];
  for (const [key, value] of fields) {
    if (value === undefined || value === null) continue;
    process.stdout.write(`${key}=${String(value)}\n`);
  }
}

async function main(argv) {
  const command = argv[0];
  if (command === "find-run") {
    const run = await findRun({
      runsUrl: requiredEnv("RUNS_URL"),
      expected: {
        workflowId: requiredEnv("EXPECT_WORKFLOW"),
        event: requiredEnv("EXPECT_EVENT"),
        ref: requiredEnv("EXPECT_REF"),
        commitSha: requiredEnv("EXPECT_COMMIT"),
        ...(process.env.EXPECT_STATUS ? { status: process.env.EXPECT_STATUS } : {}),
      },
      token: process.env.RUNS_TOKEN,
    });
    if (!run) {
      process.exitCode = 2;
      return;
    }
    printRun(run);
    return;
  }
  if (command === "release-state") {
    const state = await releaseState({
      apiBase: requiredEnv("GITHUB_API_BASE"),
      repository: requiredEnv("GITHUB_REPOSITORY"),
      tag: requiredEnv("RELEASE_TAG"),
      token: process.env.GITHUB_READ_TOKEN,
    });
    process.stdout.write(`exists=${state.exists}\n`);
    process.stdout.write(`prerelease=${state.prerelease}\n`);
    process.stdout.write(`target_commitish=${state.targetCommitish}\n`);
    for (const asset of state.assets) process.stdout.write(`asset=${asset}\n`);
    return;
  }
  throw new Error("unknown release API command");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "release API query failed");
    process.exitCode = 1;
  });
}
