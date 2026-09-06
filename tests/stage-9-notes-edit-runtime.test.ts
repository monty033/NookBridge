import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { createNotesEditRuntime } from "../src/operator/notes-edit-runtime.js";
import {
  createAesGcmCipher,
  createNotesUndoJournal,
  type NotesUndoJournalStore,
} from "../src/operator/notes-undo-journal.js";

const HANDLE = "not_handle";
const TOKEN = "unt_token";
const REVISION_1 = `rev_${"1".repeat(32)}`;
const REVISION_2 = `rev_${"2".repeat(32)}`;
const REVISION_3 = `rev_${"3".repeat(32)}`;

type Fixture = {
  readonly source: {
    readonly state: { revision: string; title: string; content: string };
    readonly read: (handle: string) => Promise<
      | {
          handle: string;
          revision: string;
          title: string;
          content: string;
          metadata: Readonly<Record<string, string>>;
        }
      | undefined
    >;
    readonly nextRevision: () => string;
    readonly update: (command: {
      readonly handle: string;
      readonly expectedRevision: string;
      readonly title: string;
      readonly content: string;
      readonly metadata: Readonly<Record<string, string>>;
    }) => Promise<{ kind: "updated"; revision: string } | { kind: "conflict" }>;
  };
  readonly journal: ReturnType<typeof createNotesUndoJournal>;
  readonly raw: Map<string, Uint8Array>;
};

function fixture(): Fixture {
  const state = { revision: REVISION_1, title: "Title", content: "old" };
  const raw = new Map<string, Uint8Array>();
  const store: NotesUndoJournalStore = {
    async put(token, bytes) {
      raw.set(token, Uint8Array.from(bytes));
    },
    async get(token) {
      const bytes = raw.get(token);
      return bytes === undefined ? undefined : Uint8Array.from(bytes);
    },
    async remove(token) {
      raw.delete(token);
    },
  };
  const source = {
    state,
    async read(handle: string) {
      if (handle !== HANDLE) return undefined;
      return {
        handle,
        revision: state.revision,
        title: state.title,
        content: state.content,
        metadata: {},
      };
    },
    nextRevision: () => REVISION_2,
    async update(command: {
      readonly handle: string;
      readonly expectedRevision: string;
      readonly title: string;
      readonly content: string;
      readonly metadata: Readonly<Record<string, string>>;
    }) {
      if (command.handle !== HANDLE || command.expectedRevision !== state.revision)
        return { kind: "conflict" as const };
      state.revision = command.expectedRevision === REVISION_1 ? REVISION_2 : REVISION_3;
      state.title = command.title;
      state.content = command.content;
      return { kind: "updated" as const, revision: state.revision };
    },
  };
  return {
    source,
    journal: createNotesUndoJournal({
      store,
      cipher: createAesGcmCipher(Buffer.alloc(32)),
      tokenFactory: () => "unt_fallback",
    }),
    raw,
  };
}

describe("createNotesEditRuntime", () => {
  it("records an encrypted preimage, edits, and restores it with the supplied token", async () => {
    const f = fixture();
    const runtime = createNotesEditRuntime({
      source: f.source,
      journal: f.journal,
      now: () => 1000,
    });

    await expect(
      runtime.edit({ handle: HANDLE, content: "new", undoToken: TOKEN }),
    ).resolves.toEqual({ kind: "updated" });
    expect(f.source.state.content).toBe("new");
    expect(f.raw.get(TOKEN)?.toString()).not.toContain("old");

    await expect(runtime.undo({ token: TOKEN })).resolves.toEqual({ kind: "undone" });
    expect(f.source.state.content).toBe("old");
    expect(f.raw.has(TOKEN)).toBe(false);
  });

  it("refuses undo after a concurrent revision change and retains the journal entry", async () => {
    const f = fixture();
    const runtime = createNotesEditRuntime({
      source: f.source,
      journal: f.journal,
      now: () => 1000,
    });
    await runtime.edit({ handle: HANDLE, content: "new", undoToken: TOKEN });
    f.source.state.revision = REVISION_3;

    await expect(runtime.undo({ token: TOKEN })).resolves.toEqual({ kind: "conflict" });
    expect(f.raw.has(TOKEN)).toBe(true);
  });

  it("expires and cleans up the encrypted preimage", async () => {
    const f = fixture();
    let now = 1000;
    const runtime = createNotesEditRuntime({
      source: f.source,
      journal: f.journal,
      now: () => now,
      ttlMs: 10,
    });
    await runtime.edit({ handle: HANDLE, content: "new", undoToken: TOKEN });
    now = 1011;

    await expect(runtime.undo({ token: TOKEN })).resolves.toEqual({ kind: "missing" });
    expect(f.raw.has(TOKEN)).toBe(false);
  });
});
