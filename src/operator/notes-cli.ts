import { TextEncoder } from "node:util";

/**
 * NookBridge Stage 9 §13.11 — operator-only `nookctl notes <subcommand>`.
 *
 * This is the FIRST contract slice of §13.11.  It provides a pure,
 * bounded parser/contract boundary for the exact notes grammar:
 *
 *   nookctl notes help
 *   nookctl notes browse [--cursor <opaque-cursor>] [--limit <1..100>]
 *   nookctl notes search --stdin [--cursor <opaque-cursor>] [--limit <1..100>]
 *   nookctl notes get --handle <opaque-handle>
 *   nookctl notes edit --handle <opaque-handle> --approve-edit --stdin
 *   nookctl notes undo --approve-edit --stdin
 *
 * Security contract (pinned in §13.11):
 *
 *   - read-only default (`help`, `browse`, `search`, `get`) is ungated
 *     and never constructs a mutation/runtime handle;
 *   - `edit` and `undo` require the EXACT `--approve-edit` argv flag;
 *   - `edit` and `undo` also require the EXACT `--stdin` flag (note
 *     bodies, queries, and undo tokens arrive only via bounded stdin);
 *   - duplicate / extra / reordered / flag-shaped / oversized values
 *     are rejected before any runtime construction;
 *   - credentials, keys, bodies, queries, paths, revisions, and tokens
 *     are NEVER accepted through argv or environment variables; the
 *     parser rejects forbidden carriers before any state access;
 *   - opaque cursor and handle values follow the documented bounded
 *     shape (`<prefix>_<token>`) so an operator cannot smuggle a
 *     filesystem path, a credential, or a raw database id through
 *     argv;
 *   - the runtime factory is constructed ONLY after the parser AND
 *     the approval gate have both passed; on any earlier failure the
 *     factory is never called;
 *   - the runner returns ONLY closed categorical results — no
 *     content, query, title, body, path, identifier, revision, or
 *     native error string ever crosses the formatter boundary;
 *   - `notes.delete` is structurally absent: the parser never accepts
 *     a `delete` subcommand and the formatter never emits a `delete`
 *     kind; and
 *   - this module does NOT perform filesystem, database, network,
 *     RPC, MCP, sync, auth, editor, or undo-preimage I/O.  All such
 *     side effects are the responsibility of a separately wired
 *     runtime that satisfies the `NotesCommandRuntime` interface.
 *
 * The grammar deliberately omits a `--editor` flag; an external
 * editor handoff is a separate design gate and is out of scope for
 * this slice.
 */

// ---------------------------------------------------------------------------
// Public constants.
// ---------------------------------------------------------------------------

/**
 * The exact argv flag that gates `notes edit` and `notes undo`.
 *
 * Mutation is gated ONLY on this argv flag.  An env fallback would
 * widen the trust surface: env vars are inherited from shells and CI,
 * so the operator must type the exact phrase.
 */
export const APPROVE_EDIT_FLAG = "--approve-edit" as const;

/** Bounded maximum length for opaque cursor/handle values. */
const OPAQUE_VALUE_MAX_LENGTH = 128;

/**
 * Bounded maximum UTF-8 byte length for the caller-supplied stdin
 * search query.  Matches the established 4 MiB upper bound used by
 * `NOTES_UNDO_CONTENT_MAX_BYTES` for body payloads so a search
 * query can never push more data through the operator boundary
 * than the bounded bodies it queries against.
 */
export const MAX_NOTES_QUERY_BYTES = 4 * 1024 * 1024;
/** Maximum Markdown body emitted by `notes get`. */
export const MAX_NOTES_VIEW_MARKDOWN_BYTES = 256 * 1024;

// There is deliberately no edit-envelope or undo-token parser here.  The
// frozen transport forbids a body or token crossing argv, env or stdin:
// `notes edit` sources its body from the operator's editor against a
// daemon-captured preimage, and `notes undo` selects a daemon-minted
// opaque operation handle interactively.  A parser for either shape
// would be an invitation to reintroduce the forbidden path.

// ---------------------------------------------------------------------------
// Forbidden carriers.
//
// Kept in lock-step with the auth/sync/write/conflict/recover parsers so
// the credential-carrier policy is uniform across the operator boundary.
// ---------------------------------------------------------------------------

/**
 * Argv flags that carry credentials, keys, bodies, queries, paths,
 * revisions, or tokens.  These are rejected by the parser before
 * any state or runtime access, in both flag form and `=value` form.
 *
 * `--stdin` is intentionally NOT in this list because it is the
 * exact marker that admits bounded stdin input — the parser rejects
 * `--stdin` only in the wrong position (e.g. on `browse`, `get`, or
 * `help`).
 */
const FORBIDDEN_ARG_FLAGS: readonly string[] = [
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
];

const FORBIDDEN_ENV_VARS: readonly string[] = [
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
];

// ---------------------------------------------------------------------------
// Bounded opaque-value grammar.
//
// Opaque cursor and handle values follow `<prefix>_<token>`:
//   - prefix: 1-4 lowercase ASCII letters, then a single underscore
//     (matching the families the daemon actually mints: `h_` note
//     handles, `op_` operation handles, `cur_` cursors, `not_`/`crs_`
//     client handles);
//   - token: 4..124 ASCII letters/digits/underscores/hyphens;
//   - total length: 1..128 (enforced by `OPAQUE_VALUE_MAX_LENGTH`).
//
// This rejects filesystem paths (`/etc/passwd`, `../`, `~/.ssh/...`),
// bare credential-shaped tokens (`hunter2`, `supersecret`,
// `deadbeefcafe`), raw revision tokens (`rev_...`), and any value
// containing whitespace, control characters, or punctuation beyond
// `_` and `-`.
//
// The prefix width must cover the daemon's own short families.  An
// earlier revision required 3-4 letters, which silently rejected every
// real `h_` note handle and `op_` operation handle the daemon minted.
// ---------------------------------------------------------------------------

const OPAQUE_VALUE_PATTERN = /^[a-z][a-z0-9]{0,3}_[A-Za-z0-9_-]{4,124}$/;

/**
 * `true` iff the bounded opaque value uses a reserved upstream token
 * prefix (e.g. revision tokens are always `rev_<32-hex>`).  A cursor
 * or handle that looks like a revision must be rejected so a caller
 * cannot smuggle a raw upstream identifier through argv.
 */
function isReservedOpaquePrefix(value: string): boolean {
  // `rev_<hex>` is the upstream revision token shape; reject the
  // exact `rev_` prefix family here.
  return /^rev_/.test(value);
}

// ---------------------------------------------------------------------------
// Parsed command shapes.
//
// CLOSED union — exactly the categorical commands the runner can
// dispatch.  No extra fields ever leak.
// ---------------------------------------------------------------------------

export type ParsedNotesCommand =
  | Readonly<{ kind: "help"; subcommand: "help" }>
  | Readonly<{
      kind: "browse";
      subcommand: "browse";
      cursor?: string;
      limit?: number;
    }>
  | Readonly<{
      kind: "search";
      subcommand: "search";
      cursor?: string;
      limit?: number;
    }>
  | Readonly<{
      kind: "get";
      subcommand: "get";
      handle: string;
    }>
  | Readonly<{
      kind: "create";
      subcommand: "create";
      /**
       * Optional bounded notebook selector.  The daemon owns the notebook
       * hierarchy and resolves it; no title or body is ever accepted from
       * argv, env or stdin.
       */
      notebookId?: string;
    }>
  | Readonly<{
      kind: "edit";
      subcommand: "edit";
      handle: string;
    }>
  | Readonly<{
      kind: "undo";
      subcommand: "undo";
      /** `status`/`list` print pending operations; absent means interactive. */
      selector?: "status" | "list";
    }>;

export type ParseNotesCommandResult =
  | Readonly<{ kind: "parsed"; command: ParsedNotesCommand }>
  | Readonly<{ kind: "error"; message: string; exitCode: 2 }>;

// ---------------------------------------------------------------------------
// Closed categorical results.
//
// These are the ONLY shapes the formatter ever prints.  No cause,
// identifier, content, query, body, title, revision, path, key, or
// upstream error string is part of any of these shapes.
// ---------------------------------------------------------------------------

/** Bounded page metadata returned by `browse` and `search`. */
export type BoundedNoteMetadata = Readonly<{
  /** Opaque handle the operator can pass back to `notes get`. */
  readonly handle: string;
  /** Safe display label (never a path or raw id). */
  readonly label: string;
  /** Bounded size in bytes; never reveals body content. */
  readonly bytes: number;
}>;

/** Bounded content returned by `notes get`. */
export type BoundedNoteContent = Readonly<{
  /** Safe display label (never a path or raw id). */
  readonly label?: string;
  /** Bounded Markdown body for operator-only `notes get`. */
  readonly markdown?: string;
  /** Bounded size in bytes; never reveals raw body bytes. */
  readonly bytes: number;
}>;

export type NotesCategoricalResult =
  | Readonly<{ kind: "help"; text: string }>
  | Readonly<{
      kind: "page";
      notes: readonly BoundedNoteMetadata[];
      next: string | null;
    }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "note"; content: BoundedNoteContent }>
  | Readonly<{ kind: "updated" }>
  /**
   * The operator saved without changing anything.  Distinct from
   * `updated` on purpose: no write was applied and no undo record was
   * created, so reporting an update would be a small lie.
   */
  | Readonly<{ kind: "unchanged" }>
  /**
   * A note was created.  Categorical on purpose: the derived title and the
   * daemon's note id stay behind the boundary.
   */
  | Readonly<{ kind: "created" }>
  /** Bounded list of pending undo operations, as opaque operation handles. */
  | Readonly<{ kind: "operations"; handles: readonly string[] }>
  | Readonly<{ kind: "undone" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "invalid-input" }>
  | Readonly<{ kind: "locked" }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "error"; message: string; exitCode: 2 | 3 }>;

// ---------------------------------------------------------------------------
// Runtime seam.
//
// The runner accepts an injected factory so production callers wire
// the operator's actual runtime while tests wire a deterministic
// stub.  The factory is invoked ONLY after the parser AND the
// approval gate have both passed.
//
// The runtime interface is closed and minimal: it exposes ONLY the
// five operator-visible operations and is the boundary at which the
// implementation composes the existing closed method universe.  No
// raw transport, no native filesystem, no editor, no auth, no sync.
// ---------------------------------------------------------------------------

export interface NotesCommandRuntime {
  readonly browse: (command: {
    readonly cursor?: string;
    readonly limit?: number;
  }) => Promise<NotesCategoricalResult>;
  readonly search: (command: {
    /**
     * Bounded, validated, caller-supplied search query.  The query
     * arrives through the runner's stdin plumbing (NEVER argv /
     * env / process I/O inside these contract files); the runner
     * validates the query against `MAX_NOTES_QUERY_BYTES` and
     * `parseNotesSearchQuery` BEFORE invoking the runtime, so a
     * runtime implementation MUST treat `query` as already bounded
     * and never re-echo it through a result.
     */
    readonly query: string;
    readonly cursor?: string;
    readonly limit?: number;
  }) => Promise<NotesCategoricalResult>;
  readonly get: (command: { readonly handle: string }) => Promise<NotesCategoricalResult>;
  /**
   * Bounded edit.  The body does NOT cross this interface: the runtime
   * captures the trusted preimage from the daemon, runs the operator's
   * editor locally, and applies the result.  No body, title, id or
   * token bytes are ever accepted from argv, env or stdin.
   */
  readonly edit: (command: { readonly handle: string }) => Promise<NotesCategoricalResult>;
  /**
   * Bounded create.  The body does NOT cross this interface: the runtime
   * runs the operator's editor over an empty document, derives the title
   * from its first level-1 heading (D11), and creates the note with the
   * heading retained in the body.  No body or title bytes are ever accepted
   * from argv, env or stdin — only the optional notebook selector.
   */
  readonly create: (command: { readonly notebookId?: string }) => Promise<NotesCategoricalResult>;
  /** Pending undo operations as opaque operation handles (no note reference). */
  readonly operations: () => Promise<NotesCategoricalResult>;
  /**
   * Undo a prior edit by its daemon-minted opaque operation handle.
   * The daemon resolves the note and the guarding revision from its own
   * committed record, so no note id or revision crosses the boundary.
   */
  readonly undo: (command: { readonly operationHandle: string }) => Promise<NotesCategoricalResult>;
}

/**
 * Closed verdict for the bounded stdin search query.  `query` carries
 * the validated string; `invalid` collapses every failure mode
 * (non-string, empty, oversized, wrong shape) without echoing the
 * rejected value.  This is the ONLY caller-supplied stdin shape this
 * contract accepts for `notes search`.
 */
export type ParseNotesSearchQueryResult =
  | Readonly<{ kind: "query"; query: string }>
  | Readonly<{ kind: "invalid" }>;

/**
 * Parse the caller-supplied stdin search query.
 *
 * The query MUST be a non-empty string whose UTF-8 byte length is
 * `<= MAX_NOTES_QUERY_BYTES`.  Every other shape collapses to
 * `{ kind: "invalid" }` without echoing the underlying value across
 * the formatter boundary.  This parser does NOT touch
 * `process.stdin`, `process.argv`, or `process.env`; it accepts
 * the already-read string the CLI dispatcher hands it.
 */
export function parseNotesSearchQuery(value: unknown): ParseNotesSearchQueryResult {
  if (typeof value !== "string") return { kind: "invalid" };
  if (value.length === 0) return { kind: "invalid" };
  try {
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes > MAX_NOTES_QUERY_BYTES) return { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
  return { kind: "query", query: value };
}

export type NotesCommandRuntimeFactory = () => NotesCommandRuntime | Promise<NotesCommandRuntime>;

export type RunNotesCommandOptions = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /**
   * Caller-supplied stdin search query.  The runner validates this
   * value via `parseNotesSearchQuery` against `MAX_NOTES_QUERY_BYTES`
   * BEFORE invoking the runtime; the contract files do NOT read
   * `process.stdin`.  A missing / wrong-shaped / empty / oversized
   * value collapses to the categorical `invalid-input` result
   * without the runtime ever being constructed.
   */
  readonly searchQuery?: unknown;
  /**
   * Interactive selection seam for a bare `notes undo`.
   *
   * Selection is by daemon-minted opaque operation handle, never by a
   * token: `tty` must be true only when BOTH stdin and stdout are
   * interactive terminals, and `select` receives the bounded handle list
   * and returns the chosen handle (or `undefined` on cancel).  With no
   * usable seam the bare form fails categorical `invalid-input` rather
   * than guessing which operation to reverse.
   */
  readonly interactive?: Readonly<{
    readonly tty: boolean;
    readonly select?: (handles: readonly string[]) => Promise<string | undefined>;
  }>;
  /**
   * Constructed ONLY after the parser, the credential-carrier policy,
   * and the explicit approval gate have all passed.
   */
  createRuntime: NotesCommandRuntimeFactory;
}>;

// ---------------------------------------------------------------------------
// Help.
// ---------------------------------------------------------------------------

/**
 * Fixed, categorical help text.  This is the ONLY way the CLI
 * surface prints command help; the formatter never interpolates
 * operator input.
 */
export function formatNotesHelp(): string {
  return [
    "nookctl notes — operator-only bounded notes browse/inspection/edit",
    "",
    "Usage:",
    "  nookctl notes help",
    "  nookctl notes browse [--cursor <opaque-cursor>] [--limit <1..100>]",
    "  nookctl notes search --stdin [--cursor <opaque-cursor>] [--limit <1..100>]",
    `  nookctl notes get --handle <opaque-handle>`,
    `  nookctl notes create ${APPROVE_EDIT_FLAG} [--notebook-id <id>]`,
    `  nookctl notes edit --handle <opaque-handle> ${APPROVE_EDIT_FLAG}`,
    `  nookctl notes undo ${APPROVE_EDIT_FLAG} [--status|--list]`,
    "",
    "Options:",
    "  --cursor <opaque-cursor>   pagination cursor from a prior `notes` page",
    "  --limit  <1..100>          bounded page size",
    "  --handle <opaque-handle>   opaque note handle from `notes browse`/`search`",
    `  --notebook-id <id>         optional notebook for \`notes create\``,
    `  ${APPROVE_EDIT_FLAG}        exact approval flag required for create, edit and undo`,
    "  --stdin                    read the bounded search query from stdin",
    "  --status | --list          print pending undo operations as opaque handles",
    "",
    "Subcommands:",
    "  help                       show this help (read-only, ungated)",
    "  browse                     paginate bounded note metadata (read-only)",
    "  search                     paginate search matches (read-only, stdin query)",
    "  get                        return a single bounded note view (read-only)",
    "  create                     new note in $EDITOR (approval-gated)",
    "  edit                       bounded edit in $EDITOR (approval-gated)",
    "  undo                       reverse a prior edit (approval-gated, by opaque handle)",
    "",
    "Notes:",
    "  - queries arrive only via bounded stdin",
    "  - `notes create` takes its title from the first level-1 heading of the",
    "    editor document and keeps that heading in the body; a document with",
    "    no level-1 heading is refused as invalid-input rather than guessed",
    "  - create and edit bodies are edited in $EDITOR; they never cross argv, env or stdin",
    "  - undo selects a daemon-minted opaque handle; no token is accepted",
    "  - credentials, keys, paths, and revisions are not accepted through argv or env",
    "  - `notes delete` is intentionally absent",
    "",
  ].join("\n");
}

/**
 * Format a runtime result without forwarding runtime-controlled text.
 *
 * Only categorical status, bounded counts, byte counts, and validated opaque
 * handles cross this boundary. Labels, bodies, IDs, revisions, paths, causes,
 * and upstream messages are intentionally discarded.
 */
export function formatNotesResult(result: NotesCategoricalResult): string {
  try {
    switch (result.kind) {
      case "help":
        return formatNotesHelp();
      case "page": {
        if (
          !Array.isArray(result.notes) ||
          result.notes.length > 100 ||
          !result.notes.every(
            (note) =>
              note !== null && typeof note === "object" && isBoundedOpaqueValue(note.handle),
          ) ||
          (result.next !== null && !isBoundedOpaqueValue(result.next))
        ) {
          return "nookctl notes: error\n";
        }
        return [
          "nookctl notes: page",
          `count: ${result.notes.length}`,
          ...result.notes.map((note) => `handle: ${note.handle}`),
          `next: ${result.next === null ? "none" : "available"}`,
          "",
        ].join("\n");
      }
      case "note": {
        if (!Number.isSafeInteger(result.content.bytes) || result.content.bytes < 0)
          return "nookctl notes: error\n";
        if (result.content.markdown !== undefined) {
          if (
            typeof result.content.markdown !== "string" ||
            new TextEncoder().encode(result.content.markdown).byteLength >
              MAX_NOTES_VIEW_MARKDOWN_BYTES ||
            // eslint-disable-next-line no-control-regex -- rejecting C0 control characters is the intent here
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result.content.markdown) ||
            result.content.bytes !== new TextEncoder().encode(result.content.markdown).byteLength
          )
            return "nookctl notes: error\n";
          return result.content.markdown.endsWith("\n")
            ? result.content.markdown
            : `${result.content.markdown}\n`;
        }
        return `nookctl notes: note\nbytes: ${result.content.bytes}\n`;
      }
      case "updated":
        return "nookctl notes: updated\n";
      case "unchanged":
        return "nookctl notes: unchanged\n";
      case "created":
        return "nookctl notes: created\n";
      case "operations": {
        if (
          !Array.isArray(result.handles) ||
          result.handles.length > 100 ||
          !result.handles.every((handle) => isBoundedOpaqueValue(handle))
        ) {
          return "nookctl notes: error\n";
        }
        return [
          "nookctl notes: operations",
          `count: ${result.handles.length}`,
          ...result.handles.map((handle) => `operation: ${handle}`),
          "",
        ].join("\n");
      }
      case "undone":
        return "nookctl notes: undone\n";
      case "conflict":
        return "nookctl notes: conflict\n";
      case "denied":
        return "nookctl notes: denied\n";
      case "invalid-input":
        return "nookctl notes: invalid-input\n";
      case "locked":
        return "nookctl notes: locked\n";
      case "missing":
        return "nookctl notes: missing\n";
      case "empty":
        return "nookctl notes: empty\n";
      case "error":
        return "nookctl notes: error\n";
      default: {
        // Exhaustiveness guard.  Every variant of NotesCategoricalResult must
        // return above; a new variant without a formatter case must fail to
        // compile rather than silently inherit the shared "error" return.
        // That fall-through is exactly how an ordinary empty result set was
        // reported to operators as a failure.
        const unhandled: never = result;
        void unhandled;
        return "nookctl notes: error\n";
      }
    }
  } catch {
    return "nookctl notes: error\n";
  }
}

// ---------------------------------------------------------------------------
// Parser.
// ---------------------------------------------------------------------------

/**
 * Parse the slice of argv AFTER the `notes` token, plus an env
 * snapshot.
 *
 * The parser is total: it returns either a validated command or a
 * categorical error.  It does NOT touch the filesystem, network, or
 * runtime surface; it does NOT read or echo carrier values.
 */
export function parseNotesCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParseNotesCommandResult {
  try {
    if (
      typeof argv !== "object" ||
      argv === null ||
      !Array.isArray(argv) ||
      typeof env !== "object" ||
      env === null ||
      Array.isArray(env)
    ) {
      return invalidParseInput();
    }
    const safeArgv = Array.from(argv as readonly unknown[]);
    if (!safeArgv.every((argument): argument is string => typeof argument === "string")) {
      return invalidParseInput();
    }
    const stringArgv = safeArgv as string[];

    for (const name of Object.keys(env)) {
      const value = (env as Record<string, unknown>)[name];
      if (value !== undefined && typeof value !== "string") return invalidParseInput();
    }

    // Credential / body / query / path / revision / token carriers in
    // env.  Presence alone (value never read) is a categorical error.
    for (const name of FORBIDDEN_ENV_VARS) {
      if (name in env) {
        return {
          kind: "error",
          exitCode: 2,
          message:
            "refusing to read credentials or secret carriers from the environment; use the bounded CLI flags",
        };
      }
    }

    // Credential / body / query / path / revision / token carriers in
    // argv, in either flag form or `--flag=value` form.
    for (const argument of stringArgv) {
      const forbidden = FORBIDDEN_ARG_FLAGS.find(
        (candidate) => argument === candidate || argument.startsWith(`${candidate}=`),
      );
      if (forbidden !== undefined) {
        return {
          kind: "error",
          exitCode: 2,
          message:
            "refusing to read credentials, bodies, queries, paths, or revisions from a CLI flag",
        };
      }
    }

    // The approval flag must NEVER appear in `--approve-edit=value`
    // form; the only accepted spelling is the bare token.
    for (const argument of stringArgv) {
      if (argument.startsWith(`${APPROVE_EDIT_FLAG}=`)) {
        return {
          kind: "error",
          exitCode: 2,
          message: `${APPROVE_EDIT_FLAG} is a bare approval flag; the =value form is rejected`,
        };
      }
    }

    const subcommandRaw = stringArgv[0];
    const subcommand = subcommandRaw === undefined ? "help" : subcommandRaw.toLowerCase();

    switch (subcommand) {
      case "help":
      case "--help":
      case "-h":
        if (stringArgv.length > 1) return invalidParseInput();
        return { kind: "parsed", command: { kind: "help", subcommand: "help" } };
      case "browse":
        return parseBrowseOrSearch("browse", stringArgv.slice(1), { requireStdin: false });
      case "search":
        return parseBrowseOrSearch("search", stringArgv.slice(1), { requireStdin: true });
      case "get":
        return parseGet(stringArgv.slice(1));
      case "create":
        return parseCreate(stringArgv.slice(1));
      case "edit":
        return parseEdit(stringArgv.slice(1));
      case "undo":
        return parseUndo(stringArgv.slice(1));
      case "delete":
        // `notes.delete` is structurally absent.  We deliberately do
        // NOT mention the token in the error message.
        return {
          kind: "error",
          exitCode: 2,
          message: "nookctl notes: unknown subcommand; use `nookctl notes help`",
        };
      default:
        return {
          kind: "error",
          exitCode: 2,
          message: "nookctl notes: unknown subcommand; use `nookctl notes help`",
        };
    }
  } catch {
    return invalidParseInput();
  }
}

function invalidParseInput(): ParseNotesCommandResult {
  return { kind: "error", exitCode: 2, message: "nookctl notes: invalid command input" };
}

// ---------------------------------------------------------------------------
// browse / search.
//
// Browse and search share the same optional bounded cursor/limit
// grammar.  Search additionally requires the exact `--stdin` flag.
// ---------------------------------------------------------------------------

function parseBrowseOrSearch(
  kind: "browse" | "search",
  rest: readonly string[],
  opts: { requireStdin: boolean },
): ParseNotesCommandResult {
  let cursor: string | undefined;
  let limit: number | undefined;
  let stdinCount = 0;

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === undefined) return invalidParseInput();

    if (token === "--cursor") {
      if (cursor !== undefined) return invalidParseInput();
      const value = rest[i + 1];
      if (typeof value !== "string") return invalidParseInput();
      if (value.startsWith("--")) return invalidParseInput();
      if (!isBoundedOpaqueValue(value)) return invalidParseInput();
      cursor = value;
      i += 1;
      continue;
    }
    if (token === "--limit") {
      if (limit !== undefined) return invalidParseInput();
      const value = rest[i + 1];
      if (typeof value !== "string") return invalidParseInput();
      if (value.startsWith("--")) return invalidParseInput();
      const parsed = parseBoundedLimit(value);
      if (parsed === undefined) return invalidParseInput();
      limit = parsed;
      i += 1;
      continue;
    }
    if (token === "--stdin") {
      stdinCount += 1;
      if (stdinCount > 1) return invalidParseInput();
      continue;
    }
    // Unknown flag or extra positional.
    return invalidParseInput();
  }

  if (opts.requireStdin && stdinCount !== 1) {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl notes search: requires --stdin (queries arrive only via bounded stdin)",
    };
  }
  if (!opts.requireStdin && stdinCount !== 0) {
    return invalidParseInput();
  }

  if (kind === "browse") {
    return {
      kind: "parsed",
      command:
        cursor === undefined && limit === undefined
          ? { kind: "browse", subcommand: "browse" }
          : {
              kind: "browse",
              subcommand: "browse",
              ...(cursor === undefined ? {} : { cursor }),
              ...(limit === undefined ? {} : { limit }),
            },
    };
  }
  return {
    kind: "parsed",
    command:
      cursor === undefined && limit === undefined
        ? { kind: "search", subcommand: "search" }
        : {
            kind: "search",
            subcommand: "search",
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
          },
  };
}

// ---------------------------------------------------------------------------
// get.
// ---------------------------------------------------------------------------

function parseGet(rest: readonly string[]): ParseNotesCommandResult {
  let handle: string | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === undefined) return invalidParseInput();

    if (token === "--handle") {
      if (handle !== undefined) return invalidParseInput();
      const value = rest[i + 1];
      if (typeof value !== "string") return invalidParseInput();
      if (value.startsWith("--")) return invalidParseInput();
      if (!isBoundedOpaqueValue(value)) return invalidParseInput();
      handle = value;
      i += 1;
      continue;
    }
    return invalidParseInput();
  }

  if (handle === undefined) {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl notes get: requires --handle <opaque-handle>",
    };
  }

  return {
    kind: "parsed",
    command: { kind: "get", subcommand: "get", handle },
  };
}

// ---------------------------------------------------------------------------
// edit.
//
// Exact shape:
//   --handle <opaque-handle> --approve-edit
// in any flag order, with no extras, no duplicates, no =value form.
//
// There is deliberately NO content channel here.  The note body is
// captured from the daemon and edited in the operator's own editor
// (`$VISUAL` / `$EDITOR` / `vi`); no body, title, id, path or token
// bytes may cross argv, env or stdin.
// ---------------------------------------------------------------------------

function parseEdit(rest: readonly string[]): ParseNotesCommandResult {
  let handle: string | undefined;
  let approveCount = 0;

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === undefined) return invalidParseInput();

    if (token === "--handle") {
      if (handle !== undefined) return invalidParseInput();
      const value = rest[i + 1];
      if (typeof value !== "string") return invalidParseInput();
      if (value.startsWith("--")) return invalidParseInput();
      if (!isBoundedOpaqueValue(value)) return invalidParseInput();
      handle = value;
      i += 1;
      continue;
    }
    if (token === APPROVE_EDIT_FLAG) {
      approveCount += 1;
      if (approveCount > 1) return invalidParseInput();
      continue;
    }
    if (token === "--stdin") {
      return {
        kind: "error",
        exitCode: 2,
        message: "nookctl notes edit: bodies are edited in $EDITOR, not supplied on stdin",
      };
    }
    return invalidParseInput();
  }

  if (approveCount !== 1) {
    return {
      kind: "error",
      exitCode: 2,
      message: `nookctl notes edit: requires ${APPROVE_EDIT_FLAG}`,
    };
  }
  if (handle === undefined) {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl notes edit: requires --handle <opaque-handle>",
    };
  }

  return {
    kind: "parsed",
    command: { kind: "edit", subcommand: "edit", handle },
  };
}

// ---------------------------------------------------------------------------
// create.
//
// Exact shapes:
//   --approve-edit
//   --approve-edit --notebook-id <id>
//
// in any flag order, with no extras and no duplicates.  There is NO body
// channel and NO title channel: the document is composed in $EDITOR, the
// title is derived from its first level-1 heading (D11), and the daemon
// mints the note.  A `--stdin` attempt is refused with a message naming
// the reason rather than silently ignoring the payload.
// ---------------------------------------------------------------------------

function parseCreate(rest: readonly string[]): ParseNotesCommandResult {
  let approveCount = 0;
  let notebookId: string | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === undefined) return invalidParseInput();

    if (token === APPROVE_EDIT_FLAG) {
      approveCount += 1;
      if (approveCount > 1) return invalidParseInput();
      continue;
    }
    if (token === "--notebook-id") {
      if (notebookId !== undefined) return invalidParseInput();
      const value = rest[i + 1];
      if (typeof value !== "string") return invalidParseInput();
      if (value.startsWith("--")) return invalidParseInput();
      if (!isBoundedNotebookId(value)) return invalidParseInput();
      notebookId = value;
      i += 1;
      continue;
    }
    if (token === "--stdin") {
      return {
        kind: "error",
        exitCode: 2,
        message: "nookctl notes create: bodies are edited in $EDITOR, not supplied on stdin",
      };
    }
    return invalidParseInput();
  }

  if (approveCount !== 1) {
    return {
      kind: "error",
      exitCode: 2,
      message: `nookctl notes create: requires ${APPROVE_EDIT_FLAG}`,
    };
  }

  return {
    kind: "parsed",
    command:
      notebookId === undefined
        ? { kind: "create", subcommand: "create" }
        : { kind: "create", subcommand: "create", notebookId },
  };
}

/**
 * D11 — the title of a created note is the text of the **first level-1
 * heading**, and that heading stays in the body.
 *
 * The scan is deliberately literal: only an ATX `#` followed by whitespace
 * starts a heading (CommonMark), so `#hashtag` is prose and `## Section` is
 * not a title.  A heading with no text is skipped, later H1s are ignored,
 * and a document with no usable H1 returns `undefined` so the caller fails
 * categorical with `invalid-input` rather than inventing a title from a
 * paragraph, a list item, or an H2.
 */
export function deriveCreateTitle(markdown: string): string | undefined {
  if (typeof markdown !== "string" || markdown.length === 0) return undefined;
  for (const line of markdown.split("\n")) {
    const match = /^#[ \t]+(\S.*?)[ \t]*$/.exec(line);
    if (match === null) continue;
    const title = match[1];
    if (typeof title === "string" && title.length > 0) return title;
  }
  return undefined;
}

/** Bounded opaque notebook selector: an id the daemon minted, never a path. */
function isBoundedNotebookId(value: string): boolean {
  if (value.length === 0 || value.length > OPAQUE_VALUE_MAX_LENGTH) return false;
  return /^[A-Za-z0-9_-]+$/.test(value);
}

// ---------------------------------------------------------------------------
// undo.
//
// Exact shapes:
//   --approve-edit --status
//   --approve-edit --list
//   --approve-edit              (interactive selection of a pending operation)
//
// in any flag order, with no extras, no duplicates, no =value form,
// and no `--handle`.  There is no `--token` flag and no token env var:
// the only bytes that cross argv/env here are the flag names and the
// bare approval flag.  Selection is by daemon-minted opaque operation
// handle, chosen from `--status`/`--list` output over an interactive
// TTY; with no TTY the bare form fails categorical.
// ---------------------------------------------------------------------------

function parseUndo(rest: readonly string[]): ParseNotesCommandResult {
  let approveCount = 0;
  let selector: "status" | "list" | undefined;
  let selectorCount = 0;

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === undefined) return invalidParseInput();

    if (token === APPROVE_EDIT_FLAG) {
      approveCount += 1;
      if (approveCount > 1) return invalidParseInput();
      continue;
    }
    if (token === "--status" || token === "--list") {
      selectorCount += 1;
      if (selectorCount > 1) return invalidParseInput();
      selector = token === "--status" ? "status" : "list";
      continue;
    }
    if (token === "--stdin" || token === "--token" || token.startsWith("--token=")) {
      return {
        kind: "error",
        exitCode: 2,
        message:
          "nookctl notes undo: select a pending operation by opaque handle; no token is accepted",
      };
    }
    return invalidParseInput();
  }

  if (approveCount !== 1) {
    return {
      kind: "error",
      exitCode: 2,
      message: `nookctl notes undo: requires ${APPROVE_EDIT_FLAG}`,
    };
  }

  return {
    kind: "parsed",
    command:
      selector === undefined
        ? { kind: "undo", subcommand: "undo" }
        : { kind: "undo", subcommand: "undo", selector },
  };
}

// ---------------------------------------------------------------------------
// Bounded value validators.
// ---------------------------------------------------------------------------

/**
 * `true` iff `value` is a bounded opaque cursor or handle value:
 * the documented `<prefix>_<token>` shape with total length in
 * `1..128`.  This deliberately rejects filesystem paths, raw
 * credentials, and revision tokens; tests pin the rule.
 */
export function isBoundedOpaqueValue(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > OPAQUE_VALUE_MAX_LENGTH) return false;
  if (isReservedOpaquePrefix(value)) return false;
  return OPAQUE_VALUE_PATTERN.test(value);
}

/**
 * `true` iff `value` parses as a bounded integer in the closed
 * `1..100` range.  Empty strings, whitespace, decimals, signs, and
 * out-of-range integers are rejected; values are never echoed.
 */
export function parseBoundedLimit(value: string): number | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.length > 4) return undefined;
  if (!/^[0-9]+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed < 1 || parsed > 100) return undefined;
  return parsed;
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

/**
 * Run a bounded notes command.
 *
 * The runner NEVER reads `process.env` / `process.argv`; the CLI
 * dispatcher is the only thing that snapshots the environment, and
 * it explicitly drops credential carriers before calling the parser.
 *
 * Ordering:
 *
 *   parse → credential-carrier rejection → approval gate → runtime
 *   construction → dispatch → closed categorical result
 *
 * On any earlier failure (parse error, carrier rejection, approval
 * gate failure, malformed input) the runtime factory is NEVER
 * called.
 */
export async function runNotesCommand(
  options: RunNotesCommandOptions,
): Promise<NotesCategoricalResult> {
  let normalized: RunNotesCommandOptions;
  try {
    normalized = normalizeRunOptions(options);
  } catch {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl notes: invalid command input",
    };
  }

  const parsed = parseNotesCommand(normalized.argv, normalized.env);
  if (parsed.kind === "error") {
    return { kind: "error", exitCode: parsed.exitCode, message: parsed.message };
  }
  const command = parsed.command;

  if (command.kind === "help") {
    return { kind: "help", text: formatNotesHelp() };
  }

  // Validate the caller-supplied stdin search query BEFORE constructing
  // the runtime.  Invalid input must not open state or reach a source.
  let validatedQuery: string | undefined;
  if (command.kind === "search") {
    const queryVerdict = parseNotesSearchQuery(normalized.searchQuery);
    if (queryVerdict.kind !== "query") return { kind: "invalid-input" };
    validatedQuery = queryVerdict.query;
  }

  // A bare `notes undo` needs an interactive selector.  Fail before
  // constructing any runtime or touching the daemon when there is none,
  // rather than reversing an operation the operator did not choose.
  if (
    command.kind === "undo" &&
    command.selector === undefined &&
    (normalized.interactive === undefined ||
      normalized.interactive.tty !== true ||
      typeof normalized.interactive.select !== "function")
  ) {
    return { kind: "invalid-input" };
  }

  // The runtime factory is constructed ONLY after parse + approval
  // gate have both passed.  Read-only commands (`browse`, `search`,
  // `get`) and `undo --status`/`--list` are ungated but they still go
  // through this single seam.
  let runtime: NotesCommandRuntime;
  try {
    runtime = await normalized.createRuntime();
  } catch {
    // Runtime construction failures collapse to a closed categorical
    // `error`.  No cause / message / path leaks across the boundary.
    return {
      kind: "error",
      exitCode: 3,
      message: "nookctl notes: runtime construction refused",
    };
  }

  try {
    switch (command.kind) {
      case "browse":
        return await runtime.browse({
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          ...(command.limit === undefined ? {} : { limit: command.limit }),
        });
      case "search":
        return await runtime.search({
          query: validatedQuery as string,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          ...(command.limit === undefined ? {} : { limit: command.limit }),
        });
      case "get":
        return await runtime.get({ handle: command.handle });
      case "edit":
        // The body never crosses this boundary: the runtime captures the
        // trusted preimage, runs the operator's editor, and applies the
        // result.  Only the opaque handle is passed down.
        return await runtime.edit({ handle: command.handle });
      case "create":
        // The body never crosses this boundary either: the runtime runs the
        // operator's editor over an empty document, derives the title from
        // the first level-1 heading (D11), and creates the note.
        return await runtime.create(
          command.notebookId === undefined ? {} : { notebookId: command.notebookId },
        );
      case "undo":
        return await runUndo(runtime, command, normalized.interactive);
    }
  } catch {
    // Any runtime throw collapses to the closed categorical `error`.
    // The cause / message / path is NEVER forwarded.
    return {
      kind: "error",
      exitCode: 3,
      message: "nookctl notes: runtime error",
    };
  }
}

/**
 * `notes undo` — list pending operations, or select one interactively.
 *
 * The selector forms are read-only and ungated.  The bare form needs a
 * usable TTY seam: without one the command fails categorical rather than
 * reversing an operation the operator did not choose.  A returned handle
 * is re-validated against the bounded list, so a hostile `select`
 * implementation cannot smuggle a value the daemon never minted.
 */
async function runUndo(
  runtime: NotesCommandRuntime,
  command: Extract<ParsedNotesCommand, { kind: "undo" }>,
  interactive: RunNotesCommandOptions["interactive"],
): Promise<NotesCategoricalResult> {
  if (command.selector !== undefined) return await runtime.operations();

  if (
    interactive === undefined ||
    interactive.tty !== true ||
    typeof interactive.select !== "function"
  ) {
    return { kind: "invalid-input" };
  }

  const listed = await runtime.operations();
  if (listed.kind !== "operations") return listed;
  if (listed.handles.length === 0) return listed;

  let chosen: string | undefined;
  try {
    chosen = await interactive.select(listed.handles);
  } catch {
    chosen = undefined;
  }
  if (
    typeof chosen !== "string" ||
    !isBoundedOpaqueValue(chosen) ||
    !listed.handles.includes(chosen)
  ) {
    return { kind: "invalid-input" };
  }
  return await runtime.undo({ operationHandle: chosen });
}

function normalizeRunOptions(options: RunNotesCommandOptions): RunNotesCommandOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.argv !== "object" ||
    options.argv === null ||
    !Array.isArray(options.argv) ||
    typeof options.env !== "object" ||
    options.env === null ||
    Array.isArray(options.env) ||
    typeof options.createRuntime !== "function"
  ) {
    throw new Error("invalid options");
  }
  for (const argument of options.argv) {
    if (typeof argument !== "string") throw new Error("invalid options");
  }
  for (const name of Object.keys(options.env)) {
    const value = (options.env as Record<string, unknown>)[name];
    if (value !== undefined && typeof value !== "string") throw new Error("invalid options");
  }
  return options;
}
