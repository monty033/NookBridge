/**
 * A bodyless note (title, no content record) must be visible to discovery and
 * readable through `notes.get`, while a locked note whose content has merely
 * not arrived must stay hidden. These tests run the real projection (and, for
 * `notes.get`, the real live factory) over an in-memory fake core.
 */

import { describe, expect, it } from "vitest";

import {
  createNotesnookLiveCoreFactory,
  type NotesnookDatabaseSetupOptions,
  type NotesnookRealCoreModule,
} from "../src/index.js";
import { markRealCoreModule } from "../src/core/notesnook-core-adapter.js";
import { flattenLiveDatabaseToReadOnly } from "../src/core/notesnook-readonly-projection.js";
import { handleRpcRequest, type RpcHandlerRuntimeLike } from "../src/service/rpc-handler.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";
import { createDiscoveryVisibility } from "../src/service/discovery-visibility.js";
import { buildNotebookIndex } from "../src/settings/notebook-index.js";
import { createSettingsEvaluator } from "../src/settings/settings-evaluator.js";
import type { SettingsFile } from "../src/settings/settings-types.js";
import {
  LIVE_CONTENT,
  makeFakeCore,
  type FakeCoreOptions,
  type FakeNote,
} from "./helpers/bodyless-fake-core.js";

const NOTEBOOKS = [
  { id: "nb-pub", title: "Public" },
  { id: "nb-priv", title: "Private" },
];

const allowAll: SettingsFile = {
  version: 1,
  upload: "attributed",
  defaults: { read: true, edit: false, create: false, delete: false },
  overrides: [],
};

const allowPublicOnly: SettingsFile = {
  version: 1,
  upload: "attributed",
  defaults: { read: false, edit: false, create: false, delete: false },
  overrides: [{ notebooks: ["Public"], read: true }],
};

function visibilityOver(notes: readonly FakeNote[], settings: SettingsFile = allowAll) {
  const core = makeFakeCore({ notes, notebooks: NOTEBOOKS } satisfies FakeCoreOptions);
  const projection = flattenLiveDatabaseToReadOnly(core as never);
  return createDiscoveryVisibility({
    source: projection as never,
    listNotebooksForSettings: () => projection.listNotebooksWithParentsStrict!(),
    settingsEvaluator: createSettingsEvaluator(settings, buildNotebookIndex(NOTEBOOKS)),
  });
}

describe("bodyless notes in discovery", () => {
  it("6. a bodyless root note appears in searchHits and listNotes and isNoteVisible is true", async () => {
    const visibility = visibilityOver([
      { id: "empty", title: "Restart canary 1" },
      { id: "full", title: "Has body", content: LIVE_CONTENT },
    ]);

    const hits = await visibility.searchHits("canary");
    expect(hits.map((hit) => hit.id).sort()).toEqual(["empty", "full"]);
    const listed = await visibility.listNotes();
    expect(listed.map((note) => note.id).sort()).toEqual(["empty", "full"]);
    await expect(visibility.isNoteVisible("empty")).resolves.toBe(true);
  });

  it("7. a bodyless note with a vault link stays hidden everywhere", async () => {
    const visibility = visibilityOver([
      { id: "vaulted", title: "Locked title", vaultLinks: 1 },
      { id: "empty", title: "Empty" },
    ]);

    expect((await visibility.searchHits("x")).map((hit) => hit.id)).toEqual(["empty"]);
    expect((await visibility.listNotes()).map((note) => note.id)).toEqual(["empty"]);
    await expect(visibility.isNoteVisible("vaulted")).resolves.toBe(false);
  });

  it("8. a bodyless note whose contentId is set but has no content is undecided, never visible", async () => {
    const visibility = visibilityOver([
      { id: "pending", title: "Content not arrived", contentId: "content-1" },
    ]);

    await expect(visibility.isNoteVisible("pending")).resolves.toBeUndefined();
    expect(await visibility.searchHits("x")).toEqual([]);
    expect(await visibility.listNotes()).toEqual([]);
  });

  it("9. a bodyless note in a notebook is admitted or denied by settings as usual", async () => {
    const notes: FakeNote[] = [
      { id: "empty-pub", title: "Empty public", notebookId: "nb-pub" },
      { id: "empty-priv", title: "Empty private", notebookId: "nb-priv" },
    ];
    const visibility = visibilityOver(notes, allowPublicOnly);

    await expect(visibility.isNoteVisible("empty-pub")).resolves.toBe(true);
    await expect(visibility.isNoteVisible("empty-priv")).resolves.toBe(false);
    expect((await visibility.listNotes()).map((note) => note.id)).toEqual(["empty-pub"]);
    expect((await visibility.searchHits("x")).map((hit) => hit.id)).toEqual(["empty-pub"]);
  });
});

// ---------------------------------------------------------------------------
// notes.get / readOperatorNoteContent, through the real live factory.
// ---------------------------------------------------------------------------

function setupOptions(): NotesnookDatabaseSetupOptions {
  // The fake Database ignores setup; only the shape has to be accepted.
  return {
    sqliteOptions: { dialect: (() => ({})) as never },
    storage: {} as never,
    fs: {} as never,
    compressor: {} as never,
    batchSize: 50,
    eventsource: function FakeEventSource() {} as never,
  } as unknown as NotesnookDatabaseSetupOptions;
}

async function handleOver(
  notes: readonly FakeNote[],
  coreOptions: { omitRelations?: boolean } = {},
) {
  const core = makeFakeCore({
    notes,
    notebooks: NOTEBOOKS,
    ...coreOptions,
  }) as Record<string, unknown>;
  const kvStorage = {
    read: async () => undefined,
    write: async () => undefined,
    delete: async () => undefined,
  };
  const database = {
    ...core,
    setup: () => undefined,
    init: async () => undefined,
    user: {
      authenticateEmail: async () => ({}),
      authenticateMultiFactorCode: async () => ({}),
      authenticatePassword: async () => undefined,
      _login: async () => undefined,
      getUser: async () => undefined,
      logout: async () => undefined,
    },
    tokenManager: { getToken: async () => undefined, _refreshToken: async () => undefined },
    kv: () => kvStorage,
  };
  const injectedModule = markRealCoreModule({
    Database: function Database() {
      return database;
    } as unknown as NotesnookRealCoreModule["Database"],
  });
  const handle = await createNotesnookLiveCoreFactory({
    setup: setupOptions(),
    onCleanup: () => undefined,
    injectedModule,
  });
  if (handle.readOnly === undefined) throw new Error("expected a read-only projection");
  return handle.readOnly;
}

const getRequest = (id: string) =>
  ({ id: "get-1", method: "notes.get", params: { id } }) as unknown as RpcRequest;

async function getNote(notes: readonly FakeNote[], id: string) {
  const readOnly = await handleOver(notes);
  const runtime: RpcHandlerRuntimeLike = {
    search: async () => [],
    noteMetadata: readOnly.noteMetadata as never,
    readOnly: { readNoteSnapshot: readOnly.readNoteSnapshot } as never,
  };
  return handleRpcRequest(
    getRequest(id),
    runtime,
    createReadWriteNoDeleteServicePolicy(() => ({ allowed: true })),
  );
}

describe("bodyless notes through notes.get", () => {
  // Core's empty body is `<p></p>`, and the Markdown codec spells an empty
  // paragraph as an explicit preserved block (a blank line is a separator), so
  // "empty" here means: status ok, and no text beyond the format header plus
  // that one empty-paragraph directive. It is not the literal "" that a stored
  // `html: ""` body produces.
  it("10. a bodyless note returns ok with an empty document, not a refusal", async () => {
    const response = await getNote([{ id: "empty", title: "Restart canary 1" }], "empty");
    expect(response).toMatchObject({ ok: true, result: { kind: "note", contentStatus: "ok" } });
    if (!response.ok || response.result.kind !== "note") throw new Error("expected a note result");
    expect(response.result).not.toHaveProperty("contentReason");
    expect(response.result.markdown).toBe(
      "---\nnookbridge-format: 1\n---\n\n:::nookbridge paragraph\n:::\n",
    );
  });

  it("10b. the snapshot carries core's own empty body, not an invented one", async () => {
    const readOnly = await handleOver([{ id: "empty", title: "Empty" }]);
    const snapshot = await readOnly.readNoteSnapshot!("empty");
    expect(snapshot).toMatchObject({ content: { type: "tiptap", data: "<p></p>" } });
  });

  it("10b. a note carrying a locked marker never returns its body", async () => {
    // The content record has no lock marker of its own, so only the note-level
    // marker says locked.  The metadata flag and the strict read must agree.
    const readOnly = await handleOver([
      {
        id: "marked",
        title: "Marked",
        locked: true,
        content: { type: "tiptap", data: "<p>secret</p>" },
      },
    ]);
    const metadata = await readOnly.noteMetadata!("marked");
    expect(metadata).toMatchObject({ locked: true });
    const snapshot = await readOnly.readNoteSnapshot!("marked");
    expect(snapshot).toMatchObject({ contentRefusal: "locked" });
    expect(snapshot).not.toHaveProperty("markdown");
  });

  it("10c. an unusable Vault probe never turns into an empty body", async () => {
    // Every signal except the Vault probe says "no body".  If the probe cannot
    // answer, the note is undecidable and `notes.get` must refuse, not serve
    // core's empty body.
    const readOnly = await handleOver([{ id: "unprobed", title: "Unprobed" }], {
      omitRelations: true,
    });
    const snapshot = await readOnly.readNoteSnapshot!("unprobed");
    expect(snapshot).toMatchObject({ contentRefusal: "read_failed" });
    expect(snapshot).not.toHaveProperty("content");
  });

  it("11. a locked bodyless note (vault link, no content) returns contentRefusal locked", async () => {
    const readOnly = await handleOver([{ id: "vaulted", title: "Locked", vaultLinks: 1 }]);
    const snapshot = await readOnly.readNoteSnapshot!("vaulted");
    expect(snapshot).toMatchObject({ contentRefusal: "locked" });
    expect(snapshot).not.toHaveProperty("content");

    const response = await getNote([{ id: "vaulted", title: "Locked", vaultLinks: 1 }], "vaulted");
    expect(response).toMatchObject({ ok: true, result: { contentStatus: "locked" } });
    expect(response.ok && response.result.kind === "note" && "markdown" in response.result).toBe(
      false,
    );
  });

  it("11b. a bodyless note whose content has not arrived is not served as empty", async () => {
    const readOnly = await handleOver([
      { id: "pending", title: "Pending", contentId: "content-1" },
    ]);
    const snapshot = await readOnly.readNoteSnapshot!("pending");
    expect(snapshot).toMatchObject({ contentRefusal: "read_failed" });
    expect(snapshot).not.toHaveProperty("content");
  });

  it("12. readOperatorNoteContent still refuses an empty note", async () => {
    const readOnly = await handleOver([{ id: "empty", title: "Empty" }]);
    await expect(readOnly.readOperatorNoteContent!("empty")).rejects.toMatchObject({
      message: "unsupported_content",
    });
  });

  it("a note with a body is served unchanged", async () => {
    const response = await getNote(
      [
        {
          id: "full",
          title: "Full",
          content: { type: "html", data: "<p>Hello</p>", locked: false },
        },
      ],
      "full",
    );
    expect(response).toMatchObject({ ok: true, result: { contentStatus: "ok" } });
    expect(response.ok && response.result.kind === "note" && response.result.markdown).toContain(
      "Hello",
    );
  });
});
