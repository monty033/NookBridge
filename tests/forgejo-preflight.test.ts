/* global process, URL */

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const checker = resolve(process.cwd(), "scripts/check-forgejo-preflight.mjs");
const commitSha = "f".repeat(40);

async function runChecker(
  pages: Record<string, unknown>,
  requests: string[],
  options: { token?: string; status?: number } = {},
) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${url.searchParams.get("page")}:${request.headers.authorization ?? ""}`);
    response.setHeader("content-type", "application/json");
    if (options.status !== undefined && options.status !== 200) {
      response.statusCode = options.status;
      response.end(JSON.stringify({ message: "forbidden" }));
      return;
    }
    response.end(JSON.stringify(pages[url.searchParams.get("page") ?? "1"] ?? []));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");

  // The token is absent by default, matching how the workflow invokes the gate: if
  // the harness always supplied one, the gate could start requiring a token the
  // workflow no longer sets and every tag release would fail before publishing.
  const env: Record<string, string | undefined> = {
    ...process.env,
    GITHUB_SHA: commitSha,
    PREFLIGHT_RUNS_URL: `http://127.0.0.1:${address.port}/runs`,
  };
  delete env.PREFLIGHT_READ_TOKEN;
  if (options.token !== undefined) env.PREFLIGHT_READ_TOKEN = options.token;

  try {
    return await execFileAsync(process.execPath, [checker], { env, maxBuffer: 1024 * 1024 });
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  }
}

describe("Forgejo main runner preflight gate", () => {
  it("paginates and accepts only the exact successful main workflow run", async () => {
    const requests: string[] = [];
    const stalePage = Array.from({ length: 50 }, (_, index) => ({
      workflow_id: "linux-artifact.yml",
      event: "push",
      prettyref: `runner-test/${index}`,
      commit_sha: commitSha,
      status: "success",
    }));
    const result = await runChecker(
      {
        "1": stalePage,
        "2": [
          {
            workflow_id: "linux-artifact.yml",
            event: "push",
            prettyref: "main",
            commit_sha: commitSha,
            status: "success",
          },
        ],
      },
      requests,
    );

    expect(result.stderr).toBe("");
    // No Authorization header: the gate reads a public repository's runs API
    // anonymously, so no secret is handed to the tagged revision's script.
    expect(requests).toEqual(["1:", "2:"]);
  });

  it("accepts the Forgejo workflow_runs envelope", async () => {
    const requests: string[] = [];
    await runChecker(
      {
        "1": {
          workflow_runs: [
            {
              workflow_id: "linux-artifact.yml",
              event: "push",
              prettyref: "main",
              commit_sha: commitSha,
              status: "success",
            },
          ],
        },
      },
      requests,
    );

    expect(requests).toEqual(["1:"]);
  });

  it("fails closed for a wrong workflow, ref, event, or commit", async () => {
    const requests: string[] = [];
    await expect(
      runChecker(
        {
          "1": [
            {
              workflow_id: "linux-artifact.yml",
              event: "push",
              prettyref: "main",
              commit_sha: commitSha,
              status: "failure",
            },
          ],
        },
        requests,
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("successful main runner preflight missing"),
    });
  });

  it("still sends a token when one is configured for a private runs API", async () => {
    const requests: string[] = [];
    await runChecker(
      {
        "1": [
          {
            workflow_id: "linux-artifact.yml",
            event: "push",
            prettyref: "main",
            commit_sha: commitSha,
            status: "success",
          },
        ],
      },
      requests,
      { token: "test-read-token" },
    );

    expect(requests).toEqual(["1:Bearer test-read-token"]);
  });

  it("fails closed when the runs API refuses the read", async () => {
    const requests: string[] = [];
    // A refused read must not look like "no matching run": the difference decides
    // whether a blocked release is reported as a missing preflight.
    await expect(runChecker({}, requests, { status: 403 })).rejects.toMatchObject({
      stderr: expect.stringContaining("HTTP 403"),
    });
  });
});
