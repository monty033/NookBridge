/* global fetch */

import { pathToFileURL } from "node:url";

import { findRun } from "./release-api.mjs";

const WORKFLOW_ID = "linux-artifact.yml";

/**
 * The release gate: a tagged commit may only publish if that same commit
 * already completed a successful `main` push run of the artifact workflow.
 *
 * Matching is exact — workflow, event, ref, and commit — because the tag push
 * shares its commit with the `main` preflight, so a looser match would accept
 * the wrong run as evidence. Pagination and the matching rule live in
 * `release-api.mjs` so the operator command and this CI gate cannot drift apart.
 *
 * A missing token is a configuration failure, not a reason to skip the check:
 * the gate fails closed rather than publishing without preflight evidence.
 */
export async function requireSuccessfulMainPreflight({
  runsUrl,
  commitSha,
  token,
  fetchImpl = fetch,
}) {
  if (!runsUrl || !commitSha || !token) {
    throw new Error("Forgejo preflight gate is missing required configuration");
  }

  const match = await findRun({
    runsUrl,
    expected: {
      workflowId: WORKFLOW_ID,
      event: "push",
      ref: "main",
      commitSha,
      status: "success",
    },
    token,
    fetchImpl,
  });
  if (match === undefined) {
    throw new Error("successful main runner preflight missing for tagged commit");
  }
}

// `import.meta.url` percent-encodes the path while `process.argv[1]` does not, so
// comparing them directly would silently skip the gate in a checkout whose path
// contains a space — a no-op that exits 0, which reads as a passing check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await requireSuccessfulMainPreflight({
      runsUrl: process.env.PREFLIGHT_RUNS_URL,
      commitSha: process.env.GITHUB_SHA,
      token: process.env.PREFLIGHT_READ_TOKEN,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Forgejo preflight gate failed");
    process.exitCode = 1;
  }
}
