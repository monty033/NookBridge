/** Stage 11 wiring proof: the operator authorizer as composed by startNookd. */

import { afterEach, describe, expect, it, vi } from "vitest";

import { startNookd, type NookdStartupFactories, type NookdStartupRuntime } from "../src/nookd.js";
import type { LoadServiceConfigResult, ServiceConfig } from "../src/config/service-config.js";
import type { SecureKeyStore } from "../src/keystore/keystore.js";
import type { NookdServerHandle, StartNookdServerOptions } from "../src/service/nookd-server.js";
import type { OperatorPeer } from "../src/service/operator-server.js";

const CONFIG_PATH = "/etc/nookbridge/service.json";
const CREDENTIALS_DIRECTORY = "/run/credentials/nookbridge.service";
const NOTE_ID = "note-locked-probe";
const NOTEBOOK_ID = "root";
const SETTINGS_TEXT = JSON.stringify({
  version: 1,
  defaults: { read: true, edit: true, create: false, delete: false },
  overrides: [],
});
const CONFIG: ServiceConfig = Object.freeze({
  // Must be the canonical path: config validation pins stateDir (nookd.ts ~748).
  // Safe only because this fixture supplies no updateNote/createNote seam, so the
  // operation store is never created. Adding a write seam here would touch real state.
  stateDir: "/var/lib/nookbridge",
  socketPath: "/run/nookbridge/nookbridge.sock",
  socketGroup: "nookbridge-clients",
  backend: "systemd-credential",
  credentialName: "nookbridge-db-key",
  settingsBackend: "nix",
  readPolicy: Object.freeze(["notes.search", "notes.get"] as const),
});
const OPERATOR: OperatorPeer = {
  uid: 1,
  gid: 2,
  groups: ["nookbridge-clients", "nookbridge-operators"],
};

const productionKeys: SecureKeyStore = Object.freeze({
  backend: "systemd-credential",
  productionSafe: true,
  getDatabaseKey: () => "opaque-test-key",
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("nookd operator wiring", () => {
  it("denies apply-edit authorization on a locked note through nookd's wired authorizer", async () => {
    vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
    // Fake read seams; the lock state is the single knob under test. readOnly is
    // cast `as never`, so the compiler does not check its shape.
    let lockState: "locked" | "unlocked" = "unlocked";
    const readNoteLockState = vi.fn(async () => lockState);
    const runtime: NookdStartupRuntime = Object.freeze({
      search: vi.fn(async () => [{ title: "result" }]),
      cleanup: vi.fn(async () => undefined),
      listNotebooksForSettings: vi.fn(async () => [{ id: NOTEBOOK_ID, title: "Root" }]),
      resolveNotebookPath: vi.fn(async () => "Root"),
      noteMetadata: vi.fn(async () => ({
        id: NOTE_ID,
        title: "Probe",
        revision: "rev-1",
        notebookId: NOTEBOOK_ID,
      })),
      readOnly: Object.freeze({
        listNotes: vi.fn(async () => [{ id: NOTE_ID, title: "Probe" }]),
        listNotebooks: vi.fn(async () => [{ id: NOTEBOOK_ID }]),
        search: vi.fn(async () => [{ id: NOTE_ID, title: "Probe", source: "note" as const }]),
        noteMetadata: vi.fn(async () => ({
          id: NOTE_ID,
          title: "Probe",
          revision: "rev-1",
          notebookId: NOTEBOOK_ID,
        })),
        readNoteLockState,
        findNoteIdsByNotebook: vi.fn(async () => [NOTE_ID]),
        // Direct-holder proof: the note is directly in NOTEBOOK_ID.
        hasNoteInNotebook: vi.fn(
          async (notebookId: string, noteId: string) =>
            notebookId === NOTEBOOK_ID && noteId === NOTE_ID,
        ),
        readOperatorNoteContent: vi.fn(async () => "{}"),
      }) as never,
    });
    const factories: NookdStartupFactories = {
      loadConfig: vi.fn((_: string): LoadServiceConfigResult => ({ ok: true, config: CONFIG })),
      createKeyStore: vi.fn(() => productionKeys),
      createRuntime: vi.fn(async () => runtime),
      readSettingsFile: vi.fn(() => SETTINGS_TEXT),
      startServer: vi.fn(
        async (_options: StartNookdServerOptions): Promise<NookdServerHandle> => ({
          socketPath: CONFIG.socketPath,
          shutdown: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
        }),
      ),
    };

    const handle = await startNookd({ configPath: CONFIG_PATH, factories });
    try {
      const startServer = vi.mocked(factories.startServer);
      const serverOptions = startServer.mock.calls[0]?.[0];
      const operator = serverOptions?.operator;
      expect(operator).toBeDefined();

      // Mint a handle through the same registry the authorizer resolves against:
      // a browse of the note is the only way a client receives a handle.
      const browse = await operator!.handle(
        { id: "browse-1", method: "notes.browse", params: {} } as never,
        OPERATOR,
      );
      const notes = (browse as unknown as { result: { notes: { handle: string }[] } }).result.notes;
      const noteHandle = notes[0]?.handle;
      expect(noteHandle).toEqual(expect.any(String));

      const request = {
        id: "edit-1",
        method: "notes.apply-edit",
        params: { id: noteHandle },
      } as never;

      // Control: an unlocked note with the same wiring is admitted, so the
      // refusal below is caused by the lock state and not by a broken fixture.
      await expect(
        operator!.authorize("notes.apply-edit", OPERATOR, request),
      ).resolves.toMatchObject({ allowed: true });

      lockState = "locked";
      await expect(operator!.authorize("notes.apply-edit", OPERATOR, request)).resolves.toEqual({
        allowed: false,
        reason: "vault_locked",
      });
      expect(readNoteLockState).toHaveBeenCalledWith(NOTE_ID);
    } finally {
      await handle.shutdown();
    }
  });
});

describe("nookd operator discovery visibility (S2c)", () => {
  it("hides denied notebook titles from production-wired browse and search", async () => {
    const wiring = await startWiredNookd({
      noteNotebookId: RESTRICTED_NOTEBOOK_ID,
      settingsText: S2C_SETTINGS_TEXT,
    });
    try {
      const browse = await wiring.operator.handle(
        { id: "browse-hidden", method: "notes.browse", params: {} } as never,
        OPERATOR,
      );
      expect(browse).toMatchObject({ ok: true, result: { notes: [] } });

      const search = await wiring.operator.handle(
        {
          id: "search-hidden",
          method: "notes.search-operator",
          params: { query: "Probe" },
        } as never,
        OPERATOR,
      );
      expect(search).toMatchObject({ ok: true, result: { notes: [] } });
      expect(wiring.findNoteIdsByNotebook).toHaveBeenCalledWith(RESTRICTED_NOTEBOOK_ID);
    } finally {
      await wiring.handle.shutdown();
    }
  });

  it("fails closed rather than falling back to raw discovery without membership lookup", async () => {
    const wiring = await startWiredNookd({ omitMembershipLookup: true });
    try {
      const browse = await wiring.operator.handle(
        { id: "browse-no-membership", method: "notes.browse", params: {} } as never,
        OPERATOR,
      );
      expect(browse).toMatchObject({ ok: true, result: { notes: [] } });
      const search = await wiring.operator.handle(
        {
          id: "search-no-membership",
          method: "notes.search-operator",
          params: { query: "Probe" },
        } as never,
        OPERATOR,
      );
      expect(search).toMatchObject({ ok: true, result: { notes: [] } });
      expect(wiring.listNotes).toHaveBeenCalled();
    } finally {
      await wiring.handle.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// S1b — notebook policy, create authorization, and peer-scoped handles.
// ---------------------------------------------------------------------------

const OPEN_NOTEBOOK_ID = "root";
const RESTRICTED_NOTEBOOK_ID = "restricted";
const DENIED_NOTEBOOK_PATH = "Restricted";
/** Minimal stored-content envelope; the peer test asserts handle resolution before parsing. */
const NOTE_CONTENT = JSON.stringify({ type: "html", data: "<p>Probe</p>" });

/**
 * The S1b policy file: defaults admit edit and create, the single override is
 * the refusal the notebook-policy assertions lean on.  A default-off `create`
 * would deny every create and leave the refusal unattributable to the notebook
 * policy, so the denial is spelled out per notebook instead.
 */
const S1B_SETTINGS_TEXT = JSON.stringify({
  version: 1,
  defaults: { read: true, edit: true, create: true, delete: false },
  overrides: [{ notebooks: [DENIED_NOTEBOOK_PATH], edit: false, create: false }],
});
const S2C_SETTINGS_TEXT = JSON.stringify({
  version: 1,
  defaults: { read: true, edit: true, create: false, delete: false },
  overrides: [{ notebooks: [DENIED_NOTEBOOK_PATH], read: false }],
});

/** Notebook id -> settings notebook path, exactly as the daemon resolves it. */
const NOTEBOOK_PATHS: Readonly<Record<string, string>> = Object.freeze({
  [OPEN_NOTEBOOK_ID]: "Root",
  [RESTRICTED_NOTEBOOK_ID]: DENIED_NOTEBOOK_PATH,
});

// Peer B: the same admitted groups as the operating peer, a different uid.  A
// different owner key is what makes the peer-scoped registry a stranger.
const OTHER_OPERATOR: OperatorPeer = Object.freeze({
  uid: 4242,
  gid: 2,
  groups: ["nookbridge-clients", "nookbridge-operators"],
});

/** The operator endpoint shape `startNookd` hands to the composed server. */
type WiredOperator = NonNullable<StartNookdServerOptions["operator"]>;

/** The knobs one booted wiring instance exposes to a single test. */
type WiringOverrides = Readonly<{
  /** The notebook the probed note lives in; drives notebook policy. */
  readonly noteNotebookId?: string;
  readonly omitMembershipLookup?: boolean;
  readonly settingsText?: string;
}>;

/**
 * Compose the daemon exactly as production does and hand back the operator
 * authorizer / handler the composed server received.
 *
 * Fake runtime / read seams only — deliberately NO `createNote` / `updateNote`
 * seam.  `nookd` initialises the durable operation store under
 * `<stateDir>/operations` the moment either write seam exists, and `stateDir`
 * is the canonical `/var/lib/nookbridge`, so supplying one would touch real
 * state.  The create denial is therefore decided at the captured authorization
 * seam, with no create/write dispatched and no store opened.
 */
async function startWiredNookd(overrides: WiringOverrides = {}) {
  vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
  // Fake read seams; the note's notebook is the knob under test.  readOnly is
  // cast `as never`, so the compiler does not check its shape.
  const noteNotebookId = overrides.noteNotebookId ?? OPEN_NOTEBOOK_ID;
  const readNoteLockState = vi.fn(async () => "unlocked" as const);
  const noteMetadata = vi.fn(async () => ({
    id: NOTE_ID,
    title: "Probe",
    revision: "rev-1",
    notebookId: noteNotebookId,
  }));
  const listNotes = vi.fn(async () => [{ id: NOTE_ID, title: "Probe" }]);
  const findNoteIdsByNotebook = vi.fn(async (notebookId: string) =>
    notebookId === noteNotebookId ? [NOTE_ID] : [],
  );
  // Direct-holder proof: non-recursive fixture, so the note is directly in its notebook.
  const hasNoteInNotebook = vi.fn(
    async (notebookId: string, noteId: string) =>
      notebookId === noteNotebookId && noteId === NOTE_ID,
  );
  const readOperatorNoteContent = vi.fn(async () => NOTE_CONTENT);
  const resolveNotebookPath = vi.fn(async (notebookId: string) => NOTEBOOK_PATHS[notebookId]);
  const listNotebooksForSettings = vi.fn(async () => [
    { id: OPEN_NOTEBOOK_ID, title: "Root" },
    { id: RESTRICTED_NOTEBOOK_ID, title: DENIED_NOTEBOOK_PATH },
  ]);
  const runtime: NookdStartupRuntime = Object.freeze({
    search: vi.fn(async () => [{ title: "result" }]),
    cleanup: vi.fn(async () => undefined),
    listNotebooksForSettings,
    resolveNotebookPath,
    noteMetadata,
    readOnly: Object.freeze({
      listNotes,
      listNotebooks: vi.fn(async () => [{ id: OPEN_NOTEBOOK_ID }, { id: RESTRICTED_NOTEBOOK_ID }]),
      search: vi.fn(async () => [{ id: NOTE_ID, title: "Probe", source: "note" as const }]),
      noteMetadata,
      readNoteLockState,
      ...(overrides.omitMembershipLookup ? {} : { findNoteIdsByNotebook, hasNoteInNotebook }),
      readOperatorNoteContent,
    }) as never,
  });
  const factories: NookdStartupFactories = {
    loadConfig: vi.fn((_: string): LoadServiceConfigResult => ({ ok: true, config: CONFIG })),
    createKeyStore: vi.fn(() => productionKeys),
    createRuntime: vi.fn(async () => runtime),
    readSettingsFile: vi.fn(() => overrides.settingsText ?? S1B_SETTINGS_TEXT),
    startServer: vi.fn(
      async (_options: StartNookdServerOptions): Promise<NookdServerHandle> => ({
        socketPath: CONFIG.socketPath,
        shutdown: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      }),
    ),
  };

  const handle = await startNookd({ configPath: CONFIG_PATH, factories });
  const serverOptions = vi.mocked(factories.startServer).mock.calls[0]?.[0];
  const operator = serverOptions?.operator;
  if (operator === undefined) throw new Error("operator endpoint was not wired");
  return {
    handle,
    operator,
    runtime,
    readNoteLockState,
    noteMetadata,
    resolveNotebookPath,
    listNotes,
    findNoteIdsByNotebook,
  };
}

/** The single handle a one-note browse mints for `peer`. */
async function browseHandle(
  operator: WiredOperator,
  peer: OperatorPeer,
  requestId: string,
): Promise<string> {
  const response = await operator.handle(
    { id: requestId, method: "notes.browse", params: {} } as never,
    peer,
  );
  const notes = (response as unknown as { result: { notes: { handle: string }[] } }).result.notes;
  const handle = notes[0]?.handle;
  expect(handle).toEqual(expect.any(String));
  if (typeof handle !== "string") throw new Error("browse did not mint a handle");
  return handle;
}

const editRequest = (id: string, handle: string): unknown => ({
  id,
  method: "notes.apply-edit",
  params: { id: handle },
});

const createRequest = (id: string, notebookId: string): unknown => ({
  id,
  method: "notes.create",
  params: { notebookId, title: "Probe", content: NOTE_CONTENT },
});

const authorizeEdit = (operator: WiredOperator, peer: OperatorPeer, id: string, handle: string) =>
  operator.authorize("notes.apply-edit", peer, editRequest(id, handle) as never);

const authorizeCreate = (
  operator: WiredOperator,
  peer: OperatorPeer,
  id: string,
  notebookId: string,
) => operator.authorize("notes.create", peer, createRequest(id, notebookId) as never);

describe("nookd operator wiring (S1b)", () => {
  it("denies apply-edit on a note in a notebook whose settings deny edit", async () => {
    const wiring = await startWiredNookd({ noteNotebookId: RESTRICTED_NOTEBOOK_ID });
    try {
      const noteHandle = await browseHandle(wiring.operator, OPERATOR, "browse-denied-notebook");

      const decision = await authorizeEdit(
        wiring.operator,
        OPERATOR,
        "edit-denied-notebook",
        noteHandle,
      );
      expect(decision).toEqual({ allowed: false, reason: "permission_denied" });

      // The refusal came from the notebook policy, not from an unresolvable
      // target: the handle resolved and its notebook path was evaluated for
      // "edit".
      expect(wiring.noteMetadata).toHaveBeenCalledWith(NOTE_ID);
      expect(wiring.resolveNotebookPath).toHaveBeenCalledWith(RESTRICTED_NOTEBOOK_ID);
    } finally {
      await wiring.handle.shutdown();
    }
  });

  it("denies notes.create for a denied notebookId, at the authorization seam", async () => {
    const wiring = await startWiredNookd();
    try {
      // Safety boundary asserted, not assumed: a write seam in this fixture is
      // what would open the durable operation store under the canonical state
      // directory, so its absence is part of this suite's contract.
      expect(wiring.runtime).not.toHaveProperty("createNote");
      expect(wiring.runtime).not.toHaveProperty("updateNote");

      const decision = await authorizeCreate(
        wiring.operator,
        OPERATOR,
        "create-denied-notebook",
        RESTRICTED_NOTEBOOK_ID,
      );
      expect(decision).toEqual({ allowed: false, reason: "permission_denied" });

      // The denial was decided at the authorization seam from the notebook
      // policy: the named notebook resolved to a path, and nothing was
      // dispatched — there is no write seam, and no revision read-back ran.
      expect(wiring.resolveNotebookPath).toHaveBeenCalledWith(RESTRICTED_NOTEBOOK_ID);
      expect(wiring.noteMetadata).not.toHaveBeenCalled();

      // Control: the same authorizer admits a create in a notebook the settings
      // allow, so the refusal above came from that notebook's policy alone.
      const admitted = await authorizeCreate(
        wiring.operator,
        OPERATOR,
        "create-admitted-notebook",
        OPEN_NOTEBOOK_ID,
      );
      expect(admitted).toMatchObject({ allowed: true, method: "notes.create" });
    } finally {
      await wiring.handle.shutdown();
    }
  });

  it("denies apply-edit authorization for a note handle another peer minted", async () => {
    const wiring = await startWiredNookd();
    try {
      const noteHandle = await browseHandle(wiring.operator, OPERATOR, "browse-peer-a-edit");

      // Control: the owning peer is admitted with the same handle, so the
      // refusal below is caused by handle ownership alone.
      await expect(
        authorizeEdit(wiring.operator, OPERATOR, "edit-peer-a", noteHandle),
      ).resolves.toMatchObject({ allowed: true, method: "notes.apply-edit" });

      wiring.noteMetadata.mockClear();
      wiring.readNoteLockState.mockClear();

      // Peer B presents peer A's handle: it must not authorize a mutation.
      const decision = await authorizeEdit(
        wiring.operator,
        OTHER_OPERATOR,
        "edit-peer-b",
        noteHandle,
      );
      expect(decision).toEqual({ allowed: false, reason: "permission_denied" });

      // Refused at handle resolution, before any note read for peer B.
      expect(wiring.noteMetadata).not.toHaveBeenCalled();
      expect(wiring.readNoteLockState).not.toHaveBeenCalled();
    } finally {
      await wiring.handle.shutdown();
    }
  });

  it("cannot resolve a note handle another peer minted", async () => {
    const wiring = await startWiredNookd();
    try {
      // Peer A mints the handle; a browse is the only way a client gets one.
      const noteHandle = await browseHandle(wiring.operator, OPERATOR, "browse-peer-a");

      // Peer B tries to resolve it through the same captured handler. The
      // handler maps a failed handle resolution to a categorical not_found
      // envelope rather than throwing, so that is what is asserted.
      wiring.readNoteLockState.mockClear();
      wiring.noteMetadata.mockClear();
      const foreignView = await wiring.operator.handle(
        { id: "view-peer-b", method: "notes.get-view", params: { id: noteHandle } } as never,
        OTHER_OPERATOR,
      );
      expect(foreignView).toMatchObject({ ok: false, error: { code: "not_found" } });

      // Resolution fails before metadata or lock-state reads for peer B.
      expect(wiring.readNoteLockState).not.toHaveBeenCalled();
      expect(wiring.noteMetadata).not.toHaveBeenCalled();

      // Control: the very same handle still resolves for the peer that owns it.
      await wiring.operator.handle(
        { id: "view-peer-a", method: "notes.get-view", params: { id: noteHandle } } as never,
        OPERATOR,
      );
      // An owner-scoped handle gets past registry resolution to metadata lookup;
      // the minimal content fixture need not itself render successfully here.
      expect(wiring.noteMetadata).toHaveBeenCalledWith(NOTE_ID);
    } finally {
      await wiring.handle.shutdown();
    }
  });
});
