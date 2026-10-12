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
        search: vi.fn(async () => []),
        noteMetadata: vi.fn(async () => ({
          id: NOTE_ID,
          title: "Probe",
          revision: "rev-1",
          notebookId: NOTEBOOK_ID,
        })),
        readNoteLockState,
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
