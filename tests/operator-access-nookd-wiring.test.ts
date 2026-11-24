/**
 * `operatorAccess` as composed by startNookd: a configured block is validated
 * against the system user/group lookup before the daemon starts, and the
 * resulting policy is what the production authorizer enforces.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { startNookd, type NookdStartupFactories, type NookdStartupRuntime } from "../src/nookd.js";
import type { LoadServiceConfigResult, ServiceConfig } from "../src/config/service-config.js";
import type { SecureKeyStore } from "../src/keystore/keystore.js";
import type { NookdServerHandle, StartNookdServerOptions } from "../src/service/nookd-server.js";
import {
  OPERATOR_BASE_GROUP,
  parseOperatorAccessConfig,
  type PrincipalDirectory,
} from "../src/service/operator-capabilities.js";
import type { OperatorPeer } from "../src/service/operator-server.js";

const CONFIG_PATH = "/etc/nookbridge/service.json";
const CREDENTIALS_DIRECTORY = "/run/credentials/nookbridge.service";
const NOTE_ID = "note-access-probe";
const NOTEBOOK_ID = "root";
const SETTINGS_TEXT = JSON.stringify({
  version: 1,
  defaults: { read: true, edit: true, create: false, delete: false },
  overrides: [],
});

const BASE_CONFIG = {
  stateDir: "/var/lib/nookbridge",
  socketPath: "/run/nookbridge/nookbridge.sock",
  socketGroup: "nookbridge-clients",
  backend: "systemd-credential",
  credentialName: "nookbridge-db-key",
  settingsBackend: "nix",
  readPolicy: Object.freeze(["notes.search", "notes.get"] as const),
} as const;

const configWith = (principals: unknown[] | undefined): ServiceConfig =>
  Object.freeze({
    ...BASE_CONFIG,
    ...(principals === undefined
      ? {}
      : { operatorAccess: parseOperatorAccessConfig({ version: 1, principals }) }),
  }) as ServiceConfig;

const directory: PrincipalDirectory = {
  lookupUser: async (name) =>
    name === "hermes"
      ? { uid: 1001, groups: ["hermes", "nookbridge-clients"] }
      : name === "outsider"
        ? { uid: 1004, groups: ["outsider"] }
        : undefined,
  lookupGroup: async (name) =>
    name === OPERATOR_BASE_GROUP
      ? { gid: 501, members: ["hermes"] }
      : name === "nookbridge-clients"
        ? { gid: 500, members: ["hermes"] }
        : undefined,
};

const BASE_PEER: OperatorPeer = {
  uid: 1,
  gid: 2,
  groups: ["nookbridge-clients", OPERATOR_BASE_GROUP],
};
const HERMES_PEER: OperatorPeer = { uid: 1001, gid: 1001, groups: ["nookbridge-clients"] };

const productionKeys: SecureKeyStore = Object.freeze({
  backend: "systemd-credential",
  productionSafe: true,
  getDatabaseKey: () => "opaque-test-key",
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function factoriesFor(config: ServiceConfig) {
  const runtime: NookdStartupRuntime = Object.freeze({
    search: vi.fn(async () => []),
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
      search: vi.fn(async () => []),
      noteMetadata: vi.fn(async () => ({
        id: NOTE_ID,
        title: "Probe",
        revision: "rev-1",
        notebookId: NOTEBOOK_ID,
      })),
      readNoteLockState: vi.fn(async () => "unlocked" as const),
      findNoteIdsByNotebook: vi.fn(async () => [NOTE_ID]),
      hasNoteInNotebook: vi.fn(async () => true),
      readOperatorNoteContent: vi.fn(async () => "{}"),
    }) as never,
  });
  const factories: NookdStartupFactories = {
    loadConfig: vi.fn((_: string): LoadServiceConfigResult => ({ ok: true, config })),
    createKeyStore: vi.fn(() => productionKeys),
    createRuntime: vi.fn(async () => runtime),
    readSettingsFile: vi.fn(() => SETTINGS_TEXT),
    createPrincipalDirectory: () => directory,
    startServer: vi.fn(
      async (_options: StartNookdServerOptions): Promise<NookdServerHandle> => ({
        socketPath: config.socketPath,
        shutdown: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      }),
    ),
  };
  return factories;
}

describe("nookd operatorAccess wiring", () => {
  it("enforces a configured policy through the wired authorizer", async () => {
    vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
    const factories = factoriesFor(
      configWith([
        { group: OPERATOR_BASE_GROUP, families: ["discover", "read", "write"] },
        { user: "hermes", families: ["discover"] },
      ]),
    );
    const handle = await startNookd({ configPath: CONFIG_PATH, factories });
    try {
      const operator = vi.mocked(factories.startServer).mock.calls[0]?.[0]?.operator;
      expect(operator).toBeDefined();
      const browse = { id: "b", method: "notes.browse", params: {} } as never;
      const edit = { id: "e", method: "notes.apply-edit", params: { id: "h_unknown" } } as never;
      const approve = { id: "a", method: "notes.approve-upload", params: {} } as never;

      // The delegate holds discover: browse is admitted, anything else is refused.
      await expect(operator!.authorize("notes.browse", HERMES_PEER, browse)).resolves.toMatchObject(
        { allowed: true },
      );
      await expect(operator!.authorize("notes.apply-edit", HERMES_PEER, edit)).resolves.toEqual({
        allowed: false,
        reason: "permission_denied",
      });
      // The block did not grant the base group admin, so even a base peer is refused:
      // an explicit block replaces the implicit default rather than adding to it.
      await expect(
        operator!.authorize("notes.approve-upload", BASE_PEER, approve),
      ).resolves.toEqual({ allowed: false, reason: "permission_denied" });
      await expect(operator!.authorize("notes.browse", BASE_PEER, browse)).resolves.toMatchObject({
        allowed: true,
      });
    } finally {
      await handle.shutdown();
    }
  });

  it("keeps today's behaviour when the block is absent", async () => {
    vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
    const factories = factoriesFor(configWith(undefined));
    const handle = await startNookd({ configPath: CONFIG_PATH, factories });
    try {
      const operator = vi.mocked(factories.startServer).mock.calls[0]?.[0]?.operator;
      const approve = { id: "a", method: "notes.approve-upload", params: {} } as never;
      await expect(
        operator!.authorize("notes.approve-upload", BASE_PEER, approve),
      ).resolves.toMatchObject({ allowed: true });
      await expect(operator!.authorize("notes.browse", HERMES_PEER, approve)).resolves.toEqual({
        allowed: false,
        reason: "permission_denied",
      });
    } finally {
      await handle.shutdown();
    }
  });

  it("refuses startup, as a configuration failure, for a grant that cannot be used", async () => {
    vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
    const factories = factoriesFor(configWith([{ user: "outsider", families: ["discover"] }]));
    await expect(startNookd({ configPath: CONFIG_PATH, factories })).rejects.toMatchObject({
      category: "configuration",
    });
    expect(factories.createRuntime).not.toHaveBeenCalled();
    expect(factories.startServer).not.toHaveBeenCalled();
  });

  it("refuses startup for a principal that does not resolve, without echoing it", async () => {
    vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
    const factories = factoriesFor(configWith([{ user: "canary-ghost-7f3a", families: ["read"] }]));
    const error = await startNookd({ configPath: CONFIG_PATH, factories }).catch((e: unknown) => e);
    expect(error).toMatchObject({ category: "configuration" });
    expect(String((error as Error).message)).not.toContain("canary-ghost-7f3a");
    expect(factories.startServer).not.toHaveBeenCalled();
  });
});
