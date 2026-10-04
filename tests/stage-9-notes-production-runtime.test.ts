import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

import {
  createNotesCommandRuntimeFromOperatorSocket,
  createNotesCommandRuntimeFromReadOnly,
  createNotesOpaqueHandleCodec,
  createNotesReadSource,
  createProductionNotesRuntime,
} from "../src/operator/notes-production-runtime.js";
import type { OperatorSocketResult } from "../src/operator/operator-socket-client.js";
import type { NotesCategoricalResult } from "../src/operator/notes-cli.js";

function expectPage(result: NotesCategoricalResult) {
  if (result.kind !== "page") throw new Error(`expected page, got ${result.kind}`);
  return result;
}

function expectNote(result: NotesCategoricalResult) {
  if (result.kind !== "note") throw new Error(`expected note, got ${result.kind}`);
  return result;
}

describe("operator socket browse categorical mapping", () => {
  const socket = (response: OperatorSocketResult | (() => Promise<OperatorSocketResult>)) =>
    createNotesCommandRuntimeFromOperatorSocket({
      request: async () => (typeof response === "function" ? await response() : response),
    });

  it.each([
    ["not_found", { kind: "missing" }],
    ["permission_denied", { kind: "denied" }],
    ["invalid_request", { kind: "invalid-input" }],
    ["vault_locked", { kind: "locked" }],
    ["stale_revision", { kind: "conflict" }],
    ["conflict", { kind: "conflict" }],
    ["sync_failed", { kind: "error", message: "sync failed", exitCode: 3, reason: "sync_failed" }],
    [
      "service_unavailable",
      {
        kind: "error",
        message: "nookctl notes: runtime unavailable",
        exitCode: 3,
        reason: "service_unavailable",
      },
    ],
  ] as const)("preserves trusted %s category", async (code, expected) => {
    const runtime = socket({ ok: false, code });
    await expect(runtime.browse({})).resolves.toEqual(expected);
  });

  it("labels an unexpected success payload as invalid_response", async () => {
    const runtime = socket({
      ok: true,
      result: {
        kind: "view",
        id: "x",
        markdown: "",
        revision: "rev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        contentBytes: 0,
      },
    });
    await expect(runtime.browse({})).resolves.toMatchObject({
      kind: "error",
      reason: "invalid_response",
    });
  });

  it("collapses thrown exceptions and arbitrary codes without details", async () => {
    for (const request of [
      async () => {
        throw Object.assign(new Error("/private/path BODY_SECRET"), { code: "vault_locked" });
      },
      async () => ({ ok: false, code: "unexpected_secret" }) as unknown as OperatorSocketResult,
    ]) {
      const runtime = socket(request);
      const result = await runtime.browse({});
      expect(result).toMatchObject({ kind: "error", reason: "service_unavailable" });
      expect(JSON.stringify(result)).not.toContain("BODY_SECRET");
      expect(JSON.stringify(result)).not.toContain("/private/path");
    }
  });

  it("retains valid page and empty responses", async () => {
    const page = socket({
      ok: true,
      result: {
        kind: "operator-page",
        notes: [{ handle: "h_Ab12Ab12Ab12Ab12Ab12Ab12", label: "x", bytes: 1 }],
        next: null,
      },
    });
    await expect(page.browse({})).resolves.toMatchObject({ kind: "page" });
    const empty = socket({ ok: true, result: { kind: "operator-page", notes: [], next: null } });
    await expect(empty.browse({})).resolves.toEqual({ kind: "empty" });
  });
});

describe("Stage 9 production read-only notes composition", () => {
  it("uses only the closed list/search/note metadata source surface", async () => {
    const search = vi.fn(async (query: string) => [
      { source: "note" as const, id: "note-1", title: `Match ${query}`, dateModified: 2 },
      { source: "notebook" as const, id: "notebook-1", title: "Do not expose" },
    ]);
    const source = createNotesReadSource({
      listNotes: async () => [{ id: "note-1", title: "First note", dateModified: 1 }],
      search,
      noteMetadata: async (id: string) =>
        id === "note-1" ? { id, title: "First note", dateModified: 1 } : undefined,
    });

    const listed = await source.list();
    expect(listed).toEqual([{ id: "note-1", title: "First note", dateModified: 1 }]);
    expect(await source.search("leaf")).toEqual([{ id: "note-1", title: "Match leaf" }]);
    expect(search).toHaveBeenCalledWith("leaf");
    expect(JSON.stringify(source)).not.toContain("notebook-1");
  });

  it("round-trips handles across codec instances without exposing the source id", () => {
    const first = createNotesOpaqueHandleCodec("stable local database key");
    const second = createNotesOpaqueHandleCodec("stable local database key");
    const handle = first.encode("note-1");

    expect(handle).toMatch(/^not_[A-Za-z0-9_-]+$/);
    expect(handle).not.toContain("note-1");
    expect(second.decode(handle)).toEqual({ kind: "ok", sourceId: "note-1" });
    expect(createNotesOpaqueHandleCodec("wrong key").decode(handle)).toEqual({ kind: "invalid" });
  });

  it("wires browse/search/get through the bounded runtime and never emits raw ids", async () => {
    const source = createNotesReadSource({
      listNotes: async () => [{ id: "note-1", title: "First note", dateModified: 1 }],
      search: async () => [{ source: "note", id: "note-1", title: "First note", dateModified: 1 }],
      noteMetadata: async (id: string) =>
        id === "note-1" ? { id, title: "First note", dateModified: 1 } : undefined,
    });
    const runtime = createNotesCommandRuntimeFromReadOnly(
      source,
      createNotesOpaqueHandleCodec("stable local database key"),
    );

    const browse = expectPage(await runtime.browse({ limit: 10 }));
    expect(browse.notes).toHaveLength(1);
    const handle = browse.notes[0]?.handle;
    expect(handle).toMatch(/^not_[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(browse)).not.toContain("note-1");

    const search = expectPage(await runtime.search({ query: "leaf" }));
    expect(search.notes[0]?.handle).toMatch(/^not_[A-Za-z0-9_-]+$/);

    const note = expectNote(await runtime.get({ handle: handle as string }));
    expect(note.content).toEqual({ label: "First note", bytes: 10 });
    expect(JSON.stringify(note)).not.toContain("note-1");
  });

  it("constructs production runtime without a second database opener", async () => {
    const runtimeSource = readFileSync(
      new URL("../src/operator/notes-production-runtime.ts", import.meta.url),
      "utf8",
    );
    expect(runtimeSource).not.toContain("createProductionLiveLoginRuntime");
    expect(runtimeSource).not.toContain("@notesnook/core");
    expect(runtimeSource).not.toContain("createProductionOperatorKeyStore");
    const production = await createProductionNotesRuntime({ environment: {} });
    await expect(production.runtime.browse({ limit: 1 })).resolves.toMatchObject({
      kind: "error",
      exitCode: 3,
    });
    await production.cleanup();
  });

  it("returns categorical unavailable results for mutation methods", async () => {
    const runtime = createNotesCommandRuntimeFromReadOnly(
      createNotesReadSource({
        listNotes: async () => [],
        search: async () => [],
        noteMetadata: async () => undefined,
      }),
      createNotesOpaqueHandleCodec("stable local database key"),
    );

    await expect(runtime.edit({ handle: "not_handle" })).resolves.toEqual({
      kind: "error",
      exitCode: 3,
      message: "nookctl notes: runtime unavailable",
    });
    await expect(runtime.undo({ operationHandle: `op_${"a".repeat(64)}` })).resolves.toEqual({
      kind: "error",
      exitCode: 3,
      message: "nookctl notes: runtime unavailable",
    });
    await expect(runtime.operations()).resolves.toEqual({
      kind: "error",
      exitCode: 3,
      message: "nookctl notes: runtime unavailable",
    });
  });
});
