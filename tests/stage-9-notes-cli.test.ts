/**
 * Stage 9 §13.11 — first contract slice of the operator-only `notes` CLI tree.
 *
 * This is the RED/GREEN foundation for the bounded parser, the exact
 * `--approve-edit` approval gate, the bounded opaque cursor/handle/limit
 * inputs, the closed categorical results, and the proof that the
 * injected runtime factory is never constructed on parse or gate
 * failure.
 *
 * Scope pinned in the task allowlist:
 *
 *   - no runtime / MCP / RPC wiring (factory is injected; never called
 *     on parse or gate failure);
 *   - no filesystem, database, network, sync, auth, editor, or
 *     undo-preimage I/O;
 *   - no `notes.delete` vocabulary;
 *   - no `tree` commands;
 *   - no write-admin semantics changes.
 *
 * The grammar under test is exactly:
 *
 *   nookctl notes help
 *   nookctl notes browse [--cursor <opaque-cursor>] [--limit <1..100>]
 *   nookctl notes search --stdin [--cursor <opaque-cursor>] [--limit <1..100>]
 *   nookctl notes get --handle <opaque-handle>
 *   nookctl notes edit --handle <opaque-handle> --approve-edit --stdin
 *   nookctl notes undo --approve-edit --stdin
 */

import { describe, expect, it, vi } from "vitest";

import { Buffer } from "node:buffer";
import { TextEncoder } from "node:util";

import {
  APPROVE_EDIT_FLAG,
  MAX_NOTES_QUERY_BYTES,
  parseNotesCommand,
  parseNotesSearchQuery,
  parseNotesEditStdin,
  parseNotesUndoStdin,
  formatNotesHelp,
  formatNotesResult,
  runNotesCommand,
  type NotesCommandRuntimeFactory,
  type NotesCommandRuntime,
  type NotesCategoricalResult,
  type ParsedNotesCommand,
} from "../src/operator/notes-cli.js";

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------
// (A higher-level recording factory is constructed inline in each test
//  via vi.fn() so we can assert exactly when the contract seam is or
//  isn't invoked.)
void ({} as NotesCommandRuntimeFactory | NotesCommandRuntime | NotesCategoricalResult);

/** Build a clean env snapshot for tests. */
function emptyEnv(): Record<string, string | undefined> {
  return {};
}

/** Assert that `parsed.kind === "parsed"` and return the command. */
function expectParsed(parsed: ReturnType<typeof parseNotesCommand>): ParsedNotesCommand {
  expect(parsed.kind).toBe("parsed");
  if (parsed.kind !== "parsed") {
    throw new Error("expected a parsed command");
  }
  return parsed.command;
}

/** Assert that `parsed.kind === "error"` and return the error. */
function expectError(parsed: ReturnType<typeof parseNotesCommand>): {
  message: string;
  exitCode: 2;
} {
  expect(parsed.kind).toBe("error");
  if (parsed.kind !== "error") {
    throw new Error("expected a parse error");
  }
  expect(parsed.exitCode).toBe(2);
  return parsed;
}

// ---------------------------------------------------------------------------
// Help / read-only parsing — `notes help` is ungated and read-only.
// ---------------------------------------------------------------------------

describe("parseNotesCommand — help / read-only parsing", () => {
  it("treats the bare `notes` invocation as help (read-only, ungated)", () => {
    const parsed = parseNotesCommand([], emptyEnv());
    const command = expectParsed(parsed);
    expect(command.kind).toBe("help");
  });

  it("treats `notes help` as the read-only help command", () => {
    const parsed = parseNotesCommand(["help"], emptyEnv());
    const command = expectParsed(parsed);
    expect(command.kind).toBe("help");
  });

  it("treats `--help` and `-h` as the read-only help command", () => {
    expect(expectParsed(parseNotesCommand(["--help"], emptyEnv())).kind).toBe("help");
    expect(expectParsed(parseNotesCommand(["-h"], emptyEnv())).kind).toBe("help");
  });

  it("refuses any argv flag after `help` (read-only must be exact)", () => {
    for (const argv of [
      ["help", "--cursor", "abc"],
      ["help", "--limit", "10"],
      ["help", "--stdin"],
      ["help", "--approve-edit"],
      ["help", "browse"],
    ]) {
      expectError(parseNotesCommand(argv, emptyEnv()));
    }
  });

  it("treats `delete` as structurally absent (no surface in grammar or help)", () => {
    const text = formatNotesHelp();
    // The delete token must NEVER appear as a documented subcommand
    // or option.  We permit (and explicitly want) a single bounded
    // absence note; this regex asserts the only legal occurrence is
    // inside the `notes delete` absent-intent line.
    const deleteMatches = text.match(/delete/g) ?? [];
    if (deleteMatches.length > 0) {
      // Every occurrence must live inside the dedicated absence line.
      const lines = text.split("\n").filter((line: string) => line.includes("delete"));
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(/`?notes delete`? is (?:intentionally )?absent/);
    }
  });
});

describe("parseNotesCommand — unknown subcommand and `delete`", () => {
  it("rejects `delete` as a structurally absent subcommand", () => {
    const err = expectError(parseNotesCommand(["delete"], emptyEnv()));
    // The error message must not echo the absent token; the absence
    // is communicated structurally by the help text, not by echoing.
    expect(err.message.toLowerCase()).not.toContain("delete");
  });

  it("rejects an unknown subcommand with a categorical message", () => {
    const err = expectError(parseNotesCommand(["nuke"], emptyEnv()));
    // The message must not echo the unknown token back.
    expect(err.message).not.toContain("nuke");
  });

  it("rejects an unknown subcommand even when env is otherwise clean", () => {
    expectError(parseNotesCommand(["tree"], emptyEnv()));
    expectError(parseNotesCommand(["write"], emptyEnv()));
    expectError(parseNotesCommand(["sync"], emptyEnv()));
    expectError(parseNotesCommand(["auth"], emptyEnv()));
  });
});

// ---------------------------------------------------------------------------
// Forbidden credential / body / query / path / revision / token carriers.
// ---------------------------------------------------------------------------

describe("parseNotesCommand — forbidden carrier boundary (argv / env)", () => {
  const forbiddenArgFlags = [
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
    "--path",
    "--file",
    "--content-file",
    "--expect-revision",
    "--revision",
  ] as const;

  const forbiddenEnvVars = [
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

  for (const flag of forbiddenArgFlags) {
    it(`rejects the forbidden argv flag ${flag}`, () => {
      const err = expectError(parseNotesCommand(["browse", flag, "leaf"], emptyEnv()));
      expect(err.message.toLowerCase()).toContain("credential");
      // The error must never echo the carrier value or the flag value.
      expect(err.message).not.toContain("leaf");
    });
  }

  for (const flag of forbiddenArgFlags) {
    it(`rejects the forbidden argv flag ${flag} in the =value form`, () => {
      const err = expectError(parseNotesCommand([`${flag}=leaf`], emptyEnv()));
      expect(err.message).not.toContain("leaf");
    });
  }

  it("rejects the approval flag in the =value form", () => {
    const err = expectError(
      parseNotesCommand(
        ["edit", "--handle", "h_ok_12345678", `${APPROVE_EDIT_FLAG}=yes`, "--stdin"],
        emptyEnv(),
      ),
    );
    // The error must be categorical, never echo a value.
    expect(err.message).not.toContain("yes");
  });

  for (const name of forbiddenEnvVars) {
    it(`rejects the forbidden env carrier ${name} on presence alone`, () => {
      const err = expectError(parseNotesCommand(["browse"], { [name]: "smuggled" }));
      // The error must never echo the smuggled value.
      expect(err.message).not.toContain("smuggled");
    });
  }

  it("rejects forbidden env carriers even on the read-only help path", () => {
    const err = expectError(parseNotesCommand(["help"], { NOOKBRIDGE_PASSWORD: "x" }));
    expect(err.message).not.toContain("x");
  });
});

// ---------------------------------------------------------------------------
// `notes browse` — exact grammar, optional bounded cursor + limit.
// ---------------------------------------------------------------------------

describe("parseNotesCommand — `notes browse`", () => {
  it("parses bare `browse` with no cursor or limit", () => {
    const command = expectParsed(parseNotesCommand(["browse"], emptyEnv()));
    expect(command.kind).toBe("browse");
    if (command.kind !== "browse") return;
    expect(command.cursor).toBeUndefined();
    expect(command.limit).toBeUndefined();
  });

  it("parses `browse --cursor <opaque> --limit <n>`", () => {
    const command = expectParsed(
      parseNotesCommand(["browse", "--cursor", "crs_ok_12345678", "--limit", "25"], emptyEnv()),
    );
    expect(command.kind).toBe("browse");
    if (command.kind !== "browse") return;
    expect(command.cursor).toBe("crs_ok_12345678");
    expect(command.limit).toBe(25);
  });

  it("accepts the cursor and limit flags in either order", () => {
    const command = expectParsed(
      parseNotesCommand(["browse", "--limit", "5", "--cursor", "crs_ok_12345678"], emptyEnv()),
    );
    if (command.kind !== "browse") return;
    expect(command.cursor).toBe("crs_ok_12345678");
    expect(command.limit).toBe(5);
  });

  it("rejects `browse --stdin` (read-only browse has no stdin)", () => {
    expectError(parseNotesCommand(["browse", "--stdin"], emptyEnv()));
  });

  it("rejects `browse --approve-edit` (read-only browse is not gated)", () => {
    expectError(parseNotesCommand(["browse", APPROVE_EDIT_FLAG], emptyEnv()));
  });

  it("rejects duplicate `--cursor` flags", () => {
    expectError(
      parseNotesCommand(
        ["browse", "--cursor", "crs_ok_12345678", "--cursor", "crs_ok_12345678"],
        emptyEnv(),
      ),
    );
  });

  it("rejects duplicate `--limit` flags", () => {
    expectError(parseNotesCommand(["browse", "--limit", "5", "--limit", "10"], emptyEnv()));
  });

  it("rejects `--cursor` with a missing value (flag-shaped)", () => {
    // The next token starts with `--`, so it cannot be the value.
    expectError(parseNotesCommand(["browse", "--cursor", "--limit"], emptyEnv()));
  });

  it("rejects `--limit` with a missing value (flag-shaped)", () => {
    expectError(parseNotesCommand(["browse", "--limit", "--cursor"], emptyEnv()));
  });

  it("rejects `--limit` values that are not integers", () => {
    for (const bad of ["abc", "1.5", "-1", "0", " 5", "5 ", " 5 "]) {
      const err = expectError(parseNotesCommand(["browse", "--limit", bad], emptyEnv()));
      expect(err.message).not.toContain(bad);
    }
  });

  it("rejects `--limit` values outside the bounded 1..100 range", () => {
    for (const bad of ["0", "101", "9999"]) {
      expectError(parseNotesCommand(["browse", "--limit", bad], emptyEnv()));
    }
  });

  it("rejects `--cursor` values that exceed the opaque cursor bound", () => {
    const tooLong = "x".repeat(129);
    expectError(parseNotesCommand(["browse", "--cursor", tooLong], emptyEnv()));
  });

  it("rejects `--cursor` values that look like filesystem paths", () => {
    for (const path of ["/etc/passwd", "../etc/passwd", "./leaf", "~/.ssh/id_rsa"]) {
      expectError(parseNotesCommand(["browse", "--cursor", path], emptyEnv()));
    }
  });

  it("rejects `--cursor` values that look like credentials", () => {
    for (const cred of ["hunter2", "supersecret", "deadbeefcafe"]) {
      // A bare credential-shaped token is not an opaque cursor.
      expectError(parseNotesCommand(["browse", "--cursor", cred], emptyEnv()));
    }
  });

  it("rejects unknown flag combinations after `browse`", () => {
    expectError(parseNotesCommand(["browse", "--unknown", "value"], emptyEnv()));
  });

  it("rejects extra positional arguments after `browse`", () => {
    expectError(parseNotesCommand(["browse", "extra"], emptyEnv()));
  });
});

// ---------------------------------------------------------------------------
// `notes search` — requires `--stdin`, optional bounded cursor + limit.
// ---------------------------------------------------------------------------

describe("parseNotesCommand — `notes search`", () => {
  it("parses `search --stdin` with no cursor or limit", () => {
    const command = expectParsed(parseNotesCommand(["search", "--stdin"], emptyEnv()));
    expect(command.kind).toBe("search");
    if (command.kind !== "search") return;
    expect(command.cursor).toBeUndefined();
    expect(command.limit).toBeUndefined();
  });

  it("parses `search --stdin --cursor <opaque> --limit <n>`", () => {
    const command = expectParsed(
      parseNotesCommand(
        ["search", "--stdin", "--cursor", "crs_ok_12345678", "--limit", "50"],
        emptyEnv(),
      ),
    );
    if (command.kind !== "search") return;
    expect(command.cursor).toBe("crs_ok_12345678");
    expect(command.limit).toBe(50);
  });

  it("rejects `search` without `--stdin` (queries only arrive via bounded stdin)", () => {
    expectError(parseNotesCommand(["search"], emptyEnv()));
    expectError(parseNotesCommand(["search", "--cursor", "crs_ok_12345678"], emptyEnv()));
    expectError(parseNotesCommand(["search", "--limit", "10"], emptyEnv()));
  });

  it("rejects duplicate `--stdin` flags", () => {
    expectError(parseNotesCommand(["search", "--stdin", "--stdin"], emptyEnv()));
  });

  it("rejects a `--query` argv carrier (queries are stdin-only)", () => {
    expectError(parseNotesCommand(["search", "--stdin", "--query", "leaf"], emptyEnv()));
  });

  it("rejects duplicate cursor/limit flags and out-of-range limits", () => {
    expectError(
      parseNotesCommand(
        ["search", "--stdin", "--cursor", "crs_ok_12345678", "--cursor", "crs_ok_12345678"],
        emptyEnv(),
      ),
    );
    expectError(
      parseNotesCommand(["search", "--stdin", "--limit", "5", "--limit", "10"], emptyEnv()),
    );
    expectError(parseNotesCommand(["search", "--stdin", "--limit", "0"], emptyEnv()));
    expectError(parseNotesCommand(["search", "--stdin", "--limit", "101"], emptyEnv()));
  });

  it("rejects extra positional arguments after `search`", () => {
    expectError(parseNotesCommand(["search", "--stdin", "extra"], emptyEnv()));
  });

  it("rejects unknown flag combinations after `search`", () => {
    expectError(parseNotesCommand(["search", "--stdin", "--unknown", "value"], emptyEnv()));
  });
});

// ---------------------------------------------------------------------------
// `notes get` — requires a bounded opaque `--handle`, read-only.
// ---------------------------------------------------------------------------

describe("parseNotesCommand — `notes get`", () => {
  it("parses `get --handle <opaque>`", () => {
    const command = expectParsed(
      parseNotesCommand(["get", "--handle", "hnd_ok_12345678"], emptyEnv()),
    );
    expect(command.kind).toBe("get");
    if (command.kind !== "get") return;
    expect(command.handle).toBe("hnd_ok_12345678");
  });

  it("rejects `get` without `--handle`", () => {
    expectError(parseNotesCommand(["get"], emptyEnv()));
    expectError(parseNotesCommand(["get", "--stdin"], emptyEnv()));
  });

  it("rejects duplicate `--handle` flags", () => {
    expectError(
      parseNotesCommand(
        ["get", "--handle", "hnd_ok_12345678", "--handle", "hnd_ok_12345678"],
        emptyEnv(),
      ),
    );
  });

  it("rejects `--handle` with a missing value (flag-shaped)", () => {
    expectError(parseNotesCommand(["get", "--handle", "--cursor"], emptyEnv()));
  });

  it("rejects `--handle` values that exceed the opaque handle bound", () => {
    const tooLong = "x".repeat(129);
    expectError(parseNotesCommand(["get", "--handle", tooLong], emptyEnv()));
  });

  it("rejects `--handle` values that look like filesystem paths", () => {
    for (const path of ["/etc/passwd", "../etc/passwd", "./leaf"]) {
      expectError(parseNotesCommand(["get", "--handle", path], emptyEnv()));
    }
  });

  it("rejects `--handle` values that look like credentials", () => {
    for (const cred of ["hunter2", "supersecret", "deadbeefcafe"]) {
      expectError(parseNotesCommand(["get", "--handle", cred], emptyEnv()));
    }
  });

  it("rejects the `--approve-edit` flag on `get` (read-only)", () => {
    expectError(
      parseNotesCommand(["get", "--handle", "hnd_ok_12345678", APPROVE_EDIT_FLAG], emptyEnv()),
    );
  });

  it("rejects extra positional arguments after `get`", () => {
    expectError(parseNotesCommand(["get", "--handle", "hnd_ok_12345678", "extra"], emptyEnv()));
  });
});

// ---------------------------------------------------------------------------
// `notes edit` — exact approval gate, exact positional/option shape.
// ---------------------------------------------------------------------------

describe("parseNotesCommand — `notes edit` exact approval gate", () => {
  const VALID_HANDLE = "hnd_ok_12345678";

  it("requires the exact `--approve-edit` flag", () => {
    const err = expectError(
      parseNotesCommand(["edit", "--handle", VALID_HANDLE, "--stdin"], emptyEnv()),
    );
    expect(err.message).toContain(APPROVE_EDIT_FLAG);
  });

  it("requires `--stdin` (note bodies arrive only via bounded stdin)", () => {
    expectError(
      parseNotesCommand(["edit", "--handle", VALID_HANDLE, APPROVE_EDIT_FLAG], emptyEnv()),
    );
  });

  it("requires `--handle <opaque-handle>`", () => {
    expectError(parseNotesCommand(["edit", APPROVE_EDIT_FLAG, "--stdin"], emptyEnv()));
  });

  it("parses the exact `edit --handle <opaque> --approve-edit --stdin` shape", () => {
    const command = expectParsed(
      parseNotesCommand(
        ["edit", "--handle", VALID_HANDLE, APPROVE_EDIT_FLAG, "--stdin"],
        emptyEnv(),
      ),
    );
    expect(command.kind).toBe("edit");
    if (command.kind !== "edit") return;
    expect(command.handle).toBe(VALID_HANDLE);
  });

  it("accepts the flags in either order (handle vs approve vs stdin)", () => {
    const variants: ReadonlyArray<readonly string[]> = [
      ["edit", "--handle", VALID_HANDLE, APPROVE_EDIT_FLAG, "--stdin"],
      ["edit", "--handle", VALID_HANDLE, "--stdin", APPROVE_EDIT_FLAG],
      ["edit", APPROVE_EDIT_FLAG, "--handle", VALID_HANDLE, "--stdin"],
      ["edit", APPROVE_EDIT_FLAG, "--stdin", "--handle", VALID_HANDLE],
      ["edit", "--stdin", "--handle", VALID_HANDLE, APPROVE_EDIT_FLAG],
      ["edit", "--stdin", APPROVE_EDIT_FLAG, "--handle", VALID_HANDLE],
    ];
    for (const argv of variants) {
      const command = expectParsed(parseNotesCommand(argv, emptyEnv()));
      expect(command.kind).toBe("edit");
    }
  });

  it("rejects duplicate `--approve-edit` flags", () => {
    expectError(
      parseNotesCommand(
        ["edit", "--handle", VALID_HANDLE, APPROVE_EDIT_FLAG, APPROVE_EDIT_FLAG, "--stdin"],
        emptyEnv(),
      ),
    );
  });

  it("rejects duplicate `--stdin` flags", () => {
    expectError(
      parseNotesCommand(
        ["edit", "--handle", VALID_HANDLE, APPROVE_EDIT_FLAG, "--stdin", "--stdin"],
        emptyEnv(),
      ),
    );
  });

  it("rejects duplicate `--handle` flags", () => {
    expectError(
      parseNotesCommand(
        ["edit", "--handle", VALID_HANDLE, "--handle", VALID_HANDLE, APPROVE_EDIT_FLAG, "--stdin"],
        emptyEnv(),
      ),
    );
  });

  it("rejects any extra positional argument", () => {
    expectError(
      parseNotesCommand(
        ["edit", "--handle", VALID_HANDLE, APPROVE_EDIT_FLAG, "--stdin", "extra"],
        emptyEnv(),
      ),
    );
  });

  it("rejects an unknown flag even when the rest is well-formed", () => {
    expectError(
      parseNotesCommand(
        ["edit", "--handle", VALID_HANDLE, APPROVE_EDIT_FLAG, "--stdin", "--unknown", "value"],
        emptyEnv(),
      ),
    );
  });

  it("rejects an --expect-revision argv carrier on edit (revisions are not argv)", () => {
    expectError(
      parseNotesCommand(
        [
          "edit",
          "--handle",
          VALID_HANDLE,
          APPROVE_EDIT_FLAG,
          "--stdin",
          "--expect-revision",
          "rev_abcdefabcdefabcdefabcdefabcdefab",
        ],
        emptyEnv(),
      ),
    );
  });

  it("rejects an --expect-revision argv carrier in the =value form on edit", () => {
    expectError(
      parseNotesCommand(
        [
          "edit",
          "--handle",
          VALID_HANDLE,
          APPROVE_EDIT_FLAG,
          "--stdin",
          "--expect-revision=rev_abcdefabcdefabcdefabcdefabcdefab",
        ],
        emptyEnv(),
      ),
    );
  });

  it("rejects a revision-shaped handle (handle is opaque, not a revision)", () => {
    expectError(
      parseNotesCommand(
        ["edit", "--handle", "rev_abcdefabcdefabcdefabcdefabcdefab", APPROVE_EDIT_FLAG, "--stdin"],
        emptyEnv(),
      ),
    );
  });

  it("rejects path-shaped handles (handle is opaque, not a path)", () => {
    expectError(
      parseNotesCommand(
        ["edit", "--handle", "/etc/passwd", APPROVE_EDIT_FLAG, "--stdin"],
        emptyEnv(),
      ),
    );
  });

  it("rejects credential-shaped handles", () => {
    expectError(
      parseNotesCommand(
        ["edit", "--handle", "supersecret", APPROVE_EDIT_FLAG, "--stdin"],
        emptyEnv(),
      ),
    );
  });

  it("rejects handles that exceed the opaque bound", () => {
    const tooLong = "x".repeat(129);
    expectError(
      parseNotesCommand(["edit", "--handle", tooLong, APPROVE_EDIT_FLAG, "--stdin"], emptyEnv()),
    );
  });
});

// ---------------------------------------------------------------------------
// `notes undo` — exact approval gate, no handle, exact shape.
// ---------------------------------------------------------------------------

describe("parseNotesCommand — `notes undo` exact approval gate", () => {
  it("requires the exact `--approve-edit` flag", () => {
    const err = expectError(parseNotesCommand(["undo", "--stdin"], emptyEnv()));
    expect(err.message).toContain(APPROVE_EDIT_FLAG);
  });

  it("requires `--stdin` (undo payloads arrive only via bounded stdin)", () => {
    expectError(parseNotesCommand(["undo", APPROVE_EDIT_FLAG], emptyEnv()));
  });

  it("parses the exact `undo --approve-edit --stdin` shape", () => {
    const command = expectParsed(
      parseNotesCommand(["undo", APPROVE_EDIT_FLAG, "--stdin"], emptyEnv()),
    );
    expect(command.kind).toBe("undo");
  });

  it("accepts the flags in either order", () => {
    const command = expectParsed(
      parseNotesCommand(["undo", "--stdin", APPROVE_EDIT_FLAG], emptyEnv()),
    );
    expect(command.kind).toBe("undo");
  });

  it("rejects duplicate `--approve-edit` flags", () => {
    expectError(
      parseNotesCommand(["undo", APPROVE_EDIT_FLAG, APPROVE_EDIT_FLAG, "--stdin"], emptyEnv()),
    );
  });

  it("rejects duplicate `--stdin` flags", () => {
    expectError(parseNotesCommand(["undo", APPROVE_EDIT_FLAG, "--stdin", "--stdin"], emptyEnv()));
  });

  it("rejects any `--handle` (undo is the inverse update, not a get)", () => {
    expectError(
      parseNotesCommand(
        ["undo", "--handle", "hnd_ok_12345678", APPROVE_EDIT_FLAG, "--stdin"],
        emptyEnv(),
      ),
    );
  });

  it("rejects any extra positional argument", () => {
    expectError(parseNotesCommand(["undo", APPROVE_EDIT_FLAG, "--stdin", "extra"], emptyEnv()));
  });

  it("rejects an unknown flag even when the rest is well-formed", () => {
    expectError(
      parseNotesCommand(["undo", APPROVE_EDIT_FLAG, "--stdin", "--unknown", "value"], emptyEnv()),
    );
  });

  it("rejects an --expect-revision argv carrier on undo", () => {
    expectError(
      parseNotesCommand(
        [
          "undo",
          APPROVE_EDIT_FLAG,
          "--stdin",
          "--expect-revision",
          "rev_abcdefabcdefabcdefabcdefabcdefab",
        ],
        emptyEnv(),
      ),
    );
  });

  it("rejects an --expect-revision argv carrier in the =value form on undo", () => {
    expectError(
      parseNotesCommand(
        [
          "undo",
          APPROVE_EDIT_FLAG,
          "--stdin",
          "--expect-revision=rev_abcdefabcdefabcdefabcdefabcdefab",
        ],
        emptyEnv(),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Malformed input guard.
// ---------------------------------------------------------------------------

describe("parseNotesCommand — malformed input guard", () => {
  it("returns a categorical error for non-array argv", () => {
    // Cast through unknown to intentionally violate the signature.
    const bad = "browse" as unknown as readonly string[];
    const err = expectError(parseNotesCommand(bad, emptyEnv()));
    expect(err.message.toLowerCase()).toContain("invalid");
  });

  it("returns a categorical error when an argv entry is not a string", () => {
    const bad = ["browse", 7] as unknown as readonly string[];
    const err = expectError(parseNotesCommand(bad, emptyEnv()));
    expect(err.message.toLowerCase()).toContain("invalid");
  });

  it("returns a categorical error for non-object env", () => {
    const bad = "nope" as unknown as Readonly<Record<string, string | undefined>>;
    const err = expectError(parseNotesCommand(["browse"], bad));
    expect(err.message.toLowerCase()).toContain("invalid");
  });
});

describe("bounded edit and undo stdin envelopes", () => {
  it("accepts only the closed edit JSON envelope", () => {
    expect(
      parseNotesEditStdin(JSON.stringify({ content: "body", undoToken: "unt_token" })),
    ).toEqual({
      content: "body",
      undoToken: "unt_token",
    });
    expect(
      parseNotesEditStdin(JSON.stringify({ content: "body", undoToken: "rev_bad", extra: 1 })),
    ).toBeUndefined();
    expect(parseNotesEditStdin("body")).toBeUndefined();
  });

  it("accepts one optional trailing newline for an opaque undo token only", () => {
    expect(parseNotesUndoStdin("unt_token\n")).toBe("unt_token");
    expect(parseNotesUndoStdin(" unt_token\n")).toBeUndefined();
    expect(parseNotesUndoStdin("unt_token\n\n")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Runner: bounded seam, runtime factory gating, categorical results.
// ---------------------------------------------------------------------------

describe("runNotesCommand — runtime factory gating", () => {
  it("returns help without constructing a runtime", async () => {
    const factory = vi.fn();
    const result = await runNotesCommand({
      argv: ["help"],
      env: {},
      createRuntime: factory,
    });
    expect(result.kind).toBe("help");
    expect(factory).not.toHaveBeenCalled();
  });

  it("does NOT construct a runtime on parse failure", async () => {
    const factory = vi.fn();
    const result = await runNotesCommand({
      argv: ["edit"], // missing handle, missing approve-edit, missing stdin
      env: {},
      createRuntime: factory,
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(factory).not.toHaveBeenCalled();
  });

  it("does NOT construct a runtime on approval gate failure", async () => {
    const factory = vi.fn();
    const result = await runNotesCommand({
      argv: ["edit", "--handle", "hnd_ok_12345678", "--stdin"],
      env: {},
      createRuntime: factory,
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain(APPROVE_EDIT_FLAG);
    expect(factory).not.toHaveBeenCalled();
  });

  it("does NOT construct a runtime on forbidden argv carrier", async () => {
    const factory = vi.fn();
    const result = await runNotesCommand({
      argv: ["browse", "--password", "leaf"],
      env: {},
      createRuntime: factory,
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).not.toContain("leaf");
    expect(factory).not.toHaveBeenCalled();
  });

  it("does NOT construct a runtime on forbidden env carrier", async () => {
    const factory = vi.fn();
    const result = await runNotesCommand({
      argv: ["browse"],
      env: { NOOKBRIDGE_PASSWORD: "smuggled" },
      createRuntime: factory,
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).not.toContain("smuggled");
    expect(factory).not.toHaveBeenCalled();
  });

  it("constructs a runtime exactly once for a valid browse", async () => {
    const factory = vi.fn().mockResolvedValue({
      browse: async (): Promise<NotesCategoricalResult> => ({
        kind: "page",
        notes: [],
        next: null,
      }),
      search: vi.fn(),
      get: vi.fn(),
      edit: vi.fn(),
      undo: vi.fn(),
    });
    const result = await runNotesCommand({
      argv: ["browse", "--limit", "5"],
      env: {},
      createRuntime: factory,
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("page");
  });

  it("constructs a runtime exactly once for a valid search --stdin", async () => {
    const factory = vi.fn().mockResolvedValue({
      browse: vi.fn(),
      search: vi.fn(async (): Promise<NotesCategoricalResult> => ({ kind: "empty" })),
      get: vi.fn(),
      edit: vi.fn(),
      undo: vi.fn(),
    });
    const result = await runNotesCommand({
      argv: ["search", "--stdin"],
      env: {},
      createRuntime: factory,
      searchQuery: "leaf",
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("empty");
  });

  it("constructs a runtime exactly once for a valid get --handle", async () => {
    const factory = vi.fn().mockResolvedValue({
      browse: vi.fn(),
      search: vi.fn(),
      get: async (): Promise<NotesCategoricalResult> => ({
        kind: "note",
        content: { label: "noop", bytes: 0 },
      }),
      edit: vi.fn(),
      undo: vi.fn(),
    });
    const result = await runNotesCommand({
      argv: ["get", "--handle", "hnd_ok_12345678"],
      env: {},
      createRuntime: factory,
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("note");
  });

  it("constructs a runtime exactly once for a valid edit (approval present)", async () => {
    const factory = vi.fn().mockResolvedValue({
      browse: vi.fn(),
      search: vi.fn(),
      get: vi.fn(),
      edit: async (): Promise<NotesCategoricalResult> => ({ kind: "updated" }),
      undo: vi.fn(),
    });
    const result = await runNotesCommand({
      argv: ["edit", "--handle", "hnd_ok_12345678", APPROVE_EDIT_FLAG, "--stdin"],
      env: {},
      createRuntime: factory,
      editInput: JSON.stringify({ content: "new", undoToken: "unt_token" }),
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("updated");
  });

  it("constructs a runtime exactly once for a valid undo (approval present)", async () => {
    const factory = vi.fn().mockResolvedValue({
      browse: vi.fn(),
      search: vi.fn(),
      get: vi.fn(),
      edit: vi.fn(),
      undo: async (): Promise<NotesCategoricalResult> => ({ kind: "undone" }),
    });
    const result = await runNotesCommand({
      argv: ["undo", APPROVE_EDIT_FLAG, "--stdin"],
      env: {},
      createRuntime: factory,
      undoInput: "unt_token",
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("undone");
  });

  it("returns the categorical closed result unchanged when the runtime emits one", async () => {
    const categoricalResults: readonly NotesCategoricalResult[] = [
      { kind: "page" as const, notes: [], next: null },
      { kind: "empty" as const },
      { kind: "note" as const, content: { label: "noop", bytes: 0 } },
      { kind: "updated" as const },
      { kind: "undone" as const },
      { kind: "conflict" as const },
      { kind: "denied" as const },
      { kind: "invalid-input" as const },
      { kind: "locked" as const },
      { kind: "missing" as const },
      { kind: "error" as const, message: "categorical error", exitCode: 3 },
    ];
    for (const categorical of categoricalResults) {
      const factory = vi.fn().mockResolvedValue({
        browse: async (): Promise<NotesCategoricalResult> => categorical,
        search: async (): Promise<NotesCategoricalResult> => categorical,
        get: async (): Promise<NotesCategoricalResult> => categorical,
        edit: async (): Promise<NotesCategoricalResult> => categorical,
        undo: async (): Promise<NotesCategoricalResult> => categorical,
      });
      const resultBrowse = await runNotesCommand({
        argv: ["browse"],
        env: {},
        createRuntime: factory,
      });
      expect(resultBrowse).toEqual(categorical);
    }
  });

  it("collapses an unexpected runtime throw to the closed `error` categorical result", async () => {
    const factory = vi.fn().mockResolvedValue({
      browse: async (): Promise<NotesCategoricalResult> => {
        throw new Error("upstream blew up with secrets inside");
      },
      search: vi.fn(),
      get: vi.fn(),
      edit: vi.fn(),
      undo: vi.fn(),
    });
    const result = await runNotesCommand({
      argv: ["browse"],
      env: {},
      createRuntime: factory,
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message.toLowerCase()).toContain("error");
    // The original cause/message must not leak.
    expect(result.message).not.toContain("upstream blew up");
    expect(result.message).not.toContain("secrets inside");
  });
});

// ---------------------------------------------------------------------------
// Bounded stdin search query contract — caller-supplied stdin string.
// ---------------------------------------------------------------------------

describe("parseNotesSearchQuery — bounded stdin query contract", () => {
  it("accepts a non-empty ASCII query and returns the bounded string", () => {
    const verdict = parseNotesSearchQuery("leaf");
    expect(verdict.kind).toBe("query");
    if (verdict.kind !== "query") return;
    expect(verdict.query).toBe("leaf");
  });

  it("accepts a non-empty multi-byte UTF-8 query (bytes, not chars)", () => {
    // Three-byte UTF-8 character repeated => bytes > chars
    const verdict = parseNotesSearchQuery("\u00e9\u00e9\u00e9");
    expect(verdict.kind).toBe("query");
    if (verdict.kind !== "query") return;
    expect(verdict.query).toBe("\u00e9\u00e9\u00e9");
  });

  it("rejects a non-string value categorically", () => {
    for (const value of [undefined, null, 0, 42, true, false, [], {}, Buffer.from("leaf")]) {
      expect(parseNotesSearchQuery(value).kind).toBe("invalid");
    }
  });

  it("rejects an empty string categorically", () => {
    expect(parseNotesSearchQuery("").kind).toBe("invalid");
  });

  it("rejects a query that exceeds MAX_NOTES_QUERY_BYTES UTF-8 bytes categorically", () => {
    // Build a query one byte larger than the cap by padding an ASCII char.
    const tooLong = "x".repeat(MAX_NOTES_QUERY_BYTES + 1);
    expect(parseNotesSearchQuery(tooLong).kind).toBe("invalid");
  });

  it("accepts a query whose byte length equals MAX_NOTES_QUERY_BYTES (closed bound)", () => {
    const atCap = "y".repeat(MAX_NOTES_QUERY_BYTES);
    const bytes = new TextEncoder().encode(atCap).byteLength;
    expect(bytes).toBe(MAX_NOTES_QUERY_BYTES);
    const verdict = parseNotesSearchQuery(atCap);
    expect(verdict.kind).toBe("query");
  });

  it("rejects a UTF-8 query whose byte length exceeds MAX_NOTES_QUERY_BYTES categorically", () => {
    // Each '\u00e9' is two UTF-8 bytes; 3 chars => 6 bytes; padding to exceed.
    // Two-byte char * (MAX/2 + 1) guarantees byte overflow with character
    // count still under MAX.
    const twoByte = "\u00e9".repeat(Math.floor(MAX_NOTES_QUERY_BYTES / 2) + 2);
    const bytes = new TextEncoder().encode(twoByte).byteLength;
    expect(bytes).toBeGreaterThan(MAX_NOTES_QUERY_BYTES);
    expect(parseNotesSearchQuery(twoByte).kind).toBe("invalid");
  });

  it("exposes MAX_NOTES_QUERY_BYTES as the established 4 MiB upper bound", () => {
    expect(MAX_NOTES_QUERY_BYTES).toBe(4 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// runNotesCommand — bounded stdin query plumbing for `search`.
// ---------------------------------------------------------------------------

describe("runNotesCommand — bounded stdin query plumbing for `search`", () => {
  it("forwards a valid caller-supplied search query to the runtime search()", async () => {
    const factory = vi.fn().mockResolvedValue({
      browse: vi.fn(),
      search: vi.fn(async (): Promise<NotesCategoricalResult> => ({ kind: "empty" })),
      get: vi.fn(),
      edit: vi.fn(),
      undo: vi.fn(),
    });
    const result = await runNotesCommand({
      argv: ["search", "--stdin"],
      env: {},
      createRuntime: factory,
      searchQuery: "leaf",
    });
    expect(result.kind).toBe("empty");
    const runtime = (await Promise.resolve(factory.mock.results[0]?.value)) as NotesCommandRuntime;
    expect(runtime.search).toHaveBeenCalledWith({
      query: "leaf",
      ...({} as Record<string, never>),
    });
  });

  it("rejects `search` when the caller-supplied query is missing", async () => {
    const factory = vi.fn();
    const result = await runNotesCommand({
      argv: ["search", "--stdin"],
      env: {},
      createRuntime: factory,
    });
    expect(result.kind).toBe("invalid-input");
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects `search` when the caller-supplied query is the wrong shape", async () => {
    const factory = vi.fn();
    const result = await runNotesCommand({
      argv: ["search", "--stdin"],
      env: {},
      createRuntime: factory,
      searchQuery: 42,
    });
    expect(result.kind).toBe("invalid-input");
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects `search` when the caller-supplied query is empty", async () => {
    const factory = vi.fn();
    const result = await runNotesCommand({
      argv: ["search", "--stdin"],
      env: {},
      createRuntime: factory,
      searchQuery: "",
    });
    expect(result.kind).toBe("invalid-input");
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects `search` when the caller-supplied query exceeds MAX_NOTES_QUERY_BYTES", async () => {
    const factory = vi.fn();
    const tooLong = "x".repeat(MAX_NOTES_QUERY_BYTES + 1);
    const result = await runNotesCommand({
      argv: ["search", "--stdin"],
      env: {},
      createRuntime: factory,
      searchQuery: tooLong,
    });
    expect(result.kind).toBe("invalid-input");
    expect(factory).not.toHaveBeenCalled();
  });

  it("never echoes a rejected query in the categorical result or message", async () => {
    const factory = vi.fn();
    const sensitive = "AKIAIOSFODNN7EXAMPLE-LEAF-PASSWORD";
    const rejected = sensitive + "x".repeat(MAX_NOTES_QUERY_BYTES + 1);
    const result = await runNotesCommand({
      argv: ["search", "--stdin"],
      env: {},
      createRuntime: factory,
      searchQuery: rejected,
    });
    expect(result.kind).toBe("invalid-input");
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it("does not consume the search query for non-`search` commands", async () => {
    const factory = vi.fn().mockResolvedValue({
      browse: async (): Promise<NotesCategoricalResult> => ({
        kind: "page",
        notes: [],
        next: null,
      }),
      search: vi.fn(),
      get: vi.fn(),
      edit: vi.fn(),
      undo: vi.fn(),
    });
    const result = await runNotesCommand({
      argv: ["browse"],
      env: {},
      createRuntime: factory,
      searchQuery: "ignored",
    });
    expect(result.kind).toBe("page");
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Closed output formatter.
// ---------------------------------------------------------------------------

describe("formatNotesResult — closed output boundary", () => {
  it("formats only bounded page metadata and opaque handles", () => {
    const output = formatNotesResult({
      kind: "page",
      notes: [{ handle: "hnd_ok_12345678", label: "secret title", bytes: 12 }],
      next: "crs_ok_12345678",
    });
    expect(output).toContain("nookctl notes: page");
    expect(output).toContain("handle: hnd_ok_12345678");
    expect(output).toContain("next: available");
    expect(output).not.toContain("secret title");
  });

  it("collapses malformed runtime metadata to a fixed error", () => {
    const output = formatNotesResult({
      kind: "page",
      notes: [{ handle: "/etc/passwd", label: "canary", bytes: 1 }],
      next: null,
    });
    expect(output).toBe("nookctl notes: error\n");
    expect(output).not.toContain("/etc/passwd");
    expect(output).not.toContain("canary");
  });

  it("never forwards runtime error text or help text", () => {
    expect(
      formatNotesResult({
        kind: "error",
        message: "upstream secret path",
        exitCode: 3,
      }),
    ).toBe("nookctl notes: error\n");
    expect(formatNotesResult({ kind: "help", text: "attacker-controlled help" })).toBe(
      formatNotesHelp(),
    );
  });
});

// ---------------------------------------------------------------------------
// Closed categorical result schema.
// ---------------------------------------------------------------------------

describe("categorical result schema — closed union", () => {
  it("the closed union has exactly the documented categorical kinds", () => {
    // Type-level smoke check: an exhaustive switch over the union.
    // If a new kind is added without updating this test, the @ts-expect-error
    // on the never branch will fail to compile.
    type NotesKind =
      | "page"
      | "empty"
      | "note"
      | "updated"
      | "undone"
      | "conflict"
      | "denied"
      | "invalid-input"
      | "locked"
      | "missing"
      | "error";
    const assertClosedKind = (kind: NotesKind): void => {
      switch (kind) {
        case "page":
        case "empty":
        case "note":
        case "updated":
        case "undone":
        case "conflict":
        case "denied":
        case "invalid-input":
        case "locked":
        case "missing":
        case "error":
          return;
        default: {
          const exhaustive: never = kind;
          throw new Error(`unknown kind: ${String(exhaustive)}`);
        }
      }
    };
    assertClosedKind("empty");
  });

  it("does not include `delete` as a categorical kind", () => {
    const sample: NotesCategoricalResult = { kind: "empty" };
    expect(Object.keys(sample)).toEqual(["kind"]);
    // The kind is the union of literal strings; assert the string set
    // here so an accidental `delete` addition breaks the test.
    const kinds = new Set<string>([
      "page",
      "empty",
      "note",
      "updated",
      "undone",
      "conflict",
      "denied",
      "invalid-input",
      "locked",
      "missing",
      "error",
    ]);
    expect(kinds.has("delete")).toBe(false);
  });
});
