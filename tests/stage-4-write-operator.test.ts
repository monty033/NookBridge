/**
 * Stage 4 §6 — offline tests for the gated operator write acceptance path.
 *
 * Nothing in this suite touches the network, a real credential, a TTY, or the
 * real `@notesnook/core` package.  The "database" is a deterministic
 * in-memory fake that models the PINNED upstream collection API the write
 * chain consumes:
 *
 *   Notes.add, Notes.collection.update, Notes.addToNotebook,
 *   Notes.removeFromNotebook, Content.add, Content.findByNoteId,
 *   Content.updateByNoteId, Notebooks.exists, Notebooks.notes,
 *   Tags.tag, Tags.add, Relations.add, Relations.unlink, Relations.from
 *
 * Modelling the real shapes (rather than stubbing the seam) is deliberate:
 * the assertions below exercise the production
 * `projectLiveDatabaseToWriteCapability` →
 * `bindNotesnookWriteRuntime` → `NotesnookWriteAdapter` →
 * `NotesnookLocalWriteComposition` chain end to end.
 */

import { readFileSync } from "node:fs";
import { dirname as dirnameOf, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  formatWriteCommandResult,
  formatWriteHelp,
  LIVE_WRITE_ENABLE_ENV,
  parseWriteCommand,
  runWriteCommand,
  type NotesnookLiveWriteCapability,
  type NotesnookLiveWriteRuntime,
} from "../src/core/notesnook-write-admin.js";
import {
  createLiveLocalWriteComposition,
  hasLiveWriteSurface,
  projectLiveDatabaseToWriteCapability,
} from "../src/core/notesnook-live-write-capability.js";
import { DETERMINISTIC_MARKDOWN_CODEC } from "../src/core/notesnook-write-codec.js";
import { createRevisionToken } from "../src/core/notesnook-write-contract.js";

// ---------------------------------------------------------------------------
// Pinned-API in-memory database fake.
// ---------------------------------------------------------------------------

type FakeNote = {
  id: string;
  title: string;
  contentId?: string;
  notebookId?: string;
  pinned: boolean;
  favorite: boolean;
  conflicted: boolean;
  locked: boolean;
  dateEdited: number;
  tags?: readonly string[];
};

type FakeContent = { id: string; noteId: string; type: "tiptap" | "tiny"; data: string };

type FakeRelation = { fromId: string; fromType: string; toId: string; toType: string };

type FakeDatabase = {
  readonly db: object;
  readonly notesById: Map<string, FakeNote>;
  readonly contentByNoteId: Map<string, FakeContent>;
  readonly relations: FakeRelation[];
  readonly calls: string[];
};

function createFakeDatabase(
  seed?: Readonly<{
    notes?: readonly FakeNote[];
    content?: readonly FakeContent[];
    notebooks?: readonly string[];
    tags?: ReadonlyArray<{ id: string; title: string }>;
  }>,
): FakeDatabase {
  const notesById = new Map<string, FakeNote>();
  const contentByNoteId = new Map<string, FakeContent>();
  const notebooks = new Set<string>(seed?.notebooks ?? []);
  const tags = new Map<string, string>();
  const relations: FakeRelation[] = [];
  const calls: string[] = [];
  let nextId = 1;

  for (const note of seed?.notes ?? []) notesById.set(note.id, { ...note });
  for (const content of seed?.content ?? []) contentByNoteId.set(content.noteId, { ...content });
  for (const tag of seed?.tags ?? []) tags.set(tag.id, tag.title);

  const mint = (prefix: string): string => `${prefix}-${nextId++}`;

  const notes = {
    note: async (id: string): Promise<FakeNote | undefined> => {
      calls.push("notes.note");
      const found = notesById.get(id);
      return found === undefined ? undefined : { ...found };
    },
    add: async (item: { title: string; content?: FakeContent }): Promise<string> => {
      calls.push("notes.add");
      const id = mint("note");
      notesById.set(id, {
        id,
        title: item.title,
        pinned: false,
        favorite: false,
        conflicted: false,
        locked: false,
        dateEdited: 1_000,
      });
      if (item.content !== undefined) {
        const contentId = mint("content");
        contentByNoteId.set(id, {
          id: contentId,
          noteId: id,
          type: item.content.type,
          data: item.content.data,
        });
        const stored = notesById.get(id) as FakeNote;
        stored.contentId = contentId;
      }
      return id;
    },
    addToNotebook: async (notebookId: string, ...noteIds: string[]): Promise<void> => {
      calls.push("notes.addToNotebook");
      for (const noteId of noteIds) {
        const note = notesById.get(noteId);
        if (note !== undefined) note.notebookId = notebookId;
      }
    },
    removeFromNotebook: async (_notebookId: string, ...noteIds: string[]): Promise<void> => {
      calls.push("notes.removeFromNotebook");
      for (const noteId of noteIds) {
        const note = notesById.get(noteId);
        if (note !== undefined) delete note.notebookId;
      }
    },
    collection: {
      update: async (ids: readonly string[], partial: Record<string, unknown>): Promise<void> => {
        calls.push("notes.collection.update");
        for (const id of ids) {
          const note = notesById.get(id);
          if (note === undefined) continue;
          if (typeof partial.title === "string") note.title = partial.title;
          if (typeof partial.pinned === "boolean") note.pinned = partial.pinned;
          if (typeof partial.favorite === "boolean") note.favorite = partial.favorite;
          if (typeof partial.notebookId === "string") note.notebookId = partial.notebookId;
          if (Array.isArray(partial.tags))
            note.tags = Object.freeze([...(partial.tags as string[])]);
          note.dateEdited += 1;
        }
      },
    },
  };

  const content = {
    add: async (partial: Record<string, unknown>): Promise<string> => {
      calls.push("content.add");
      const id = mint("content");
      const noteId = partial.noteId as string;
      contentByNoteId.set(noteId, {
        id,
        noteId,
        type: (partial.type as "tiptap" | "tiny") ?? "tiptap",
        data: (partial.data as string) ?? "",
      });
      return id;
    },
    findByNoteId: async (noteId: string): Promise<FakeContent | undefined> => {
      calls.push("content.findByNoteId");
      const found = contentByNoteId.get(noteId);
      return found === undefined ? undefined : { ...found };
    },
    updateByNoteId: async (partial: Record<string, unknown>, ...ids: string[]): Promise<void> => {
      calls.push("content.updateByNoteId");
      for (const noteId of ids) {
        const existing = contentByNoteId.get(noteId);
        if (existing === undefined) continue;
        if (typeof partial.data === "string") existing.data = partial.data;
        if (partial.type === "tiptap" || partial.type === "tiny") existing.type = partial.type;
      }
    },
  };

  const notebooksCollection = {
    exists: async (id: string): Promise<boolean> => {
      calls.push("notebooks.exists");
      return notebooks.has(id);
    },
    notes: async (_id: string): Promise<readonly string[]> => {
      calls.push("notebooks.notes");
      return [];
    },
  };

  const tagsCollection = {
    tag: async (id: string): Promise<{ id: string; title: string } | undefined> => {
      calls.push("tags.tag");
      const title = tags.get(id);
      return title === undefined ? undefined : { id, title };
    },
    add: async (input: { title: string }): Promise<string> => {
      calls.push("tags.add");
      const id = mint("tag");
      tags.set(id, input.title);
      return id;
    },
  };

  const relationsCollection = {
    add: async (
      from: { id: string; type: string },
      to: { id: string; type: string },
    ): Promise<void> => {
      calls.push("relations.add");
      relations.push({ fromId: from.id, fromType: from.type, toId: to.id, toType: to.type });
    },
    unlink: async (
      from: { id: string; type: string },
      to: { id: string; type: string },
    ): Promise<void> => {
      calls.push("relations.unlink");
      const index = relations.findIndex(
        (relation) =>
          relation.fromId === from.id && relation.toId === to.id && relation.toType === to.type,
      );
      if (index !== -1) relations.splice(index, 1);
    },
    from: (reference: { id?: string; type: string }) => {
      calls.push("relations.from");
      return {
        get: async (): Promise<readonly FakeRelation[]> =>
          relations.filter((relation) => relation.fromId === reference.id).map((r) => ({ ...r })),
      };
    },
  };

  // The fake carries extra slots (`user`, `kv`, `syncer`) precisely so the
  // production projection can be shown NOT to forward them.
  const db = {
    notes,
    content,
    notebooks: notebooksCollection,
    tags: tagsCollection,
    relations: relationsCollection,
    user: { authenticatePassword: async () => undefined },
    kv: () => ({ read: async () => undefined }),
    syncer: { start: async () => true },
  };

  return { db, notesById, contentByNoteId, relations, calls };
}

const ENABLED_ENV = Object.freeze({ [LIVE_WRITE_ENABLE_ENV]: "1" });

function noopEnsureOpen(): void {
  // Lifecycle is open for every offline test unless a case overrides it.
}

function capabilityFor(fake: FakeDatabase): NotesnookLiveWriteCapability {
  return projectLiveDatabaseToWriteCapability(fake.db, noopEnsureOpen);
}

function runtimeFor(
  fake: FakeDatabase,
  cleanup?: () => void | Promise<void>,
): NotesnookLiveWriteRuntime {
  return {
    capability: capabilityFor(fake),
    ...(cleanup === undefined ? {} : { cleanup }),
  };
}

// ---------------------------------------------------------------------------
// Parser and gate.
// ---------------------------------------------------------------------------

describe("nookctl write — parser", () => {
  it("renders help without any gate", () => {
    const parsed = parseWriteCommand(["help"], {});
    expect(parsed).toEqual({ kind: "parsed", command: { kind: "help", subcommand: "help" } });
    expect(parseWriteCommand([], {}).kind).toBe("parsed");
    expect(formatWriteHelp()).toContain("nookctl write");
    expect(formatWriteHelp()).toContain(LIVE_WRITE_ENABLE_ENV);
  });

  it("rejects an unknown subcommand with exit code 2", () => {
    const parsed = parseWriteCommand(["delete"], {});
    expect(parsed).toMatchObject({ kind: "error", exitCode: 2 });
  });

  it("accepts a bounded create command", () => {
    expect(parseWriteCommand(["create", "--title", "Acceptance"], {})).toEqual({
      kind: "parsed",
      command: { kind: "create", subcommand: "create", title: "Acceptance" },
    });
    expect(parseWriteCommand(["create", "--title=Acceptance", "--notebook-id=nb-1"], {})).toEqual({
      kind: "parsed",
      command: {
        kind: "create",
        subcommand: "create",
        title: "Acceptance",
        notebookId: "nb-1",
      },
    });
  });

  it("rejects malformed create input", () => {
    for (const argv of [
      ["create"],
      ["create", "--title"],
      ["create", "--title", ""],
      ["create", "--title", "a", "--title", "b"],
      ["create", "--title", "a", "--unknown", "x"],
      ["create", "--title", "a", "--notebook-id", "not a valid id"],
      ["create", "--title", `${"x".repeat(300)}`],
      ["create", "--title", "line\u0000break"],
    ]) {
      expect(parseWriteCommand(argv, {}), argv.join(" ")).toMatchObject({
        kind: "error",
        exitCode: 2,
      });
    }
  });

  it("requires a well-formed opaque revision token for append and update", () => {
    const token = createRevisionToken({ id: "note-1", dateEdited: 5 });
    expect(
      parseWriteCommand(["append", "--note-id", "note-1", "--expect-revision", token], {}),
    ).toEqual({
      kind: "parsed",
      command: {
        kind: "append",
        subcommand: "append",
        noteId: "note-1",
        expectedRevision: token,
      },
    });
    for (const argv of [
      ["append", "--note-id", "note-1"],
      ["append", "--expect-revision", token],
      ["append", "--note-id", "note-1", "--expect-revision", "rev_nothex"],
      ["append", "--note-id", "note-1", "--expect-revision", "note-1"],
    ]) {
      expect(parseWriteCommand(argv, {}), argv.join(" ")).toMatchObject({
        kind: "error",
        exitCode: 2,
      });
    }
  });

  it("accepts exactly one allowlisted boolean field for update", () => {
    const token = createRevisionToken({ id: "note-1", dateEdited: 5 });
    expect(
      parseWriteCommand(
        ["update", "--note-id", "note-1", "--expect-revision", token, "--set-pinned", "true"],
        {},
      ),
    ).toEqual({
      kind: "parsed",
      command: {
        kind: "update",
        subcommand: "update",
        noteId: "note-1",
        expectedRevision: token,
        field: "pinned",
        value: true,
      },
    });
    for (const argv of [
      ["update", "--note-id", "note-1", "--expect-revision", token],
      ["update", "--note-id", "note-1", "--expect-revision", token, "--set-pinned", "yes"],
      [
        "update",
        "--note-id",
        "note-1",
        "--expect-revision",
        token,
        "--set-pinned",
        "true",
        "--set-favorite",
        "true",
      ],
      ["update", "--note-id", "note-1", "--expect-revision", token, "--set-deleted", "true"],
      ["update", "--note-id", "note-1", "--expect-revision", token, "--set-locked", "true"],
    ]) {
      expect(parseWriteCommand(argv, {}), argv.join(" ")).toMatchObject({
        kind: "error",
        exitCode: 2,
      });
    }
  });

  it("rejects every credential carrier in argv", () => {
    for (const flag of [
      "--email",
      "--username",
      "--password",
      "--passwd",
      "--mfa",
      "--totp",
      "--secret",
      "--stdin-secret",
      "--token",
      "--access-token",
      "--refresh-token",
    ]) {
      const bare = parseWriteCommand(["create", "--title", "a", flag], {});
      expect(bare).toMatchObject({ kind: "error", exitCode: 2 });
      const valued = parseWriteCommand(["create", "--title", "a", `${flag}=canary-secret`], {});
      expect(valued).toMatchObject({ kind: "error", exitCode: 2 });
      if (valued.kind === "error") {
        expect(valued.message).toContain(flag);
        expect(valued.message).not.toContain("canary-secret");
      }
    }
  });

  it("rejects every credential carrier in the environment without reading its value", () => {
    for (const name of [
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
    ]) {
      const result = parseWriteCommand(["create", "--title", "a"], {
        [name]: "canary-secret",
        [LIVE_WRITE_ENABLE_ENV]: "1",
      });
      expect(result).toMatchObject({ kind: "error", exitCode: 2 });
      if (result.kind === "error") {
        expect(result.message).toContain(name);
        expect(result.message).not.toContain("canary-secret");
      }
    }
  });

  it("refuses note content supplied through argv", () => {
    for (const flag of [
      "--content",
      "--body",
      "--markdown",
      "--fragment",
      "--text",
      "--file",
      "--content-file",
      "--stdin",
    ]) {
      const result = parseWriteCommand(["create", "--title", "a", `${flag}=CANARY-BODY-TEXT`], {});
      expect(result).toMatchObject({ kind: "error", exitCode: 2 });
      if (result.kind === "error") {
        expect(result.message).toContain(flag);
        expect(result.message).not.toContain("CANARY-BODY-TEXT");
      }
    }
  });
});

describe("nookctl write — gate and runtime-construction ordering", () => {
  it("is disabled by default with exit code 2 and never constructs the runtime", async () => {
    let constructed = 0;
    const result = await runWriteCommand({
      argv: ["create", "--title", "Acceptance"],
      env: {},
      createWriteRuntime: () => {
        constructed += 1;
        throw new Error("must not be constructed");
      },
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    if (result.kind === "error") expect(result.message).toContain(LIVE_WRITE_ENABLE_ENV);
    expect(constructed).toBe(0);
  });

  it("rejects a non-exact gate value", async () => {
    for (const value of ["", "0", "true", "yes", "1 ", " 1"]) {
      let constructed = 0;
      const result = await runWriteCommand({
        argv: ["create", "--title", "Acceptance"],
        env: { [LIVE_WRITE_ENABLE_ENV]: value },
        createWriteRuntime: () => {
          constructed += 1;
          throw new Error("must not be constructed");
        },
      });
      expect(result, value).toMatchObject({ kind: "error", exitCode: 2 });
      expect(constructed).toBe(0);
    }
  });

  it("never constructs the runtime for a parse failure, even when gated on", async () => {
    for (const argv of [
      ["delete"],
      ["create"],
      ["create", "--title", "a", "--password=hunter2"],
      ["append", "--note-id", "note-1", "--expect-revision", "bogus"],
    ]) {
      let constructed = 0;
      const result = await runWriteCommand({
        argv,
        env: ENABLED_ENV,
        createWriteRuntime: () => {
          constructed += 1;
          throw new Error("must not be constructed");
        },
      });
      expect(result, argv.join(" ")).toMatchObject({ kind: "error", exitCode: 2 });
      expect(constructed, argv.join(" ")).toBe(0);
    }
  });

  it("renders help without constructing the runtime and without the gate", async () => {
    let constructed = 0;
    const result = await runWriteCommand({
      argv: ["help"],
      env: {},
      createWriteRuntime: () => {
        constructed += 1;
        throw new Error("must not be constructed");
      },
    });
    expect(result.kind).toBe("help");
    expect(constructed).toBe(0);
  });

  it("reports a categorical error when no write capability is wired", async () => {
    const result = await runWriteCommand({
      argv: ["create", "--title", "Acceptance"],
      env: ENABLED_ENV,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
  });

  it("maps a runtime construction failure to exit code 3 without leaking the cause", async () => {
    const result = await runWriteCommand({
      argv: ["create", "--title", "Acceptance"],
      env: ENABLED_ENV,
      createWriteRuntime: () => {
        throw new Error("CANARY /var/state/db.key open failed");
      },
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 3 });
    if (result.kind === "error") {
      expect(result.message).not.toContain("CANARY");
      expect(result.message).not.toContain("db.key");
    }
  });

  it("constructs the runtime exactly once after the gate passes", async () => {
    const fake = createFakeDatabase();
    let constructed = 0;
    const result = await runWriteCommand({
      argv: ["create", "--title", "Acceptance"],
      env: ENABLED_ENV,
      createWriteRuntime: () => {
        constructed += 1;
        return runtimeFor(fake);
      },
    });
    expect(result.kind).toBe("report");
    expect(constructed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dispatch against the production projection chain.
// ---------------------------------------------------------------------------

describe("nookctl write — create/append/update dispatch", () => {
  it("creates a note through the pinned Notes.add + content path", async () => {
    const fake = createFakeDatabase();
    const result = await runWriteCommand({
      argv: ["create", "--title", "Acceptance"],
      env: ENABLED_ENV,
      createWriteRuntime: () => runtimeFor(fake),
    });
    expect(result).toMatchObject({
      kind: "report",
      subcommand: "create",
      report: {
        operation: "create",
        localCommitted: true,
        remoteSynced: false,
        pendingSync: true,
        pendingCount: 1,
      },
    });
    expect(fake.calls).toContain("notes.add");
    expect([...fake.notesById.values()].map((note) => note.title)).toEqual(["Acceptance"]);
    // The stored body is the codec output, not raw Markdown.
    const stored = [...fake.contentByNoteId.values()][0];
    expect(stored?.data).toContain("<p>");
  });

  it("attaches an allowlisted notebook on create and refuses an unknown one", async () => {
    const withNotebook = createFakeDatabase({ notebooks: ["nb-1"] });
    const ok = await runWriteCommand({
      argv: ["create", "--title", "Acceptance", "--notebook-id", "nb-1"],
      env: ENABLED_ENV,
      createWriteRuntime: () => runtimeFor(withNotebook),
    });
    expect(ok.kind).toBe("report");
    expect(withNotebook.calls).toContain("notebooks.exists");
    expect(withNotebook.calls).toContain("notes.addToNotebook");

    const withoutNotebook = createFakeDatabase();
    const failed = await runWriteCommand({
      argv: ["create", "--title", "Acceptance", "--notebook-id", "nb-missing"],
      env: ENABLED_ENV,
      createWriteRuntime: () => runtimeFor(withoutNotebook),
    });
    expect(failed).toMatchObject({ kind: "error", exitCode: 2 });
    if (failed.kind === "error") expect(failed.message).toContain("invalid input");
    expect(withoutNotebook.calls).not.toContain("notes.add");
  });

  it("appends exactly one fragment and preserves the existing stored bytes", async () => {
    const fake = createFakeDatabase({
      notes: [
        {
          id: "note-1",
          title: "Existing",
          contentId: "content-1",
          pinned: false,
          favorite: false,
          conflicted: false,
          locked: false,
          dateEdited: 42,
        },
      ],
      content: [{ id: "content-1", noteId: "note-1", type: "tiptap", data: "<p>original</p>" }],
    });
    const token = createRevisionToken({ id: "note-1", dateEdited: 42 });
    const result = await runWriteCommand({
      argv: ["append", "--note-id", "note-1", "--expect-revision", token],
      env: ENABLED_ENV,
      createWriteRuntime: () => runtimeFor(fake),
    });
    expect(result).toMatchObject({
      kind: "report",
      subcommand: "append",
      report: { operation: "append", localCommitted: true, remoteSynced: false, pendingSync: true },
    });
    const stored = fake.contentByNoteId.get("note-1");
    expect(stored?.data.startsWith("<p>original</p>")).toBe(true);
    expect(stored?.data.match(/<p>/g)?.length).toBe(2);
    expect(fake.calls).toContain("content.updateByNoteId");
  });

  it("rejects a stale revision before any mutation fires", async () => {
    const fake = createFakeDatabase({
      notes: [
        {
          id: "note-1",
          title: "Existing",
          pinned: false,
          favorite: false,
          conflicted: false,
          locked: false,
          dateEdited: 42,
        },
      ],
      content: [{ id: "content-1", noteId: "note-1", type: "tiptap", data: "<p>x</p>" }],
    });
    const stale = createRevisionToken({ id: "note-1", dateEdited: 41 });
    const result = await runWriteCommand({
      argv: ["append", "--note-id", "note-1", "--expect-revision", stale],
      env: ENABLED_ENV,
      createWriteRuntime: () => runtimeFor(fake),
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    if (result.kind === "error") expect(result.message).toContain("stale revision");
    expect(fake.calls).not.toContain("content.updateByNoteId");
    expect(fake.contentByNoteId.get("note-1")?.data).toBe("<p>x</p>");
  });

  it("refuses a vault-locked note without touching content", async () => {
    const fake = createFakeDatabase({
      notes: [
        {
          id: "note-1",
          title: "Locked",
          pinned: false,
          favorite: false,
          conflicted: false,
          locked: true,
          dateEdited: 42,
        },
      ],
    });
    const token = createRevisionToken({ id: "note-1", dateEdited: 42 });
    const result = await runWriteCommand({
      argv: ["append", "--note-id", "note-1", "--expect-revision", token],
      env: ENABLED_ENV,
      createWriteRuntime: () => runtimeFor(fake),
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    if (result.kind === "error") expect(result.message).toContain("vault locked");
    expect(fake.calls).not.toContain("content.findByNoteId");
  });

  it("refuses a conflicted note", async () => {
    const fake = createFakeDatabase({
      notes: [
        {
          id: "note-1",
          title: "Conflicted",
          pinned: false,
          favorite: false,
          conflicted: true,
          locked: false,
          dateEdited: 42,
        },
      ],
    });
    const token = createRevisionToken({ id: "note-1", dateEdited: 42 });
    const result = await runWriteCommand({
      argv: ["append", "--note-id", "note-1", "--expect-revision", token],
      env: ENABLED_ENV,
      createWriteRuntime: () => runtimeFor(fake),
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    if (result.kind === "error") expect(result.message).toContain("conflict");
  });

  it("applies an allowlisted boolean update through Notes.collection.update", async () => {
    const fake = createFakeDatabase({
      notes: [
        {
          id: "note-1",
          title: "Existing",
          pinned: false,
          favorite: false,
          conflicted: false,
          locked: false,
          dateEdited: 42,
        },
      ],
    });
    const token = createRevisionToken({ id: "note-1", dateEdited: 42 });
    const result = await runWriteCommand({
      argv: ["update", "--note-id", "note-1", "--expect-revision", token, "--set-pinned", "true"],
      env: ENABLED_ENV,
      createWriteRuntime: () => runtimeFor(fake),
    });
    expect(result).toMatchObject({
      kind: "report",
      subcommand: "update",
      report: { operation: "update", localCommitted: true, remoteSynced: false, pendingSync: true },
    });
    expect(fake.calls).toContain("notes.collection.update");
    const note = fake.notesById.get("note-1");
    expect(note?.pinned).toBe(true);
    // Fields outside the patch are untouched.
    expect(note?.favorite).toBe(false);
    expect(note?.title).toBe("Existing");
  });

  it("supports the favorite field and leaves pinned alone", async () => {
    const fake = createFakeDatabase({
      notes: [
        {
          id: "note-1",
          title: "Existing",
          pinned: true,
          favorite: false,
          conflicted: false,
          locked: false,
          dateEdited: 7,
        },
      ],
    });
    const token = createRevisionToken({ id: "note-1", dateEdited: 7 });
    const result = await runWriteCommand({
      argv: ["update", "--note-id", "note-1", "--expect-revision", token, "--set-favorite", "true"],
      env: ENABLED_ENV,
      createWriteRuntime: () => runtimeFor(fake),
    });
    expect(result.kind).toBe("report");
    expect(fake.notesById.get("note-1")?.favorite).toBe(true);
    expect(fake.notesById.get("note-1")?.pinned).toBe(true);
  });

  it("rejects a write against an unknown note", async () => {
    const fake = createFakeDatabase();
    const token = createRevisionToken({ id: "note-1", dateEdited: 1 });
    const result = await runWriteCommand({
      argv: ["append", "--note-id", "note-1", "--expect-revision", token],
      env: ENABLED_ENV,
      createWriteRuntime: () => runtimeFor(fake),
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
  });
});

// ---------------------------------------------------------------------------
// No auto-sync / pending semantics.
// ---------------------------------------------------------------------------

describe("nookctl write — no auto-sync and pending semantics", () => {
  it("never exposes a remote trigger on the write capability", () => {
    const fake = createFakeDatabase();
    const capability = capabilityFor(fake) as unknown as Record<string, unknown>;
    expect(Object.keys(capability).sort()).toEqual([
      "appendNote",
      "createNote",
      "pendingSnapshot",
      "updateNote",
    ]);
    for (const forbidden of [
      "requestSync",
      "sync",
      "send",
      "full",
      "force",
      "delete",
      "database",
      "db",
      "collection",
      "user",
      "kv",
      "tokenManager",
      "syncer",
      "vault",
      "vaultUnlock",
      "raw",
    ]) {
      expect(capability[forbidden], forbidden).toBeUndefined();
    }
    expect(Object.isFrozen(capability)).toBe(true);
  });

  it("reports pending rather than remote-synced and accumulates pending markers", async () => {
    const fake = createFakeDatabase();
    const capability = capabilityFor(fake);
    const runtime: NotesnookLiveWriteRuntime = { capability };
    const first = await runWriteCommand({
      argv: ["create", "--title", "First"],
      env: ENABLED_ENV,
      createWriteRuntime: () => runtime,
    });
    const second = await runWriteCommand({
      argv: ["create", "--title", "Second"],
      env: ENABLED_ENV,
      createWriteRuntime: () => runtime,
    });
    expect(first).toMatchObject({ report: { pendingCount: 1, remoteSynced: false } });
    expect(second).toMatchObject({ report: { pendingCount: 2, remoteSynced: false } });
    expect(capability.pendingSnapshot().pending.length).toBe(2);
  });

  it("never claims a remote outcome even if the capability fabricates one", async () => {
    const fake = createFakeDatabase();
    const honest = capabilityFor(fake);
    const lying: NotesnookLiveWriteCapability = Object.freeze({
      createNote: async () =>
        Object.freeze({
          operation: "create",
          id: "note-1",
          titleBytes: 1,
          contentBytes: 1,
          localCommitted: true,
          remoteSynced: true,
          pendingSync: false,
        }) as never,
      appendNote: honest.appendNote,
      updateNote: honest.updateNote,
      pendingSnapshot: honest.pendingSnapshot,
    });
    const result = await runWriteCommand({
      argv: ["create", "--title", "Acceptance"],
      env: ENABLED_ENV,
      createWriteRuntime: () => ({ capability: lying }),
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    if (result.kind === "error") expect(result.message).toContain("not recognised");
  });

  it("the composition's coordinator refuses remote execution in this slice", async () => {
    const fake = createFakeDatabase();
    const composition = createLiveLocalWriteComposition(fake.db);
    await composition.createNote({ title: "Acceptance", content: "body" });
    const remote = await composition.requestSync();
    // No live remote executor exists yet: the request must not report a
    // remote success, and the pending marker must survive.
    expect(remote.remoteSynced).toBe(false);
    expect(remote.status).toBe("failed");
    expect(composition.pendingSnapshot().pending.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Formatting and non-leakage.
// ---------------------------------------------------------------------------

describe("nookctl write — categorical formatting and non-leakage", () => {
  it("prints only categorical fields for a successful write", async () => {
    const fake = createFakeDatabase({ notebooks: ["nb-secret-id"] });
    const result = await runWriteCommand({
      argv: ["create", "--title", "CANARY-TITLE", "--notebook-id", "nb-secret-id"],
      env: ENABLED_ENV,
      createWriteRuntime: () => runtimeFor(fake),
    });
    expect(result.kind).toBe("report");
    const text = formatWriteCommandResult(result);
    expect(text).toContain("local:   committed");
    expect(text).toContain("remote:  pending");
    expect(text).toContain("pending: 1");
    for (const forbidden of [
      "CANARY-TITLE",
      "nb-secret-id",
      "note-1",
      "NookBridge Stage 4 acceptance note.",
      "<p>",
      "/var/state",
      "rev_",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("keeps every failure message free of ids, tokens, bodies, and causes", async () => {
    const fake = createFakeDatabase({
      notes: [
        {
          id: "note-secret",
          title: "CANARY-TITLE",
          pinned: false,
          favorite: false,
          conflicted: false,
          locked: true,
          dateEdited: 99,
        },
      ],
    });
    const token = createRevisionToken({ id: "note-secret", dateEdited: 99 });
    const result = await runWriteCommand({
      argv: ["append", "--note-id", "note-secret", "--expect-revision", token],
      env: ENABLED_ENV,
      createWriteRuntime: () => runtimeFor(fake),
    });
    const text = formatWriteCommandResult(result);
    expect(text).toContain("vault locked");
    for (const forbidden of ["note-secret", "CANARY-TITLE", token, "rev_"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("normalises a foreign throw from the capability without echoing it", async () => {
    const fake = createFakeDatabase();
    const honest = capabilityFor(fake);
    const hostile: NotesnookLiveWriteCapability = Object.freeze({
      createNote: async () => {
        const error = new Error("CANARY hunter2 /var/state/db.key");
        Object.defineProperty(error, "cause", { value: "CANARY-CAUSE" });
        throw error;
      },
      appendNote: honest.appendNote,
      updateNote: honest.updateNote,
      pendingSnapshot: honest.pendingSnapshot,
    });
    const result = await runWriteCommand({
      argv: ["create", "--title", "Acceptance"],
      env: ENABLED_ENV,
      createWriteRuntime: () => ({ capability: hostile }),
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    const text = formatWriteCommandResult(result);
    for (const forbidden of ["CANARY", "hunter2", "db.key", "CANARY-CAUSE"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("rejects an unrecognised pending snapshot", async () => {
    const fake = createFakeDatabase();
    const honest = capabilityFor(fake);
    const hostile: NotesnookLiveWriteCapability = Object.freeze({
      createNote: honest.createNote,
      appendNote: honest.appendNote,
      updateNote: honest.updateNote,
      pendingSnapshot: () => ({ pending: { nope: true } }) as never,
    });
    const result = await runWriteCommand({
      argv: ["create", "--title", "Acceptance"],
      env: ENABLED_ENV,
      createWriteRuntime: () => ({ capability: hostile }),
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    if (result.kind === "error") expect(result.message).toContain("pending state");
  });
});

// ---------------------------------------------------------------------------
// Cleanup.
// ---------------------------------------------------------------------------

describe("nookctl write — cleanup", () => {
  it("awaits cleanup on the success path", async () => {
    const fake = createFakeDatabase();
    const order: string[] = [];
    const result = await runWriteCommand({
      argv: ["create", "--title", "Acceptance"],
      env: ENABLED_ENV,
      createWriteRuntime: () =>
        runtimeFor(fake, async () => {
          await Promise.resolve();
          order.push("cleanup");
        }),
    });
    expect(result.kind).toBe("report");
    expect(order).toEqual(["cleanup"]);
  });

  it("awaits cleanup when the local write fails categorically", async () => {
    const fake = createFakeDatabase();
    let cleaned = 0;
    const token = createRevisionToken({ id: "note-1", dateEdited: 1 });
    const result = await runWriteCommand({
      argv: ["append", "--note-id", "note-1", "--expect-revision", token],
      env: ENABLED_ENV,
      createWriteRuntime: () =>
        runtimeFor(fake, () => {
          cleaned += 1;
        }),
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    expect(cleaned).toBe(1);
  });

  it("awaits cleanup when the capability throws unexpectedly", async () => {
    const fake = createFakeDatabase();
    const honest = capabilityFor(fake);
    let cleaned = 0;
    const result = await runWriteCommand({
      argv: ["create", "--title", "Acceptance"],
      env: ENABLED_ENV,
      createWriteRuntime: () => ({
        capability: Object.freeze({
          createNote: () => {
            throw new Error("boom");
          },
          appendNote: honest.appendNote,
          updateNote: honest.updateNote,
          pendingSnapshot: honest.pendingSnapshot,
        }) as unknown as NotesnookLiveWriteCapability,
        cleanup: () => {
          cleaned += 1;
        },
      }),
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    expect(cleaned).toBe(1);
  });

  it("maps a cleanup failure to exit code 3 without leaking the cause", async () => {
    const fake = createFakeDatabase();
    const result = await runWriteCommand({
      argv: ["create", "--title", "Acceptance"],
      env: ENABLED_ENV,
      createWriteRuntime: () =>
        runtimeFor(fake, () => {
          throw new Error("CANARY /var/state teardown");
        }),
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 3 });
    if (result.kind === "error") {
      expect(result.message).not.toContain("CANARY");
      expect(result.message).not.toContain("/var/state");
    }
  });
});

// ---------------------------------------------------------------------------
// Live projection boundary.
// ---------------------------------------------------------------------------

describe("Stage 4 live write capability projection", () => {
  it("detects the required collection surface", () => {
    expect(hasLiveWriteSurface(createFakeDatabase().db)).toBe(true);
    expect(hasLiveWriteSurface({ notes: {} })).toBe(false);
    expect(hasLiveWriteSurface(null)).toBe(false);
    expect(hasLiveWriteSurface("nope")).toBe(false);
  });

  it("fails closed when a collection slot is missing or hostile", () => {
    expect(() => createLiveLocalWriteComposition({ notes: {} })).toThrow();
    const hostile = {
      get notes(): never {
        throw new Error("CANARY hostile getter");
      },
      content: {},
      notebooks: {},
      tags: {},
      relations: {},
    };
    const failure = (() => {
      try {
        createLiveLocalWriteComposition(hostile);
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("CANARY");
  });

  it("honours the owning runtime lifecycle on every published method", async () => {
    const fake = createFakeDatabase();
    let closed = false;
    const capability = projectLiveDatabaseToWriteCapability(fake.db, () => {
      if (closed) throw new Error("closed");
    });
    await capability.createNote({ title: "Acceptance", content: "body" });
    closed = true;
    await expect(capability.createNote({ title: "Again", content: "body" })).rejects.toThrow();
    expect(() => capability.pendingSnapshot()).toThrow();
  });

  it("does not forward auth, kv, or syncer slots into the write chain", () => {
    const fake = createFakeDatabase();
    const capability = capabilityFor(fake) as unknown as Record<string, unknown>;
    const serialized = Object.keys(capability).join(",");
    expect(serialized).not.toContain("user");
    expect(serialized).not.toContain("kv");
    expect(serialized).not.toContain("syncer");
  });
});

// ---------------------------------------------------------------------------
// Deterministic production codec.
// ---------------------------------------------------------------------------

describe("Stage 4 deterministic markdown codec", () => {
  it("escapes every HTML-significant byte before adding markup", () => {
    const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(
      "<script>alert('x')</script> & \"quoted\"",
    );
    expect(encoded.type).toBe("tiptap");
    expect(encoded.data).not.toContain("<script>");
    expect(encoded.data).toContain("&lt;script&gt;");
    expect(encoded.data).toContain("&amp;");
    expect(encoded.data).toContain("&quot;");
    expect(encoded.data).toContain("&#39;");
  });

  it("renders the tiny supported block grammar deterministically", () => {
    expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("# Title").data).toBe("<h1>Title</h1>");
    expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("## Sub").data).toBe("<h2>Sub</h2>");
    expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("### Deep").data).toBe("<h3>Deep</h3>");
    expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- a\n- b").data).toBe(
      "<ul><li>a</li><li>b</li></ul>",
    );
    expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("one\ntwo").data).toBe(
      "<p>one<br />two</p>",
    );
    expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("a\n\nb").data).toBe("<p>a</p><p>b</p>");
    expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("").data).toBe("<p></p>");
    // Deterministic: identical input, identical output.
    expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("# T").data).toBe(
      DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("# T").data,
    );
  });

  it("preserves stored bytes verbatim and appends exactly one block", () => {
    const appended = DETERMINISTIC_MARKDOWN_CODEC.appendMarkdownToStoredContent({
      storedType: "html",
      storedData: "<p>kept &amp; intact</p>",
      markdownFragment: "added",
    });
    expect(appended.type).toBe("html");
    expect(appended.data).toBe("<p>kept &amp; intact</p><p>added</p>");
  });

  it("refuses non-strings, control characters, and over-long input", () => {
    expect(() => DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(42 as never)).toThrow();
    expect(() => DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("bad\u0000byte")).toThrow();
    expect(() => DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("x".repeat(300_000))).toThrow();
    expect(() =>
      DETERMINISTIC_MARKDOWN_CODEC.appendMarkdownToStoredContent({
        storedType: "pdf" as never,
        storedData: "x",
        markdownFragment: "y",
      }),
    ).toThrow();
    expect(() =>
      DETERMINISTIC_MARKDOWN_CODEC.appendMarkdownToStoredContent(null as never),
    ).toThrow();
  });

  it("keeps refusal messages free of the offending content", () => {
    const failure = (() => {
      try {
        DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("CANARY\u0000BODY");
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("CANARY");
    expect((failure as Error).cause).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Source-level boundary assertions.
// ---------------------------------------------------------------------------

describe("Stage 4 operator write source boundaries", () => {
  const here = dirnameOf(fileURLToPath(import.meta.url));
  const readSource = (relative: string): string =>
    readFileSync(joinPath(here, "..", relative), "utf8");

  /** Strip block/line comments so assertions test code, not prose. */
  const codeOnly = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the operator module never triggers remote synchronization", () => {
    const source = codeOnly(readSource("src/core/notesnook-write-admin.ts"));
    expect(source).not.toMatch(/\brequestSync\s*\(/);
    expect(source).not.toMatch(/type:\s*"(full|send)"/);
    expect(source).not.toContain("requestSync");
  });

  it("the write capability module imports no Notesnook package", () => {
    const source = codeOnly(readSource("src/core/notesnook-live-write-capability.ts"));
    expect(source).not.toContain("@notesnook/");
    expect(source).not.toContain("better-sqlite3");
    // No raw database is published from the capability module.
    expect(source).not.toMatch(/return\s+database/);
  });

  it("the codec module adds no dependency beyond node:buffer", () => {
    const source = readSource("src/core/notesnook-write-codec.ts");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual([
      "./notesnook-write-adapter.js",
      "./notesnook-write-contract.js",
      "node:buffer",
    ]);
  });

  it("the Stage 3 read-only sync boundary is unchanged and still fetch-only", () => {
    const source = readSource("src/core/notesnook-sync-admin.ts");
    expect(source).not.toContain("notesnook-write-admin");
    expect(source).not.toContain("localWrite");
    const projection = readSource("src/core/notesnook-readonly-projection.ts");
    expect(projection).not.toContain("notesnook-write");
  });
});
