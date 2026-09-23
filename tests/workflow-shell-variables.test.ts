import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * A workflow step runs in a fresh shell, so a variable that is not set inside the
 * step, not passed through `env`, and not provided by the runner is a failure under
 * `set -u`. Renaming a variable in one place while another place still reads the old
 * name is exactly how a release step stops working, so this checks every step rather
 * than trusting a spot check of the ones a test happens to name.
 */
const PROVIDED = new Set([
  "BASH_SOURCE",
  "CI",
  "HOME",
  "HOSTNAME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PWD",
  "RANDOM",
  "SHELL",
  "TMPDIR",
  "USER",
  "GITHUB_ACTIONS",
  "GITHUB_ENV",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_REPOSITORY",
  "GITHUB_SERVER_URL",
  "GITHUB_SHA",
  "GITHUB_TOKEN",
  "GITHUB_WORKSPACE",
  "RUNNER_ARCH",
  "RUNNER_OS",
  "RUNNER_TEMP",
  "NODE_VERSION",
]);

type Step = { name?: string; env?: Record<string, string>; run?: string };
type Job = { env?: Record<string, string>; steps?: Step[] };

/**
 * A quoted heredoc is not expanded by the shell, so identifiers inside one belong to
 * whatever language the heredoc carries, not to the step's shell.
 */
function withoutQuotedHeredocs(script: string): string {
  const kept: string[] = [];
  let terminator: string | undefined;
  for (const line of script.split("\n")) {
    if (terminator !== undefined) {
      if (line.trim() === terminator) terminator = undefined;
      continue;
    }
    const opener = /<<-?'([A-Za-z_][A-Za-z0-9_]*)'/.exec(line);
    kept.push(line);
    if (opener?.[1] !== undefined) terminator = opener[1];
  }
  return kept.join("\n");
}

function definedNames(script: string): Set<string> {
  const names = new Set<string>();
  for (const match of script.matchAll(/(?:^|[^A-Za-z0-9_"'])([A-Za-z_][A-Za-z0-9_]*)=/g)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  for (const match of script.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  for (const match of script.matchAll(/\bread\b[^\n]*?\s([A-Za-z_][A-Za-z0-9_]*)\s*$/gm)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return names;
}

function referencedNames(script: string): Set<string> {
  const names = new Set<string>();
  for (const match of script.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return names;
}

describe("workflow shell variables", () => {
  it("only references variables each step defines, receives, or is given", () => {
    const raw = readFileSync(".forgejo/workflows/linux-artifact.yml", "utf8");
    const workflow = parseYaml(raw) as {
      env?: Record<string, string>;
      jobs: Record<string, Job>;
    };
    const workflowEnv = new Set(Object.keys(workflow.env ?? {}));
    const undefinedReferences: string[] = [];

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const jobEnv = new Set([...workflowEnv, ...Object.keys(job.env ?? {})]);
      for (const step of job.steps ?? []) {
        const script = withoutQuotedHeredocs((step.run ?? "").replace(/\$\{\{[^}]*\}\}/g, ""));
        const available = new Set([
          ...jobEnv,
          ...Object.keys(step.env ?? {}),
          ...definedNames(script),
        ]);
        for (const name of referencedNames(script)) {
          if (PROVIDED.has(name) || available.has(name)) continue;
          undefinedReferences.push(`${jobName} / ${step.name ?? "(unnamed step)"}: $${name}`);
        }
      }
    }

    expect([...undefinedReferences].sort()).toStrictEqual([]);
  });
});
