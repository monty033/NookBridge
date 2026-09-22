/* global fetch, URL */

const PAGE_SIZE = 100;
const WORKFLOW_ID = "linux-artifact.yml";

function runEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.workflow_runs)) return payload.workflow_runs;
  if (Array.isArray(payload?.runs)) return payload.runs;
  return [];
}

export function isSuccessfulMainPreflight(runs, commitSha) {
  return runs.some(
    (run) =>
      run?.workflow_id === WORKFLOW_ID &&
      run?.event === "push" &&
      run?.prettyref === "main" &&
      run?.commit_sha === commitSha &&
      run?.status === "success",
  );
}

export async function requireSuccessfulMainPreflight({
  runsUrl,
  commitSha,
  token,
  fetchImpl = fetch,
}) {
  if (!runsUrl || !commitSha || !token) {
    throw new Error("Forgejo preflight gate is missing required configuration");
  }

  for (let page = 1; page <= 1000; page += 1) {
    const url = new URL(runsUrl);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Forgejo preflight API returned HTTP ${response.status}`);
    }
    const entries = runEntries(await response.json());
    if (isSuccessfulMainPreflight(entries, commitSha)) return;
    if (entries.length < PAGE_SIZE) break;
  }

  throw new Error("successful main runner preflight missing for tagged commit");
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
