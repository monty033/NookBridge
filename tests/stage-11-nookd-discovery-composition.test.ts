/**
 * S2 discovery-visibility composition proof: the NookdServerRuntime that
 * `startNookd` actually hands to the server must filter ordinary MCP
 * `notes.search` and `notes.list_notebooks` through the discovery-visibility
 * filter, using ONE fresh `listNotebooksForSettings` hierarchy snapshot per
 * request (paths and ancestry both come from its ids/parentIds), and must never
 * fall back to the raw unfiltered runtime functions or the boot-time index.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { startNookd, type NookdStartupFactories, type NookdStartupRuntime } from "../src/nookd.js";
import type { LoadServiceConfigResult, ServiceConfig } from "../src/config/service-config.js";
import type { SecureKeyStore } from "../src/keystore/keystore.js";
import type {
  NookdServerHandle,
  NookdServerRuntime,
  StartNookdServerOptions,
} from "../src/service/nookd-server.js";

const CONFIG_PATH = "/etc/nookbridge/service.json";
const CREDENTIALS_DIRECTORY = "/run/credentials/nookbridge.service";
const CONFIG: ServiceConfig = Object.freeze({
  stateDir: "/var/lib/nookbridge",
  socketPath: "/run/nookbridge/nookbridge.sock",
  socketGroup: "nookbridge-clients",
  backend: "systemd-credential",
  credentialName: "nookbridge-db-key",
  settingsBackend: "nix",
  readPolicy: Object.freeze(["notes.search", "notes.list_notebooks"] as const),
});
const SETTINGS_TEXT = JSON.stringify({
  version: 1,
  defaults: { read: true, edit: false, create: false, delete: false },
  overrides: [{ notebooks: ["Restricted"], read: false }],
});
const productionKeys: SecureKeyStore = Object.freeze({
  backend: "systemd-credential",
  productionSafe: true,
  getDatabaseKey: () => "opaque-test-key",
});

type HierarchyRecord = Readonly<{
  id: string;
  title: string;
  parentId?: string;
  dateCreated?: number;
  dateModified?: number;
}>;
type Hit = Readonly<{ id: string; title: string; source: "note" | "notebook" }>;

const BOOT_NOTEBOOKS: ReadonlyArray<HierarchyRecord> = [
  { id: "nb-open", title: "Open" },
  { id: "nb-restricted", title: "Restricted" },
];
const MEMBERSHIP: Record<string, ReadonlyArray<string>> = {
  "n-open": ["nb-open"],
  "n-secret": ["nb-restricted"],
  "n-locked": ["nb-open"],
};
const TITLES: Record<string, string> = {
  "n-open": "Open Note",
  "n-secret": "Secret Note",
  "n-locked": "Locked Note",
};
const HITS: ReadonlyArray<Hit> = [
  { id: "n-open", title: "Open Note", source: "note" },
  { id: "n-secret", title: "Secret Note", source: "note" },
  { id: "n-locked", title: "Locked Note", source: "note" },
  { id: "nb-open", title: "Open", source: "notebook" },
  { id: "nb-restricted", title: "Restricted", source: "notebook" },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type Overrides = Readonly<{
  omitReadOnly?: boolean;
  omitMembership?: boolean;
  omitProbe?: boolean;
  searchFails?: boolean;
  hierarchy?: ReadonlyArray<HierarchyRecord>;
  /** Startup-time hierarchy value of any shape, including an Error to throw. */
  rawStartupHierarchy?: unknown;
  /** Extra raw (title-bearing) notebook summaries the ordinary listing returns. */
  rawNotebooks?: ReadonlyArray<Readonly<{ id: string; title: string }>>;
  membership?: Record<string, ReadonlyArray<string>>;
  /** Direct (non-recursive) attachments; defaults to the claims (non-recursive fixtures). */
  direct?: Record<string, ReadonlyArray<string>>;
  titles?: Record<string, string>;
  hits?: ReadonlyArray<Hit>;
}>;

async function composeServerRuntime(overrides: Overrides = {}) {
  vi.stubEnv("CREDENTIALS_DIRECTORY", CREDENTIALS_DIRECTORY);
  const membership = overrides.membership ?? MEMBERSHIP;
  const titles = overrides.titles ?? TITLES;
  const hits = overrides.hits ?? HITS;
  // Mutable "live" hierarchy: the first listNotebooksForSettings call is the
  // startup index; tests then mutate `state.hierarchy` to model a later change.
  const state: { hierarchy: unknown } = {
    hierarchy: overrides.rawStartupHierarchy ?? overrides.hierarchy ?? BOOT_NOTEBOOKS,
  };
  const rawSearch = vi.fn(async () => [{ title: "RAW LEAK Secret Note" }]);
  const rawListNotebooks = vi.fn(async () => [
    { id: "nb-open", title: "Open", dateCreated: 1, dateModified: 2 },
    { id: "nb-restricted", title: "Restricted", dateCreated: 3, dateModified: 4 },
    ...(overrides.rawNotebooks ?? []),
  ]);
  const readOnlyListNotebooks = vi.fn(async () => [{ id: "nb-open" }, { id: "nb-restricted" }]);
  const readOnlySearch = vi.fn(async () => {
    if (overrides.searchFails === true) throw new Error("upstream search failed");
    return hits;
  });
  const readOnly = Object.freeze({
    search: readOnlySearch,
    listNotes: vi.fn(async () =>
      Object.keys(titles).map((id) => ({ id, title: titles[id] as string })),
    ),
    listNotebooks: readOnlyListNotebooks,
    noteMetadata: vi.fn(async (id: string) => ({
      id,
      title: titles[id],
      notebookId: membership[id]?.[0],
    })),
    readNoteLockState: vi.fn(async (id: string) => (id === "n-locked" ? "locked" : "unlocked")),
    ...(overrides.omitProbe === true
      ? {}
      : {
          hasNoteInNotebook: vi.fn(
            async (notebookId: string, noteId: string) =>
              (overrides.direct ?? membership)[noteId]?.includes(notebookId) === true,
          ),
        }),
    ...(overrides.omitMembership === true
      ? {}
      : {
          findNoteIdsByNotebook: vi.fn(async (notebookId: string) =>
            Object.keys(membership).filter((id) => membership[id]?.includes(notebookId)),
          ),
        }),
  });
  const listNotebooksForSettings = vi.fn(async () => {
    const current = state.hierarchy;
    if (current instanceof Error) throw current;
    return current as ReadonlyArray<HierarchyRecord>;
  });
  // Discovery must take paths from the hierarchy snapshot, never this per-id
  // resolver (which re-lists the whole hierarchy on every call).
  const resolveNotebookPath = vi.fn(async (_notebookId: string): Promise<string | undefined> => {
    throw new Error("discovery must not use the per-id resolver");
  });
  const runtime: NookdStartupRuntime = Object.freeze({
    search: rawSearch,
    listNotebooks: rawListNotebooks,
    cleanup: vi.fn(async () => undefined),
    listNotebooksForSettings,
    resolveNotebookPath,
    ...(overrides.omitReadOnly === true ? {} : { readOnly: readOnly as never }),
  });
  let serverRuntime: NookdServerRuntime | undefined;
  const factories: NookdStartupFactories = {
    loadConfig: vi.fn((_: string): LoadServiceConfigResult => ({ ok: true, config: CONFIG })),
    createKeyStore: vi.fn(() => productionKeys),
    createRuntime: vi.fn(async () => runtime),
    readSettingsFile: vi.fn(() => SETTINGS_TEXT),
    startServer: vi.fn(async (options: StartNookdServerOptions): Promise<NookdServerHandle> => {
      serverRuntime = options.runtime;
      return {
        socketPath: CONFIG.socketPath,
        shutdown: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      };
    }),
  };
  const handle = await startNookd({ configPath: CONFIG_PATH, factories });
  if (serverRuntime === undefined) throw new Error("server runtime was not captured");
  // Count only per-request fetches, not the startup index build.
  const startupFetches = listNotebooksForSettings.mock.calls.length;
  listNotebooksForSettings.mockClear();
  return {
    handle,
    serverRuntime,
    state,
    listNotebooksForSettings,
    startupFetches,
    readOnlyListNotebooks,
    resolveNotebookPath,
    rawSearch,
    rawListNotebooks,
    readOnlySearch,
  };
}

describe("startNookd hands the server a discovery-filtered runtime (S2 MEDIUM)", () => {
  it("notes.search hides locked notes and denied notebook titles, preserving the {title} shape", async () => {
    const wired = await composeServerRuntime();
    try {
      const hits = await wired.serverRuntime.search("anything");
      expect(hits).toEqual([{ title: "Open Note" }, { title: "Open" }]);
      const serialized = JSON.stringify(hits);
      expect(serialized).not.toContain("Secret Note");
      expect(serialized).not.toContain("Locked Note");
      expect(serialized).not.toContain("Restricted");
      expect(serialized).not.toContain("RAW LEAK");
      expect(wired.rawSearch).not.toHaveBeenCalled();
      expect(wired.readOnlySearch).toHaveBeenCalledWith("anything");
      for (const hit of hits) {
        expect(Object.keys(hit)).toEqual(["title"]);
        expect(Object.isFrozen(hit)).toBe(true);
      }
    } finally {
      await wired.handle.shutdown();
    }
  });

  it("notes.list_notebooks hides denied notebook titles, preserving summary fields", async () => {
    const wired = await composeServerRuntime();
    try {
      const listNotebooks = wired.serverRuntime.listNotebooks;
      expect(listNotebooks).toBeDefined();
      const notebooks = await listNotebooks!();
      expect(notebooks).toEqual([
        { id: "nb-open", title: "Open", dateCreated: 1, dateModified: 2 },
      ]);
      expect(JSON.stringify(notebooks)).not.toContain("Restricted");
      expect(wired.rawListNotebooks).toHaveBeenCalledTimes(1);
    } finally {
      await wired.handle.shutdown();
    }
  });

  it("follows the live hierarchy for a notebook known at boot (move/rename)", async () => {
    const wired = await composeServerRuntime();
    try {
      expect((await wired.serverRuntime.search("q")).map((h) => h.title)).toContain("Open Note");
      expect((await wired.serverRuntime.listNotebooks!()).map((n) => n.title)).toContain("Open");

      // Same notebook id, moved under a denied notebook after startup.
      wired.state.hierarchy = [
        { id: "nb-open", title: "Open", parentId: "nb-restricted" },
        { id: "nb-restricted", title: "Restricted" },
      ];

      const hits = JSON.stringify(await wired.serverRuntime.search("q"));
      expect(hits).not.toContain("Open Note");
      expect(await wired.serverRuntime.listNotebooks!()).toEqual([]);
      expect(wired.resolveNotebookPath).not.toHaveBeenCalled();
    } finally {
      await wired.handle.shutdown();
    }
  });

  it("fetches exactly one hierarchy snapshot per discovery request", async () => {
    const wired = await composeServerRuntime();
    try {
      await wired.serverRuntime.search("q");
      expect(wired.listNotebooksForSettings).toHaveBeenCalledTimes(1);
      await wired.serverRuntime.search("q");
      expect(wired.listNotebooksForSettings).toHaveBeenCalledTimes(2);
      await wired.serverRuntime.listNotebooks!();
      expect(wired.listNotebooksForSettings).toHaveBeenCalledTimes(3);
      expect(wired.resolveNotebookPath).not.toHaveBeenCalled();
    } finally {
      await wired.handle.shutdown();
    }
  });

  it("does not fall back to the boot-time index when a notebook leaves the live hierarchy", async () => {
    const wired = await composeServerRuntime();
    try {
      // nb-open is still in the boot-time index; the live snapshot omits it.
      wired.state.hierarchy = [{ id: "nb-restricted", title: "Restricted" }];
      expect(await wired.serverRuntime.search("q")).toEqual([]);
      expect(await wired.serverRuntime.listNotebooks!()).toEqual([]);
    } finally {
      await wired.handle.shutdown();
    }
  });

  it.each<[string, unknown]>([
    ["is unavailable", new Error("hierarchy listing failed")],
    ["is not an array", { not: "an array" }],
    [
      "references a missing parent",
      [
        { id: "nb-open", title: "Open", parentId: "nb-gone" },
        { id: "nb-restricted", title: "Restricted" },
      ],
    ],
    [
      "contains a cycle",
      [
        { id: "nb-open", title: "Open", parentId: "nb-restricted" },
        { id: "nb-restricted", title: "Restricted", parentId: "nb-open" },
      ],
    ],
    [
      "contains a duplicate id",
      [
        { id: "nb-open", title: "Open" },
        { id: "nb-open", title: "Open Again" },
        { id: "nb-restricted", title: "Restricted" },
      ],
    ],
    [
      "contains a malformed record",
      [{ id: "nb-open", title: "Open" }, null, { id: "nb-restricted", title: "Restricted" }],
    ],
    [
      "contains a non-string parentId",
      [
        { id: "nb-open", title: "Open", parentId: 7 },
        { id: "nb-restricted", title: "Restricted" },
      ],
    ],
    [
      "contains colliding paths",
      [
        { id: "nb-open", title: "Open" },
        { id: "nb-open-dup", title: "open" },
        { id: "nb-restricted", title: "Restricted" },
      ],
    ],
  ])("fails closed when the live hierarchy snapshot %s", async (_label, hierarchy) => {
    const wired = await composeServerRuntime();
    try {
      wired.state.hierarchy = hierarchy;
      expect(await wired.serverRuntime.search("q")).toEqual([]);
      expect(await wired.serverRuntime.listNotebooks!()).toEqual([]);
      expect(wired.rawSearch).not.toHaveBeenCalled();
    } finally {
      await wired.handle.shutdown();
    }
  });

  it("shows a nested note when its claimants form a real parentId chain", async () => {
    const wired = await composeServerRuntime({
      hierarchy: [
        { id: "nb-open", title: "Open" },
        { id: "nb-inner", title: "Inner", parentId: "nb-open" },
        { id: "nb-restricted", title: "Restricted" },
      ],
      membership: { "n-open": ["nb-open", "nb-inner"] },
      direct: { "n-open": ["nb-inner"] },
      titles: { "n-open": "Open Note" },
      hits: [{ id: "n-open", title: "Open Note", source: "note" }],
    });
    try {
      expect(await wired.serverRuntime.search("q")).toEqual([{ title: "Open Note" }]);
    } finally {
      await wired.handle.shutdown();
    }
  });

  it("hides a nested note whose deepest notebook on the parentId chain is denied", async () => {
    const wired = await composeServerRuntime({
      hierarchy: [
        { id: "nb-open", title: "Open" },
        { id: "nb-restricted", title: "Restricted" },
        { id: "nb-vault", title: "Vault", parentId: "nb-restricted" },
      ],
      membership: { "n-secret": ["nb-restricted", "nb-vault"] },
      direct: { "n-secret": ["nb-vault"] },
      titles: { "n-secret": "Secret Note" },
      hits: [{ id: "n-secret", title: "Secret Note", source: "note" }],
    });
    try {
      expect(await wired.serverRuntime.search("q")).toEqual([]);
    } finally {
      await wired.handle.shutdown();
    }
  });

  it("hides a note claimed by two unrelated roots even when a slash-named root looks like a child by string", async () => {
    // Root "Parent/Child" and unrelated root "Parent": by string prefix
    // "parent/child" starts with "parent/" and would read as an ancestor chain.
    // The parentId graph says they are unrelated, so the note stays hidden even
    // though policy (defaults read:true) permits both paths.
    const wired = await composeServerRuntime({
      hierarchy: [
        { id: "nb-parent", title: "Parent" },
        { id: "nb-slash", title: "Parent/Child" },
      ],
      membership: { "n-both": ["nb-parent", "nb-slash"] },
      titles: { "n-both": "Both Roots" },
      hits: [
        { id: "n-both", title: "Both Roots", source: "note" },
        { id: "nb-slash", title: "Parent/Child", source: "notebook" },
      ],
    });
    try {
      const hits = await wired.serverRuntime.search("q");
      expect(JSON.stringify(hits)).not.toContain("Both Roots");
      // The unambiguous slash-named notebook itself remains visible.
      expect(hits).toEqual([{ title: "Parent/Child" }]);
    } finally {
      await wired.handle.shutdown();
    }
  });

  it("hides an unlocked note claimed only by an ancestor when its child is missing from the hierarchy", async () => {
    // Root-only summaries (breadcrumbs failed): the hierarchy omits the child,
    // yet the allowed ancestor's recursive listing still claims the note.  The
    // direct holder is the omitted child, so the ancestor must not govern.
    const wired = await composeServerRuntime({
      hierarchy: [
        { id: "nb-open", title: "Open" },
        { id: "nb-restricted", title: "Restricted" },
      ],
      membership: { "n-open": ["nb-open"] },
      direct: { "n-open": ["nb-open-child-omitted"] },
      titles: { "n-open": "Open Note" },
      hits: [{ id: "n-open", title: "Open Note", source: "note" }],
    });
    try {
      expect(await wired.serverRuntime.search("q")).toEqual([]);
    } finally {
      await wired.handle.shutdown();
    }
  });

  it("hides notes when the direct-membership probe is not provided", async () => {
    const wired = await composeServerRuntime({ omitProbe: true });
    try {
      // Only the allowed notebook title survives; every note is hidden.
      expect(await wired.serverRuntime.search("q")).toEqual([{ title: "Open" }]);
    } finally {
      await wired.handle.shutdown();
    }
  });

  it("builds the startup index from one listNotebooksForSettings fetch", async () => {
    const wired = await composeServerRuntime();
    try {
      expect(wired.startupFetches).toBe(1);
    } finally {
      await wired.handle.shutdown();
    }
  });

  it.each<[string, unknown]>([
    ["throws", new Error("strict hierarchy unavailable")],
    ["is not an array", { not: "an array" }],
    ["omits a parent", [{ id: "nb-open", title: "Open", parentId: "nb-missing" }]],
  ])("refuses to start when the startup hierarchy %s (settings_invalid)", async (_l, raw) => {
    await expect(composeServerRuntime({ rawStartupHierarchy: raw })).rejects.toMatchObject({
      category: "settings_invalid",
    });
  });

  it("never uses the ordinary notebook listing to build discovery membership or paths", async () => {
    const wired = await composeServerRuntime();
    try {
      await wired.serverRuntime.search("q");
      expect(wired.readOnlyListNotebooks).not.toHaveBeenCalled();
    } finally {
      await wired.handle.shutdown();
    }
  });

  it("hides a notebook that only the raw title listing knows about (no raw title fallback)", async () => {
    const wired = await composeServerRuntime({
      rawNotebooks: [{ id: "nb-phantom", title: "Phantom Private Title" }],
    });
    try {
      const notebooks = await wired.serverRuntime.listNotebooks!();
      expect(notebooks.map((n) => n.id)).toEqual(["nb-open"]);
      expect(JSON.stringify(notebooks)).not.toContain("Phantom");
    } finally {
      await wired.handle.shutdown();
    }
  });

  it("fails closed when the read-only membership source is not provided", async () => {
    const wired = await composeServerRuntime({ omitMembership: true });
    try {
      expect(await wired.serverRuntime.search("q")).toEqual([]);
      expect(wired.rawSearch).not.toHaveBeenCalled();
    } finally {
      await wired.handle.shutdown();
    }
  });

  it("never falls back to the raw runtime when no read-only projection is available", async () => {
    const wired = await composeServerRuntime({ omitReadOnly: true });
    try {
      expect(await wired.serverRuntime.search("q")).toEqual([]);
      expect(await wired.serverRuntime.listNotebooks!()).toEqual([]);
      expect(wired.rawSearch).not.toHaveBeenCalled();
    } finally {
      await wired.handle.shutdown();
    }
  });

  it("surfaces an upstream search failure instead of substituting raw results", async () => {
    const wired = await composeServerRuntime({ searchFails: true });
    try {
      await expect(wired.serverRuntime.search("q")).rejects.toThrow();
      expect(wired.rawSearch).not.toHaveBeenCalled();
    } finally {
      await wired.handle.shutdown();
    }
  });
});
