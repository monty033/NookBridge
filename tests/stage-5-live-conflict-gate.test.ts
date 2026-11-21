/**
 * Live keep-both resolve and abandon stay off unless explicitly enabled.
 *
 * The helper test below is not enough on its own: it would still pass if the daemon
 * stopped calling it. The startup tests drive the real `startNookd` path and read the
 * operator handler the daemon actually built, so removing the gate from the wiring fails
 * here rather than silently deploying a reachable conflict runtime.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { gateLiveConflictResolve, productionStartupOptions, startNookd } from "../src/nookd.js";
import type { NookdStartupFactories, NookdStartupRuntime } from "../src/nookd.js";
import type { LoadServiceConfigResult, ServiceConfig } from "../src/config/service-config.js";
import type { SecureKeyStore } from "../src/keystore/keystore.js";
import type { NookdServerHandle, StartNookdServerOptions } from "../src/service/nookd-server.js";
import type { OperationStoreFs } from "../src/service/notes-undo-store.js";
import type { OperatorPeer } from "../src/service/operator-server.js";

const CAPABILITY = Object.freeze({ seam: {}, journal: {} });

const CONFIG_PATH = "/etc/nookbridge/service.json";
const CREDENTIALS_DIRECTORY = "/run/credentials/nookbridge.service";
const NOTE_ID = "note-live-conflict-probe";
const NOTEBOOK_ID = "root";
const SETTINGS_TEXT = JSON.stringify({
  version: 1,
  defaults: { read: true, edit: true, create: false, delete: false },
  overrides: [],
});
// Canonical paths only: nookd pins stateDir and the socket directory. The operation
// store is constructed against `<stateDir>/operations`, but it writes only when a record
// is made and this test never records one, so nothing outside the process is touched.
const CONFIG: ServiceConfig = Object.freeze({
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
const KEYS: SecureKeyStore = Object.freeze({
  backend: "systemd-credential",
  productionSafe: true,
  getDatabaseKey: () => "opaque-test-key",
});

/** In-memory operation-store filesystem: nothing is created on disk. */
function memoryStoreFs(): OperationStoreFs {
  const files = new Map<string, Uint8Array>();
  return Object.freeze({
    list: async (limit: number) => [...files.keys()].slice(0, limit),
    read: async (name: string) => files.get(name) ?? new Uint8Array(),
    writeExclusive: async (name: string, bytes: Uint8Array) => {
      files.set(name, bytes);
    },
    syncFile: async () => undefined,
    rename: async (from: string, to: string) => {
      const bytes = files.get(from);
      if (bytes !== undefined) {
        files.delete(from);
        files.set(to, bytes);
      }
    },
    syncDirectory: async () => undefined,
    remove: async (name: string) => {
      files.delete(name);
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function runtimeFixture(): NookdStartupRuntime {
  const metadata = {
    id: NOTE_ID,
    title: "Probe",
    revision: "rev-1",
    notebookId: NOTEBOOK_ID,
    notebookIds: [NOTEBOOK_ID],
  };
  return Object.freeze({
    search: vi.fn(async () => [{ title: "result" }]),
    cleanup: vi.fn(async () => undefined),
    listNotebooksForSettings: vi.fn(async () => [{ id: NOTEBOOK_ID, title: "Root" }]),
    resolveNotebookPath: vi.fn(async () => "Root"),
    noteMetadata: vi.fn(async () => metadata),
    // Present so the daemon builds the operator runtime at all; never invoked here.
    operatorCreateNote: vi.fn(async () => metadata) as never,
    operatorUpdateNote: vi.fn(async () => metadata) as never,
    // The live capability exists, exactly as in production. Whether the daemon wires it
    // is the question these tests answer.
    localConflictResolve: Object.freeze({
      seam: {},
      journal: Object.freeze({
        record: vi.fn(),
        snapshot: vi.fn(() => []),
        discard: vi.fn(),
      }),
      runExclusive: vi.fn(async (_label: string, fn: () => unknown) => fn()),
      markPending: vi.fn(),
    }) as never,
    readOnly: Object.freeze({
      listNotes: vi.fn(async () => [{ id: NOTE_ID, title: "Probe" }]),
      listNotebooks: vi.fn(async () => [{ id: NOTEBOOK_ID }]),
      search: vi.fn(async () => [{ id: NOTE_ID, title: "Probe", source: "note" as const }]),
      noteMetadata: vi.fn(async () => metadata),
      readNoteLockState: vi.fn(async () => "unlocked" as const),
      findNoteIdsByNotebook: vi.fn(async () => [NOTE_ID]),
      hasNoteInNotebook: vi.fn(async () => true),
      readOperatorNoteContent: vi.fn(async () => "{}"),
    }) as never,
  });
}

function factories(): NookdStartupFactories {
  vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
  return {
    loadConfig: vi.fn((_: string): LoadServiceConfigResult => ({ ok: true, config: CONFIG })),
    createKeyStore: vi.fn(() => KEYS),
    createRuntime: vi.fn(async () => runtimeFixture()),
    readSettingsFile: vi.fn(() => SETTINGS_TEXT),
    // In-memory store filesystem: the real one is rooted at the daemon's state
    // directory, which this process must not touch.
    createOperationStoreFs: vi.fn(() => memoryStoreFs()),
    startServer: vi.fn(
      async (_options: StartNookdServerOptions): Promise<NookdServerHandle> => ({
        socketPath: CONFIG.socketPath,
        shutdown: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      }),
    ),
  };
}

/**
 * Runs the real startup path and exercises one conflict method with a phrase that is not
 * its confirmation word. That refusal is decided before the handle lookup and before the
 * transaction, so this reads and writes no note and no operation record.
 */
async function conflictReplyAtStartup(
  method: "notes.abandon-resolve" | "notes.resolve-conflict",
  startup: { liveConflictResolve?: boolean } = {},
): Promise<{ ok: boolean; code?: string }> {
  const underTest = factories();
  const handle = await startNookd({
    configPath: CONFIG_PATH,
    factories: underTest,
    ...startup,
  });
  try {
    const operator = vi.mocked(underTest.startServer).mock.calls[0]?.[0]?.operator;
    expect(operator).toBeDefined();
    const reply = await operator!.handle(
      {
        id: "conflict-1",
        method,
        params: {
          id: "note-probe",
          confirmation: "not-the-phrase",
          ...(method === "notes.resolve-conflict" ? { binding: "0".repeat(64) } : {}),
        },
      } as never,
      OPERATOR,
    );
    const envelope = reply as unknown as { ok: boolean; error?: { code?: string } };
    return {
      ok: envelope.ok,
      ...(envelope.error?.code === undefined ? {} : { code: envelope.error.code }),
    };
  } finally {
    await handle.shutdown();
  }
}

describe("gateLiveConflictResolve", () => {
  it("returns no capability when the option is omitted, so the daemon stays off", () => {
    expect(gateLiveConflictResolve(undefined, CAPABILITY)).toBeUndefined();
  });

  it("returns no capability for any value other than exactly true", () => {
    for (const value of [false, "true", 1, null, undefined]) {
      expect(gateLiveConflictResolve(value as unknown as boolean, CAPABILITY)).toBeUndefined();
    }
  });

  it("returns the capability only when explicitly enabled", () => {
    expect(gateLiveConflictResolve(true, CAPABILITY)).toBe(CAPABILITY);
  });

  it("passes an absent capability through as absent", () => {
    expect(gateLiveConflictResolve(true, undefined)).toBeUndefined();
  });
});

describe("production entry point", () => {
  it("never enables live conflict resolve", () => {
    // If a later change adds liveConflictResolve here, the daemon ships the operator
    // conflict runtime and the suite would otherwise stay green. This pins the absence.
    const options = productionStartupOptions(CONFIG_PATH, { environment: {} } as never, undefined);
    expect(options).not.toHaveProperty("liveConflictResolve");
  });
});

describe("daemon startup honours the gate", () => {
  it("refuses abandon when the option is omitted", async () => {
    // service_unavailable is what the handler returns when no conflict runtime was
    // wired. invalid_request would mean the runtime exists and reached the phrase check.
    expect(await conflictReplyAtStartup("notes.abandon-resolve")).toEqual({
      ok: false,
      code: "service_unavailable",
    });
  });

  it("refuses resolve when the option is omitted", async () => {
    expect(await conflictReplyAtStartup("notes.resolve-conflict")).toEqual({
      ok: false,
      code: "service_unavailable",
    });
  });

  it("wires the conflict runtime when the option is explicitly enabled", async () => {
    expect(
      await conflictReplyAtStartup("notes.abandon-resolve", { liveConflictResolve: true }),
    ).toEqual({ ok: false, code: "invalid_request" });
  });
});
