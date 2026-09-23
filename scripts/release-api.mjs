/* global fetch, URL */

import { pathToFileURL } from "node:url";

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

const CONTROL_LIMIT = 32;
const DELETE_CHARACTER = 127;

/**
 * Remote strings are untrusted, and the command-line form emits them as
 * `key=value` lines that a shell caller parses. A newline inside a value would
 * forge additional fields — a fabricated `status=success`, or an asset name
 * that satisfies the release asset check — so control characters are collapsed
 * before anything is printed.
 */
export function sanitize(value, limit = 512) {
  let result = "";
  for (const character of String(value)) {
    if (result.length >= limit) break;
    const code = character.codePointAt(0) ?? 0;
    result += code < CONTROL_LIMIT || code === DELETE_CHARACTER ? " " : character;
  }
  return result;
}

export function runEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.workflow_runs)) return payload.workflow_runs;
  if (Array.isArray(payload?.runs)) return payload.runs;
  return [];
}

/**
 * A 200 response that carries no recognisable run list is an unreadable API, not
 * an empty history: treating `{"error": ...}` as "no runs" is how a proxy or
 * version mismatch becomes a missing-preflight report.
 */
export function assertRunPayload(payload) {
  if (
    Array.isArray(payload) ||
    Array.isArray(payload?.workflow_runs) ||
    Array.isArray(payload?.runs)
  ) {
    return;
  }
  throw new Error("Forgejo runs API returned an unrecognized payload");
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
    // Redirects are refused: a redirecting endpoint could hand back a result
    // for an identity this query never asked about.
    const response = await fetchImpl(url, {
      headers: requestHeaders(token),
      redirect: "manual",
    });
    if (!response.ok) throw new Error(`Forgejo runs API returned HTTP ${response.status}`);
    const payload = await response.json();
    assertRunPayload(payload);
    const entries = runEntries(payload);
    const match = entries.find((run) => matchesRun(run, expected));
    if (match) return match;
    if (entries.length < PAGE_SIZE) return undefined;
  }
  // Exhausting the page budget is a failed lookup, not evidence that no run
  // matches: reporting it as absence is how a blocked release is mistaken for a
  // missing preflight.
  throw new Error(`Forgejo runs API paging limit of ${MAX_PAGES} pages was reached`);
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
    redirect: "manual",
  });
  if (response.status === 404)
    return { exists: false, prerelease: false, draft: false, targetCommitish: "", assets: [] };
  if (!response.ok) throw new Error(`GitHub releases API returned HTTP ${response.status}`);
  const release = await response.json();
  return {
    exists: true,
    prerelease: release?.prerelease === true,
    // A draft release is invisible to the install path until it is published, so a
    // caller that treats "a release exists" as "the release is out" would announce
    // something users cannot download.
    draft: release?.draft === true,
    // The promotion workflow re-verifies the artifact against this commit, so
    // the caller must compare it with the canonical tag commit before pushing a
    // promotion ref that would otherwise be rejected after the fact.
    targetCommitish: sanitize(release?.target_commitish ?? "", 256),
    assets: Array.isArray(release?.assets)
      ? release.assets.map((asset) => sanitize(asset?.name ?? "", 256)).filter(Boolean)
      : [],
  };
}

/**
 * Read a tag ref from the canonical host. This exists because a push cannot be
 * verified by asking git: a rewrite rule in the local configuration can redirect
 * a `git push` even when it is given an explicit URL, and a rule added between
 * the last check and the push cannot be observed beforehand. An HTTPS request to
 * the host's own API is not redirected by local git configuration, so the host's
 * record of the tag is the only evidence that the tag is where it was meant to
 * go. A missing tag is a normal answer; an unreadable one is an error.
 */
export async function tagRefState({ apiBase, repository, tag, token, fetchImpl = fetch }) {
  if (!apiBase || !repository || !tag) throw new Error("tag ref query is missing configuration");
  const response = await fetchImpl(
    `${apiBase}/repos/${repository}/git/refs/tags/${encodeURIComponent(tag)}`,
    { headers: requestHeaders(token), redirect: "manual" },
  );
  if (response.status === 404) return { exists: false, sha: "" };
  if (!response.ok) throw new Error(`Forgejo refs API returned HTTP ${response.status}`);
  const payload = await response.json();
  const entries = Array.isArray(payload) ? payload : [payload];
  // The endpoint answers a prefix query, so the exact ref must be selected rather
  // than assumed: `v0.1.2` also matches `v0.1.20`.
  const wanted = `refs/tags/${tag}`;
  const match = entries.find((entry) => entry?.ref === wanted);
  if (!match) return { exists: false, sha: "" };
  return { exists: true, sha: sanitize(match?.object?.sha ?? "", 64) };
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
    process.stdout.write(`${key}=${sanitize(value)}\n`);
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
  if (command === "tag-ref") {
    const state = await tagRefState({
      apiBase: requiredEnv("FORGEJO_API_BASE"),
      repository: requiredEnv("FORGEJO_REPOSITORY"),
      tag: requiredEnv("RELEASE_TAG"),
      token: process.env.RUNS_TOKEN,
    });
    process.stdout.write(`exists=${state.exists}\n`);
    if (state.exists) process.stdout.write(`sha=${state.sha}\n`);
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
    process.stdout.write(`draft=${state.draft}\n`);
    process.stdout.write(`target_commitish=${state.targetCommitish}\n`);
    for (const asset of state.assets) process.stdout.write(`asset=${asset}\n`);
    return;
  }
  throw new Error("unknown release API command");
}

// `import.meta.url` percent-encodes the path while `process.argv[1]` does not, so
// comparing them directly would silently skip this command in a checkout whose
// path contains a space — a no-op that exits 0, which reads as success.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "release API query failed");
    process.exitCode = 1;
  });
}
