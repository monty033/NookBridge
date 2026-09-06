/** Stage 9 §13.11 — bounded operator-only `nookctl tree`. */

export const TREE_LIST_MAX_LIMIT = 100;
export const TREE_LIST_DEFAULT_LIMIT = 50;
const OPAQUE_MAX = 128;

const FORBIDDEN_ARG_FLAGS = [
  "--email",
  "--username",
  "--password",
  "--passwd",
  "--mfa",
  "--totp",
  "--secret",
  "--token",
  "--access-token",
  "--refresh-token",
  "--db-key",
  "--database-key",
  "--content",
  "--body",
  "--markdown",
  "--fragment",
  "--note",
  "--query",
  "--title",
  "--expect-revision",
  "--revision",
  "--path",
  "--file",
  "--content-file",
  "--root",
  "--entry",
  "--inode",
  "--device",
] as const;
const FORBIDDEN_ENV_VARS = [
  "NOOKBRIDGE_EMAIL",
  "NOOKBRIDGE_USERNAME",
  "NOOKBRIDGE_PASSWORD",
  "NOOKBRIDGE_PASSWD",
  "NOOKBRIDGE_MFA",
  "NOOKBRIDGE_TOTP",
  "NOOKBRIDGE_SECRET",
  "NOOKBRIDGE_TOKEN",
  "NOOKBRIDGE_ACCESS_TOKEN",
  "NOOKBRIDGE_REFRESH_TOKEN",
  "NOOKCTL_EMAIL",
  "NOOKCTL_USERNAME",
  "NOOKCTL_PASSWORD",
  "NOOKCTL_MFA",
  "NOOKCTL_TOKEN",
  "NOOKBRIDGE_QUERY",
  "NOOKBRIDGE_BODY",
  "NOOKBRIDGE_CONTENT",
  "NOOKBRIDGE_TITLE",
  "NOOKBRIDGE_PATH",
  "NOOKBRIDGE_REVISION",
] as const;

const HANDLE_PATTERN = /^(?:st|qrn|qre)_[A-Za-z0-9_-]{4,124}$/;
const CURSOR_PATTERN = /^crs_[A-Za-z0-9_-]{4,124}$/;

export type ParsedTreeCommand =
  | Readonly<{ kind: "help"; subcommand: "help" }>
  | Readonly<{ kind: "list"; subcommand: "list"; handle?: string; cursor?: string; limit: number }>;

export type ParseTreeCommandResult =
  | Readonly<{ kind: "parsed"; command: ParsedTreeCommand }>
  | Readonly<{ kind: "error"; message: string; exitCode: 2 }>;

export type TreeEntryKind = "state-root" | "quarantine-root" | "quarantine-entry" | "protected";
export type TreeEntry = Readonly<{
  handle: string | null;
  kind: TreeEntryKind;
  label: "state-root" | "quarantine-root" | "quarantine-entry" | "protected";
  mode: "directory" | "file" | "unknown";
  owner: "owner" | "other" | "unknown";
  sizeClass: "bounded" | "unknown";
  childCount: number | "unknown" | "n/a";
}>;

export type TreeResult =
  | Readonly<{ kind: "help"; text: string }>
  | Readonly<{ kind: "page"; entries: readonly TreeEntry[]; next: string | null }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "denied" | "invalid-input" | "locked" | "missing" }>
  | Readonly<{ kind: "error"; exitCode: 2 | 3 }>;

export type TreeListOptions = Readonly<{
  stateDir: string;
  handle?: string;
  cursor?: string;
  limit: number;
}>;

export interface TreeCommandRuntime {
  readonly list: (options: TreeListOptions) => Promise<TreeResult>;
}
export type TreeRuntimeFactory = (
  stateDir: string,
) => TreeCommandRuntime | Promise<TreeCommandRuntime>;

export type RunTreeCommandOptions = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  stateDir: string;
  createRuntime: TreeRuntimeFactory;
}>;

function opaque(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && value.length <= OPAQUE_MAX && pattern.test(value);
}
export function isTreeHandle(value: unknown): value is string {
  return opaque(value, HANDLE_PATTERN);
}
export function isTreeCursor(value: unknown): value is string {
  return opaque(value, CURSOR_PATTERN);
}

export function parseTreeCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParseTreeCommandResult {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) return invalid();
  if (typeof env !== "object" || env === null || Array.isArray(env)) return invalid();
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (value !== undefined && typeof value !== "string") return invalid();
  }
  for (const name of FORBIDDEN_ENV_VARS) {
    if (name in env)
      return { kind: "error", exitCode: 2, message: "nookctl tree: invalid command input" };
  }
  for (const arg of argv) {
    if (FORBIDDEN_ARG_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      return { kind: "error", exitCode: 2, message: "nookctl tree: invalid command input" };
    }
    if (arg.startsWith("--handle=") || arg.startsWith("--cursor=") || arg.startsWith("--limit=")) {
      return { kind: "error", exitCode: 2, message: "nookctl tree: invalid command input" };
    }
  }
  const [subcommand = "help", ...rest] = argv;
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return rest.length === 0
      ? { kind: "parsed", command: { kind: "help", subcommand: "help" } }
      : invalid();
  }
  if (subcommand !== "list") return invalid();
  let handle: string | undefined;
  let cursor: string | undefined;
  let limit = TREE_LIST_DEFAULT_LIMIT;
  let limitSeen = false;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === "--handle") {
      if (handle !== undefined || value === undefined || !isTreeHandle(value)) return invalid();
      handle = value;
      i += 1;
    } else if (flag === "--cursor") {
      if (
        handle === undefined ||
        cursor !== undefined ||
        value === undefined ||
        !isTreeCursor(value)
      )
        return invalid();
      cursor = value;
      i += 1;
    } else if (flag === "--limit") {
      if (limitSeen || value === undefined || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value))
        return invalid();
      limitSeen = true;
      limit = Number(value);
      i += 1;
    } else {
      return invalid();
    }
  }
  return {
    kind: "parsed",
    command: {
      kind: "list",
      subcommand: "list",
      ...(handle === undefined ? {} : { handle }),
      ...(cursor === undefined ? {} : { cursor }),
      limit,
    },
  };
}

function invalid(): ParseTreeCommandResult {
  return { kind: "error", exitCode: 2, message: "nookctl tree: invalid command input" };
}

export async function runTreeCommand(options: RunTreeCommandOptions): Promise<TreeResult> {
  const parsed = parseTreeCommand(options.argv, options.env);
  if (parsed.kind === "error") return parsed;
  if (parsed.command.kind === "help") return { kind: "help", text: formatTreeHelp() };
  let runtime: TreeCommandRuntime;
  try {
    runtime = await options.createRuntime(options.stateDir);
    if (runtime === null || typeof runtime.list !== "function")
      return { kind: "error", exitCode: 3 };
    return await runtime.list({ stateDir: options.stateDir, ...parsed.command });
  } catch {
    return { kind: "error", exitCode: 3 };
  }
}

export function formatTreeHelp(): string {
  return [
    "nookctl tree — bounded operator-only filetree view",
    "",
    "Usage:",
    "  nookctl tree help",
    "  nookctl tree list",
    "  nookctl tree list --handle <opaque-handle> [--cursor <opaque-cursor>] [--limit <1..100>]",
    "",
    "The tree exposes only categorical metadata for approved application artifacts.",
    "It never returns paths, filenames, file contents, keys, credentials, or database bytes.",
    "",
  ].join("\n");
}

export function formatTreeResult(result: TreeResult): string {
  try {
    switch (result.kind) {
      case "help":
        return result.text;
      case "page":
        if (
          result.entries.length > TREE_LIST_MAX_LIMIT ||
          !result.entries.every(validEntry) ||
          (result.next !== null && !isTreeCursor(result.next))
        )
          return "nookctl tree: error\n";
        return [
          "nookctl tree: page",
          `count: ${result.entries.length}`,
          ...result.entries.map(formatEntry),
          `next: ${result.next === null ? "none" : "available"}`,
          "",
        ].join("\n");
      case "empty":
        return "nookctl tree: empty\n";
      case "denied":
        return "nookctl tree: denied\n";
      case "invalid-input":
        return "nookctl tree: invalid-input\n";
      case "locked":
        return "nookctl tree: locked\n";
      case "missing":
        return "nookctl tree: missing\n";
      case "error":
        return "nookctl tree: error\n";
    }
  } catch {
    return "nookctl tree: error\n";
  }
}

function validEntry(value: TreeEntry): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value.handle === null || isTreeHandle(value.handle)) &&
    ["state-root", "quarantine-root", "quarantine-entry", "protected"].includes(value.kind) &&
    value.label === value.kind &&
    ["directory", "file", "unknown"].includes(value.mode) &&
    ["owner", "other", "unknown"].includes(value.owner) &&
    ["bounded", "unknown"].includes(value.sizeClass) &&
    (value.childCount === "unknown" ||
      value.childCount === "n/a" ||
      (Number.isSafeInteger(value.childCount) &&
        value.childCount >= 0 &&
        value.childCount <= TREE_LIST_MAX_LIMIT))
  );
}
function formatEntry(entry: TreeEntry): string {
  return [
    "  -",
    `    kind: ${entry.kind}`,
    `    label: ${entry.label}`,
    `    handle: ${entry.handle === null ? "none" : entry.handle}`,
    `    mode: ${entry.mode}`,
    `    owner: ${entry.owner}`,
    `    size-class: ${entry.sizeClass}`,
    `    children: ${entry.childCount}`,
  ].join("\n");
}
