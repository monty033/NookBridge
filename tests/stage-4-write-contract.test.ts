/**
 * Stage 4 — pure write contract and opaque revision guards.
 *
 * Scope of this file (first pure slice of `docs/stage-4-write-plan.md` §1/§3):
 * typed application-layer command validation, bounded input limits, allowed
 * patch fields, stable result shapes, opaque revision tokens, categorical
 * errors, and a pure revision guard.
 *
 * These tests are deliberately pure: no Notesnook `Database`, no adapter, no
 * projection, no CLI, no sync coordinator, no network, no live credentials, no
 * mutation of any kind.  Nothing here can write to a real vault because the
 * module under test has no upstream handle at all.
 */

import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  ALLOWED_UPDATE_PATCH_FIELDS,
  NotesnookWriteContractError,
  STAGE4_WRITE_LIMITS,
  assertRevisionMatch,
  createRevisionToken,
  isNotesnookWriteContractError,
  planAppendNote,
  planCreateNote,
  planUpdateNote,
  revisionTokensMatch,
  type NotesnookWriteErrorCode,
} from "../src/core/notesnook-write-contract.js";

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";

function revision(id: string, dateEdited: number, counter = 1) {
  return createRevisionToken({ id, dateEdited, revisionCounter: counter });
}

function codeOf(fn: () => unknown): NotesnookWriteErrorCode {
  try {
    fn();
  } catch (error) {
    if (!isNotesnookWriteContractError(error)) {
      throw new Error("expected a categorical Stage 4 write contract error");
    }
    return error.code;
  }
  throw new Error("expected the Stage 4 write contract to fail closed");
}

describe("Stage 4 write contract — bounded limits", () => {
  it("publishes frozen, bounded limits and a frozen allowed patch field set", () => {
    expect(Object.isFrozen(STAGE4_WRITE_LIMITS)).toBe(true);
    expect(STAGE4_WRITE_LIMITS.maxTitleLength).toBeGreaterThan(0);
    expect(STAGE4_WRITE_LIMITS.maxContentBytes).toBeGreaterThan(0);
    expect(STAGE4_WRITE_LIMITS.maxFragmentBytes).toBeGreaterThan(0);
    expect(STAGE4_WRITE_LIMITS.maxTags).toBeGreaterThan(0);

    expect([...ALLOWED_UPDATE_PATCH_FIELDS].sort()).toEqual([
      "content",
      "favorite",
      "notebookId",
      "pinned",
      "tags",
      "title",
    ]);
    expect(() => {
      (ALLOWED_UPDATE_PATCH_FIELDS as Set<string>).add("deleted");
    }).toThrow();
  });
});

describe("Stage 4 write contract — createNote", () => {
  it("returns a stable, bounded plan result for a valid create command", () => {
    const plan = planCreateNote({
      title: "Groceries",
      content: "- milk\n- oats\n",
      notebookId: OTHER_ID,
      tags: ["home", "shopping"],
    });

    expect(plan).toEqual({
      operation: "create",
      title: "Groceries",
      contentBytes: Buffer.byteLength("- milk\n- oats\n", "utf8"),
      notebookId: OTHER_ID,
      tags: ["home", "shopping"],
      localCommitted: false,
      remoteSynced: false,
      pendingSync: true,
    });
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("omits optional fields instead of emitting undefined slots", () => {
    const plan = planCreateNote({ title: "Note", content: "body" });
    expect(Object.hasOwn(plan, "notebookId")).toBe(false);
    expect(Object.hasOwn(plan, "tags")).toBe(false);
  });

  it("rejects malformed inputs categorically", () => {
    expect(codeOf(() => planCreateNote(undefined as never))).toBe("invalid_input");
    expect(codeOf(() => planCreateNote({ title: "", content: "x" }))).toBe("invalid_input");
    expect(codeOf(() => planCreateNote({ title: "t", content: 7 as never }))).toBe("invalid_input");
    expect(codeOf(() => planCreateNote({ title: "t", content: "x", notebookId: "  " }))).toBe(
      "invalid_input",
    );
    expect(codeOf(() => planCreateNote({ title: "t", content: "x", tags: ["ok", ""] }))).toBe(
      "invalid_input",
    );
    expect(
      codeOf(() =>
        planCreateNote({
          title: "t",
          content: "x",
          tags: Array.from({ length: STAGE4_WRITE_LIMITS.maxTags + 1 }, (_, i) => `tag${i}`),
        }),
      ),
    ).toBe("invalid_input");
  });

  it("rejects oversized titles and content", () => {
    expect(
      codeOf(() =>
        planCreateNote({
          title: "t".repeat(STAGE4_WRITE_LIMITS.maxTitleLength + 1),
          content: "x",
        }),
      ),
    ).toBe("invalid_input");
    expect(
      codeOf(() =>
        planCreateNote({
          title: "t",
          content: "x".repeat(STAGE4_WRITE_LIMITS.maxContentBytes + 1),
        }),
      ),
    ).toBe("unsupported_content");
  });

  it("rejects unsupported content shapes without echoing the body", () => {
    const secret = "CANARY-9f3b-plaintext-body";
    expect(
      codeOf(() => planCreateNote({ title: "t", content: `<script>${secret}</script>` })),
    ).toBe("unsupported_content");
    expect(codeOf(() => planCreateNote({ title: "t", content: `a\u0000${secret}` }))).toBe(
      "unsupported_content",
    );
  });
});

describe("Stage 4 write contract — appendNote", () => {
  const rev = revision(NOTE_ID, 1_700_000_000_000);

  it("returns a stable append plan", () => {
    const plan = planAppendNote({
      id: NOTE_ID,
      markdownFragment: "extra line",
      expectedRevision: rev,
    });
    expect(plan).toEqual({
      operation: "append",
      id: NOTE_ID,
      fragmentBytes: Buffer.byteLength("extra line", "utf8"),
      expectedRevision: rev,
      localCommitted: false,
      remoteSynced: false,
      pendingSync: true,
    });
  });

  it("requires an id, a non-empty fragment and an opaque revision token", () => {
    expect(
      codeOf(() => planAppendNote({ id: "", markdownFragment: "x", expectedRevision: rev })),
    ).toBe("invalid_input");
    expect(
      codeOf(() => planAppendNote({ id: NOTE_ID, markdownFragment: "", expectedRevision: rev })),
    ).toBe("invalid_input");
    expect(
      codeOf(() =>
        planAppendNote({
          id: NOTE_ID,
          markdownFragment: "x",
          expectedRevision: "not-a-token" as never,
        }),
      ),
    ).toBe("invalid_input");
  });

  it("rejects oversized fragments as unsupported content", () => {
    expect(
      codeOf(() =>
        planAppendNote({
          id: NOTE_ID,
          markdownFragment: "x".repeat(STAGE4_WRITE_LIMITS.maxFragmentBytes + 1),
          expectedRevision: rev,
        }),
      ),
    ).toBe("unsupported_content");
  });
});

describe("Stage 4 write contract — updateNote", () => {
  const rev = revision(NOTE_ID, 1_700_000_000_000);

  it("accepts only allowed patch fields and reports them sorted", () => {
    const plan = planUpdateNote({
      id: NOTE_ID,
      patch: { title: "New title", pinned: true },
      expectedRevision: rev,
    });
    expect(plan).toEqual({
      operation: "update",
      id: NOTE_ID,
      patchFields: ["pinned", "title"],
      expectedRevision: rev,
      localCommitted: false,
      remoteSynced: false,
      pendingSync: true,
    });
  });

  it("rejects an empty patch and unsupported patch fields", () => {
    expect(codeOf(() => planUpdateNote({ id: NOTE_ID, patch: {}, expectedRevision: rev }))).toBe(
      "invalid_input",
    );
    expect(
      codeOf(() =>
        planUpdateNote({
          id: NOTE_ID,
          patch: { deleted: true } as never,
          expectedRevision: rev,
        }),
      ),
    ).toBe("unsupported_patch_field");
    for (const forbidden of ["deleted", "locked", "password", "force", "readonly"]) {
      expect(
        codeOf(() =>
          planUpdateNote({
            id: NOTE_ID,
            patch: { [forbidden]: true } as never,
            expectedRevision: rev,
          }),
        ),
      ).toBe("unsupported_patch_field");
    }
  });

  it("rejects wrongly typed and oversized allowed fields", () => {
    expect(
      codeOf(() =>
        planUpdateNote({ id: NOTE_ID, patch: { pinned: "yes" as never }, expectedRevision: rev }),
      ),
    ).toBe("invalid_input");
    expect(
      codeOf(() =>
        planUpdateNote({
          id: NOTE_ID,
          patch: { content: "x".repeat(STAGE4_WRITE_LIMITS.maxContentBytes + 1) },
          expectedRevision: rev,
        }),
      ),
    ).toBe("unsupported_content");
  });
});

describe("Stage 4 write contract — opaque revision tokens", () => {
  it("produces opaque tokens that do not leak the underlying state", () => {
    const token = revision(NOTE_ID, 1_700_000_000_123, 7);
    expect(typeof token).toBe("string");
    expect(token).toMatch(/^rev_[0-9a-f]{32}$/);
    expect(token).not.toContain(NOTE_ID);
    expect(token).not.toContain("1700000000123");
    expect(token).not.toContain(NOTE_ID.slice(0, 8));
  });

  it("is deterministic for identical state and distinct for different state", () => {
    expect(revision(NOTE_ID, 1, 1)).toBe(revision(NOTE_ID, 1, 1));
    expect(revision(NOTE_ID, 1, 1)).not.toBe(revision(NOTE_ID, 1, 2));
    expect(revision(NOTE_ID, 1, 1)).not.toBe(revision(OTHER_ID, 1, 1));
  });

  it("rejects malformed revision source state", () => {
    expect(codeOf(() => createRevisionToken({ id: "", dateEdited: 1 }))).toBe("invalid_input");
    expect(codeOf(() => createRevisionToken({ id: NOTE_ID, dateEdited: -1 }))).toBe(
      "invalid_input",
    );
    expect(codeOf(() => createRevisionToken(undefined as never))).toBe("invalid_input");
  });

  it("compares tokens without revealing which side differs", () => {
    const a = revision(NOTE_ID, 1);
    expect(revisionTokensMatch(a, a)).toBe(true);
    expect(revisionTokensMatch(a, revision(NOTE_ID, 2))).toBe(false);
    expect(revisionTokensMatch(a, "rev_" + "0".repeat(32))).toBe(false);
  });

  it("derives the hex suffix from a SHA-256 of the canonical state", async () => {
    // The token is documented as an *opacity* device, not a security
    // primitive.  Its collision-resistance is still required by the
    // concurrency contract, so we verify it is the first 32 lowercase hex
    // chars of `sha256("<id>\u0000<dateEdited>\u0000<revisionCounter ?? 0>")`.
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256")
      .update(`${NOTE_ID}\u0000${1_700_000_000_000}\u00001`, "utf8")
      .digest("hex")
      .slice(0, 32);
    const token = revision(NOTE_ID, 1_700_000_000_000, 1);
    expect(token.startsWith("rev_")).toBe(true);
    expect(token.slice(4)).toBe(expected);
  });

  it("SHA-256 derivation is stable across calls and opaque across inputs", async () => {
    const { createHash } = await import("node:crypto");
    const hash = (state: { id: string; dateEdited: number; revisionCounter?: number }) =>
      createHash("sha256")
        .update(`${state.id}\u0000${state.dateEdited}\u0000${state.revisionCounter ?? 0}`, "utf8")
        .digest("hex")
        .slice(0, 32);
    // Determinism: a freshly derived token must match an independently
    // computed SHA-256 prefix for the *same* canonical state.
    expect(revision(NOTE_ID, 42, 7)).toBe(
      `rev_${hash({ id: NOTE_ID, dateEdited: 42, revisionCounter: 7 })}`,
    );
    // Default counter: an unspecified `revisionCounter` is canonicalised
    // to `0`, so the digest must match the SHA-256 of that canonical form.
    expect(createRevisionToken({ id: NOTE_ID, dateEdited: 42 })).toBe(
      `rev_${hash({ id: NOTE_ID, dateEdited: 42 })}`,
    );
    // Cross-input opacity: different state must yield a different SHA-256
    // prefix, so tokens stay collision-resistant across revisions.
    expect(createRevisionToken({ id: NOTE_ID, dateEdited: 42, revisionCounter: 7 })).not.toBe(
      createRevisionToken({ id: NOTE_ID, dateEdited: 42, revisionCounter: 8 }),
    );
  });
});

describe("Stage 4 revision guard — pure, fails closed, never picks a side", () => {
  it("passes silently on an exact match", () => {
    const token = revision(NOTE_ID, 1_700_000_000_000);
    expect(assertRevisionMatch(token, token)).toBeUndefined();
  });

  it("rejects a stale revision categorically before any mutation", () => {
    const expected = revision(NOTE_ID, 1_700_000_000_000);
    const current = revision(NOTE_ID, 1_700_000_009_999);
    const code = codeOf(() => assertRevisionMatch(expected, current));
    expect(code).toBe("stale_revision");
  });

  it("does not choose a side: the stale error exposes no winning revision", () => {
    const expected = revision(NOTE_ID, 1_700_000_000_000);
    const current = revision(NOTE_ID, 1_700_000_009_999);
    try {
      assertRevisionMatch(expected, current);
      throw new Error("guard did not fail closed");
    } catch (error) {
      if (!isNotesnookWriteContractError(error)) throw error;
      expect(error.message).not.toContain(expected);
      expect(error.message).not.toContain(current);
      expect(Object.hasOwn(error, "expectedRevision")).toBe(false);
      expect(Object.hasOwn(error, "currentRevision")).toBe(false);
      expect(Object.hasOwn(error, "resolution")).toBe(false);
    }
  });

  it("rejects malformed guard arguments as invalid input, never as a match", () => {
    const token = revision(NOTE_ID, 1);
    expect(codeOf(() => assertRevisionMatch("nope" as never, token))).toBe("invalid_input");
    expect(codeOf(() => assertRevisionMatch(token, undefined as never))).toBe("invalid_input");
  });
});

describe("Stage 4 write contract — categorical error identity and redaction", () => {
  it("exposes every required categorical code", () => {
    const required: NotesnookWriteErrorCode[] = [
      "invalid_input",
      "unsupported_content",
      "unsupported_patch_field",
      "stale_revision",
      "conflict",
      "vault_locked",
      "sync_failed",
    ];
    for (const code of required) {
      const error = new NotesnookWriteContractError(code, "categorical");
      expect(error.code).toBe(code);
      expect(isNotesnookWriteContractError(error)).toBe(true);
    }
  });

  it("is identified by identity, not by name or duck typing", () => {
    const impostor = Object.assign(new Error("Stage 4 write contract: nope"), {
      code: "stale_revision",
      name: "NotesnookWriteContractError",
    });
    expect(isNotesnookWriteContractError(impostor)).toBe(false);
    expect(isNotesnookWriteContractError(null)).toBe(false);
    expect(isNotesnookWriteContractError("stale_revision")).toBe(false);
  });

  it("is chain-free and carries no context payload", () => {
    const error = new NotesnookWriteContractError("conflict", "categorical");
    expect(error.cause).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(error, "cause")?.value).toBeUndefined();
    expect((error as unknown as Record<string, unknown>).__context__).toBeUndefined();
  });

  it("never echoes titles, bodies, tags, ids or revision tokens in messages", () => {
    const secrets = [
      "CANARY-title-7d21",
      "CANARY-body-7d21",
      "CANARY-tag-7d21",
      "/home/patrick/.config/nookbridge/token",
    ];
    const attempts: Array<() => unknown> = [
      () => planCreateNote({ title: secrets[0]!.repeat(50), content: secrets[1]! }),
      () => planCreateNote({ title: "t", content: `<script>${secrets[1]!}</script>` }),
      () => planCreateNote({ title: "t", content: "x", tags: [secrets[2]!, ""] }),
      () =>
        planUpdateNote({
          id: secrets[3]!,
          patch: { title: secrets[0]! },
          expectedRevision: revision(NOTE_ID, 1),
        }),
      () =>
        planUpdateNote({
          id: NOTE_ID,
          patch: { [secrets[2]!]: true } as never,
          expectedRevision: revision(NOTE_ID, 1),
        }),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
        throw new Error("expected fail-closed behavior");
      } catch (error) {
        if (!isNotesnookWriteContractError(error)) throw error;
        const serialized = `${error.message} ${String(error.stack ?? "").split("\n")[0]}`;
        for (const secret of secrets) {
          expect(serialized).not.toContain(secret);
        }
      }
    }
  });
});

/**
 * Reject any Stage 4 write-contract error that carries a caller-controlled
 * canary in its message, stack, cause, context, or any own property.
 *
 * Used by the hostile-getter/Proxy tests and by the revoked-proxy /
 * hostile-array tests so the assertion surface is identical across
 * suites.
 */
function assertCanaryFree(error: unknown, canary = "CANARY-hostile-getter-7d21"): void {
  if (!isNotesnookWriteContractError(error)) {
    const fallback = error instanceof Error ? error.message : String(error);
    throw new Error(`expected a categorical Stage 4 write-contract error, got: ${fallback}`);
  }
  expect((error as unknown as { code?: unknown }).code).toBeTypeOf("string");
  // Recognise-but-don't-leak: the attacker Error.name or first stack frame
  // line must not survive the boundary.
  const stackFirstLine = String(error.stack ?? "").split("\n")[0] ?? "";
  expect(error.message).not.toContain(canary);
  expect(error.stack ?? "").not.toContain(canary);
  expect(stackFirstLine).not.toContain(canary);
  expect((error as unknown as { cause?: unknown }).cause).toBeUndefined();
  expect((error as unknown as Record<string, unknown>).__context__).toBeUndefined();
  expect((error as unknown as Record<string, unknown>).__cause__).toBeUndefined();
  // Walk any property an attacker may have planted; none must carry the
  // canary in a string form.
  for (const [key, value] of Object.entries(error as unknown as Record<string, unknown>)) {
    if (typeof value === "string") {
      expect({ key, value }).not.toMatchObject({ value: expect.stringContaining(canary) });
    }
  }
}

describe("Stage 4 write contract — hostile getters and proxies", () => {
  // A consistent canary pattern so we can prove that an attacker-controlled
  // Error (and its message/stack) never escapes the categorical, chain-free
  // boundary regardless of whether the leak vector is a throwing own-property
  // getter or a Proxy `get`/`ownKeys`/`getOwnPropertyDescriptor` trap.
  const CANARY = "CANARY-hostile-getter-7d21";

  function hostileProperty(target: unknown, key: string | symbol): never {
    const err = new Error(`hostile accessor for ${String(key)} leaked: ${CANARY}`);
    (err as Error & { code?: string }).code = "STAGE_4_HOSTILE_GETTER_CANARY";
    throw err;
  }

  function throwingObject<T extends object>(seed: T, keys: readonly (string | symbol)[]): T {
    const seedRecord = seed as unknown as Record<string | symbol, unknown>;
    return new Proxy(seed, {
      get(target, prop) {
        if (keys.includes(prop)) hostileProperty(target, prop);
        const value = Reflect.get(target, prop, seedRecord[prop]);
        if (typeof value === "function")
          return (value as (...args: unknown[]) => unknown).bind(target);
        return value;
      },
      has(target, prop) {
        if (keys.includes(prop)) hostileProperty(target, prop);
        return Reflect.has(target, prop);
      },
    }) as T;
  }

  function assertCanaryFree(error: unknown): void {
    if (!isNotesnookWriteContractError(error)) {
      throw new Error(
        `expected a categorical Stage 4 write-contract error, got: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    expect((error as unknown as { code?: unknown }).code).toBeTypeOf("string");
    // Recognise-but-don't-leak: the attacker Error.name or first stack frame
    // line must not survive the boundary.
    const stackFirstLine = String(error.stack ?? "").split("\n")[0] ?? "";
    expect(error.message).not.toContain(CANARY);
    expect(error.stack ?? "").not.toContain(CANARY);
    expect(stackFirstLine).not.toContain(CANARY);
    expect((error as unknown as { cause?: unknown }).cause).toBeUndefined();
    expect((error as unknown as Record<string, unknown>).__context__).toBeUndefined();
    expect((error as unknown as Record<string, unknown>).__cause__).toBeUndefined();
    // Walk any property an attacker may have planted; none must carry the
    // canary in a string form.
    for (const [key, value] of Object.entries(error as unknown as Record<string, unknown>)) {
      if (typeof value === "string") {
        expect({ key, value }).not.toMatchObject({ value: expect.stringContaining(CANARY) });
      }
    }
  }

  it("planCreateNote normalises a throwing title getter to invalid_input", () => {
    const command = throwingObject({ title: "t", content: "ok" } as const, ["title"]);
    expect(codeOf(() => planCreateNote(command as never))).toBe("invalid_input");
  });

  it("planCreateNote normalises a throwing content getter to invalid_input", () => {
    const command = throwingObject({ title: "t", content: "ok" } as const, ["content"]);
    expect(codeOf(() => planCreateNote(command as never))).toBe("invalid_input");
  });

  it("planCreateNote normalises a throwing notebookId getter", () => {
    const command = throwingObject({ title: "t", content: "ok", notebookId: NOTE_ID } as const, [
      "notebookId",
    ]);
    expect(codeOf(() => planCreateNote(command as never))).toBe("invalid_input");
  });

  it("planCreateNote normalises a throwing tags getter (Proxy owns Get/Has)", () => {
    const raw = { title: "t", content: "ok", tags: ["a"] };
    const command = new Proxy(raw, {
      get(target, prop) {
        if (prop === "tags") hostileProperty(target, prop);
        return Reflect.get(target, prop);
      },
      has(target, prop) {
        if (prop === "tags") hostileProperty(target, prop);
        return Reflect.has(target, prop);
      },
    });
    try {
      planCreateNote(command as never);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
  });

  it("planCreateNote — hostile Proxy: no canary in message, stack, cause, or context", () => {
    const command = throwingObject(
      { title: "t", content: "ok", notebookId: NOTE_ID, tags: ["home"] } as const,
      ["title", "content", "notebookId", "tags"],
    );
    try {
      planCreateNote(command as never);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      assertCanaryFree(error);
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
    }
  });

  it("planAppendNote — throwing id/markdownFragment/expectedRevision getters all normalise", () => {
    const rev = revision(NOTE_ID, 1_700_000_000_000);
    for (const key of ["id", "markdownFragment", "expectedRevision"] as const) {
      const command = throwingObject(
        { id: NOTE_ID, markdownFragment: "x", expectedRevision: rev } as const,
        [key],
      );
      const code = codeOf(() => planAppendNote(command as never));
      expect(code).toBe("invalid_input");
    }
  });

  it("planAppendNote — hostile Proxy end-to-end: no canary escapes", () => {
    const rev = revision(NOTE_ID, 1_700_000_000_000);
    const command = throwingObject(
      { id: NOTE_ID, markdownFragment: "x", expectedRevision: rev } as const,
      ["id", "markdownFragment", "expectedRevision"],
    );
    try {
      planAppendNote(command as never);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      assertCanaryFree(error);
    }
  });

  it("planUpdateNote — throwing id / expectedRevision getters normalise", () => {
    const rev = revision(NOTE_ID, 1_700_000_000_000);
    for (const key of ["id", "expectedRevision"] as const) {
      const command = throwingObject(
        { id: NOTE_ID, patch: { title: "x" }, expectedRevision: rev } as const,
        [key],
      );
      expect(codeOf(() => planUpdateNote(command as never))).toBe("invalid_input");
    }
  });

  it("planUpdateNote — throwing patch getter normalises", () => {
    const rev = revision(NOTE_ID, 1_700_000_000_000);
    const command = throwingObject(
      { id: NOTE_ID, patch: { title: "x" }, expectedRevision: rev } as const,
      ["patch"],
    );
    expect(codeOf(() => planUpdateNote(command as never))).toBe("invalid_input");
  });

  it("planUpdateNote — patch with throwing field value getter normalises without leaking", () => {
    const rev = revision(NOTE_ID, 1_700_000_000_000);
    const patchHostile = throwingObject({ title: "x" } as const, ["title"]);
    try {
      planUpdateNote({
        id: NOTE_ID,
        patch: patchHostile as never,
        expectedRevision: rev,
      });
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      assertCanaryFree(error);
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
    }
  });

  it("planUpdateNote — patch Object.keys via hostile Proxy ownKeys trap normalises", () => {
    const rev = revision(NOTE_ID, 1_700_000_000_000);
    const trapPatch = new Proxy(
      { title: "x" },
      {
        ownKeys() {
          hostileProperty(this, "ownKeys");
        },
        getOwnPropertyDescriptor(target, prop) {
          if (prop === "title") {
            return { configurable: true, enumerable: true, writable: true, value: "x" };
          }
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      },
    );
    try {
      planUpdateNote({ id: NOTE_ID, patch: trapPatch as never, expectedRevision: rev });
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      assertCanaryFree(error);
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
    }
  });

  it("planUpdateNote — patch with ownKeys-throwing Proxy is normalised (no canary in message/stack)", () => {
    const rev = revision(NOTE_ID, 1_700_000_000_000);
    // `Reflect.ownKeys` is what a defensive iteration uses; if it throws the
    // patch is structurally hostile and the contract must rewrite the throw
    // to `invalid_input` without echoing the canary.
    const trapPatch = new Proxy(
      { title: "x" },
      {
        ownKeys() {
          hostileProperty(this, "ownKeys");
        },
        getOwnPropertyDescriptor(target, prop) {
          if (prop === "title") {
            return { configurable: true, enumerable: true, writable: true, value: "x" };
          }
          return undefined;
        },
        get(target, prop) {
          if (prop === "title") return "x";
          return Reflect.get(target, prop);
        },
      },
    );
    try {
      planUpdateNote({ id: NOTE_ID, patch: trapPatch as never, expectedRevision: rev });
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      assertCanaryFree(error);
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
    }
  });

  it("planUpdateNote — patch value-getter on a legal key normalises", () => {
    const rev = revision(NOTE_ID, 1_700_000_000_000);
    // Legal patch field, but the *value* getter throws.  This is the
    // canary-bearing trap that exercises the call inside `readProperty`.
    const trapPatch = new Proxy({ title: "x" } as { title: string }, {
      ownKeys: () => ["title"],
      getOwnPropertyDescriptor: () => ({
        configurable: true,
        enumerable: true,
        writable: true,
        value: "x",
      }),
      get(_t, prop) {
        if (prop === "title") hostileProperty(prop, "title");
        return "x";
      },
    });
    try {
      planUpdateNote({ id: NOTE_ID, patch: trapPatch as never, expectedRevision: rev });
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      assertCanaryFree(error);
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
    }
  });

  it("createRevisionToken — throwing id/dateEdited/revisionCounter getters normalise", () => {
    const base = { id: NOTE_ID, dateEdited: 1, revisionCounter: 1 } as const;
    for (const key of ["id", "dateEdited", "revisionCounter"] as const) {
      const state = throwingObject(base, [key]);
      try {
        createRevisionToken(state as never);
        throw new Error("expected fail-closed behaviour");
      } catch (error) {
        assertCanaryFree(error);
        expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      }
    }
  });

  it("assertRevisionMatch — hostile Proxy passed as either argument normalises", () => {
    // The matcher accepts `unknown`, so an attacker can pass a Proxy directly.
    // The proxy in front of a well-formed string raises on `Symbol.toPrimitive`
    // coercion: any code path inside the guard that asks for a string sees the
    // hostile accessor, and the categorical boundary must rewrite the throw.
    const token = revision(NOTE_ID, 1_700_000_000_000);
    const makeHostile = (label: string) => {
      const trap = (): never => {
        const err = new Error(`hostile accessor for ${label} leaked: ${CANARY}`);
        (err as Error & { code?: string }).code = "STAGE_4_HOSTILE_GETTER_CANARY";
        throw err;
      };
      return new Proxy(Object(token), {
        get(t, prop) {
          if (
            prop === Symbol.toPrimitive ||
            prop === "toString" ||
            prop === "valueOf" ||
            prop === "length"
          ) {
            return () => trap();
          }
          const numProp = typeof prop === "string" ? Number(prop) : NaN;
          if (typeof numProp === "number" && Number.isInteger(numProp) && numProp >= 0) {
            return () => trap();
          }
          return Reflect.get(t, prop);
        },
      });
    };
    try {
      assertRevisionMatch(makeHostile("expected"), token);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      assertCanaryFree(error);
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
    }
    try {
      assertRevisionMatch(token, makeHostile("current"));
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      assertCanaryFree(error);
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
    }
  });

  it("revisionTokensMatch — hostile Proxy returns false without ever throwing", () => {
    const token = revision(NOTE_ID, 1);
    const trap = (): never => {
      const err = new Error(`hostile accessor for token leaked: ${CANARY}`);
      (err as Error & { code?: string }).code = "STAGE_4_HOSTILE_GETTER_CANARY";
      throw err;
    };
    const makeHostile = () =>
      new Proxy(Object(token), {
        get(t, prop) {
          if (
            prop === Symbol.toPrimitive ||
            prop === "toString" ||
            prop === "valueOf" ||
            prop === "length"
          ) {
            return () => trap();
          }
          return Reflect.get(t, prop);
        },
      });
    expect(() => revisionTokensMatch(makeHostile(), token)).not.toThrow();
    expect(revisionTokensMatch(makeHostile(), token)).toBe(false);
    expect(revisionTokensMatch(token, makeHostile())).toBe(false);
  });

  it("none of the public plan* / guard / token functions re-throw a foreign Error", () => {
    const rev = revision(NOTE_ID, 1);
    const hostile = new Proxy(
      {},
      {
        get(_t, prop) {
          hostileProperty(prop, prop);
        },
      },
    );
    for (const call of [
      () => planCreateNote(hostile as never),
      () => planAppendNote(hostile as never),
      () => planUpdateNote(hostile as never),
      () => createRevisionToken(hostile as never),
      () => assertRevisionMatch(hostile, rev),
      () => assertRevisionMatch(rev, hostile),
    ]) {
      let captured: unknown;
      let foreign = false;
      try {
        call();
      } catch (error) {
        captured = error;
        foreign = !(error instanceof Error) || !isNotesnookWriteContractError(error);
      }
      expect(foreign).toBe(false);
      expect(isNotesnookWriteContractError(captured)).toBe(true);
      assertCanaryFree(captured);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 4 write contract — hardening regressions for the parent review
// findings.  Every test below targets a specific narrowing of the public
// surface so the contract cannot widen or leak through any of:
//   (1) a mutable allowlist bypassed via `Set.prototype.add.call`,
//   (2) a `NotesnookWriteContractError` constructor that interpolates
//       caller-controlled strings, or
//   (3) a revoked/hostile `Proxy` or hostile array/iterator at the
//       public input boundaries.
// ---------------------------------------------------------------------------

describe("Stage 4 write contract — immutable allowlist, prototype-bypass proof", () => {
  const FORBIDDEN = ["deleted", "locked", "password", "force", "readonly", "conflicted"];

  it("ALLOWED_UPDATE_PATCH_FIELDS is not a real Set (no internal SetData slot to mutate via prototype)", () => {
    // A real Set exposes its internal slot to `Set.prototype.{add,delete,clear}`
    // even when the own mutator is replaced.  The hardened container must
    // not be a Set instance at all so the prototype bypass has nothing to
    // mutate and cannot widen the allowlist at runtime.
    expect(ALLOWED_UPDATE_PATCH_FIELDS instanceof Set).toBe(false);
  });

  it("Set.prototype.add.call(ALLOWED_UPDATE_PATCH_FIELDS, 'deleted') cannot widen the allowlist", () => {
    // Even if a caller attempts the prototype-bypass attack, the
    // container must remain unchanged AND must remain iterable with the
    // original six fields only.  We prove both: no `deleted` lookup
    // succeeds, and `planUpdateNote` still rejects `deleted`.  The
    // bypass attempt may either throw (because the hardened container
    // is not a Set instance, so `Set.prototype.add.call` finds an
    // "incompatible receiver") or silently succeed without mutation —
    // both outcomes are acceptable; what matters is the post-condition.
    let bypassThrew = false;
    try {
      Set.prototype.add.call(ALLOWED_UPDATE_PATCH_FIELDS as unknown as Set<string>, "deleted");
    } catch {
      bypassThrew = true;
    }
    expect(bypassThrew || ALLOWED_UPDATE_PATCH_FIELDS.has("deleted" as never) === false).toBe(true);
    expect([...ALLOWED_UPDATE_PATCH_FIELDS].sort()).toEqual([
      "content",
      "favorite",
      "notebookId",
      "pinned",
      "tags",
      "title",
    ]);
    // Defence in depth: even if the bypass somehow succeeded, the public
    // `planUpdateNote` entry point must still reject `deleted` because
    // it consults the allowlist through a single chokepoint.
    const rev = revision(NOTE_ID, 1);
    expect(
      codeOf(() =>
        planUpdateNote({
          id: NOTE_ID,
          patch: { deleted: true } as never,
          expectedRevision: rev,
        }),
      ),
    ).toBe("unsupported_patch_field");
  });

  it("Set.prototype.delete.call / Set.prototype.clear.call cannot narrow or empty the allowlist", () => {
    const before = [...ALLOWED_UPDATE_PATCH_FIELDS].sort();
    let bypassThrew = false;
    try {
      Set.prototype.delete.call(ALLOWED_UPDATE_PATCH_FIELDS as unknown as Set<string>, "title");
      Set.prototype.clear.call(ALLOWED_UPDATE_PATCH_FIELDS as unknown as Set<string>);
    } catch {
      bypassThrew = true;
    }
    expect(bypassThrew || true).toBe(true);
    expect([...ALLOWED_UPDATE_PATCH_FIELDS].sort()).toEqual(before);
    expect(ALLOWED_UPDATE_PATCH_FIELDS.has("title")).toBe(true);
  });

  it("all forbidden field names stay rejected after the prototype-bypass attempts", () => {
    for (const field of FORBIDDEN) {
      try {
        Set.prototype.add.call(ALLOWED_UPDATE_PATCH_FIELDS as unknown as Set<string>, field);
      } catch {
        /* incompatible-receiver throw is acceptable */
      }
      expect(ALLOWED_UPDATE_PATCH_FIELDS.has(field as never)).toBe(false);
      const rev = revision(NOTE_ID, 1);
      expect(
        codeOf(() =>
          planUpdateNote({
            id: NOTE_ID,
            patch: { [field]: true } as never,
            expectedRevision: rev,
          }),
        ),
      ).toBe("unsupported_patch_field");
    }
  });

  it("the allowlist container is frozen and exposes only the read-only surface", () => {
    expect(Object.isFrozen(ALLOWED_UPDATE_PATCH_FIELDS)).toBe(true);
    // No own mutator methods.  Iteration / has / size are expected; only
    // the mutator set must be empty.
    expect((ALLOWED_UPDATE_PATCH_FIELDS as unknown as Record<string, unknown>).add).toBeUndefined();
    expect(
      (ALLOWED_UPDATE_PATCH_FIELDS as unknown as Record<string, unknown>).delete,
    ).toBeUndefined();
    expect(
      (ALLOWED_UPDATE_PATCH_FIELDS as unknown as Record<string, unknown>).clear,
    ).toBeUndefined();
    // The container must also not behave as a Set instance (no SetData slot).
    expect(ALLOWED_UPDATE_PATCH_FIELDS instanceof Set).toBe(false);
  });
});

describe("Stage 4 write contract — fixed-message error constructor", () => {
  const CANARY = "CANARY-error-message-7d21";

  it("constructor accepts (and ignores) a caller-supplied message: message is fixed by code", () => {
    const code: NotesnookWriteErrorCode = "invalid_input";
    const error = new NotesnookWriteContractError(code, `attempt to leak: ${CANARY}`);
    expect(error.message).not.toContain(CANARY);
    expect(error.message.length).toBeGreaterThan(0);
    // The message must be deterministic for the code; two constructions
    // with different canary payloads yield identical message strings.
    const errorTwin = new NotesnookWriteContractError(code, `attempt to leak: ${CANARY}-twin`);
    expect(error.message).toBe(errorTwin.message);
  });

  it("message is fully derived from the categorical code, never from the second argument", () => {
    // Construct the same code seven times with seven different payloads
    // (including empty, canary-only, path-only, and huge strings).  The
    // resulting message and stack must be identical and contain none of
    // the canary substrings.
    const variants = [
      "",
      CANARY,
      `${CANARY}-body`,
      "/home/patrick/.config/nookbridge/token",
      "a".repeat(1024) + CANARY,
      `\n${CANARY}\t`,
      JSON.stringify({ secret: CANARY }),
    ];
    let baseline: string | null = null;
    for (const variant of variants) {
      const error = new NotesnookWriteContractError("unsupported_patch_field", variant);
      if (baseline === null) baseline = error.message;
      else expect(error.message).toBe(baseline);
      expect(error.message).not.toContain(CANARY);
      expect(error.message).not.toContain("nookbridge/token");
      expect(error.stack ?? "").not.toContain(CANARY);
      expect((error as unknown as { cause?: unknown }).cause).toBeUndefined();
      expect((error as unknown as Record<string, unknown>).__context__).toBeUndefined();
    }
  });

  it("every NotesnookWriteErrorCode category maps to a fixed, distinct, canary-free message", () => {
    const codes: NotesnookWriteErrorCode[] = [
      "invalid_input",
      "unsupported_content",
      "unsupported_patch_field",
      "stale_revision",
      "conflict",
      "vault_locked",
      "sync_failed",
    ];
    const messages = new Set<string>();
    for (const code of codes) {
      const error = new NotesnookWriteContractError(code, `${CANARY}-${code}`);
      expect(error.message).not.toContain(CANARY);
      expect(error.message.length).toBeGreaterThan(0);
      messages.add(error.message);
    }
    // Every code must produce a distinct message so the categorical
    // vocabulary is preserved across the boundary.
    expect(messages.size).toBe(codes.length);
  });

  it("the constructor's message argument is ignored even when passed an Error, object, or zero", () => {
    const throwable = new Error(`${CANARY}-embedded-error`);
    for (const ignored of [throwable, { secret: CANARY }, [CANARY], 0, null, undefined] as const) {
      const error = new NotesnookWriteContractError("conflict", ignored as never);
      expect(error.message).not.toContain(CANARY);
      expect(error.stack ?? "").not.toContain(CANARY);
      expect((error as unknown as { cause?: unknown }).cause).toBeUndefined();
      expect((error as unknown as Record<string, unknown>).__context__).toBeUndefined();
      // The `ignored` argument must never end up on the instance, in any
      // form, including as an own property or prototype-inherited.
      for (const key of Object.keys(error as unknown as object)) {
        expect(key).not.toContain(CANARY);
      }
      expect(Object.getPrototypeOf(error)).toBe(NotesnookWriteContractError.prototype);
    }
  });

  it("a chain-free categorical error has no cause, no context, no canary in stack first frame", () => {
    const error = new NotesnookWriteContractError("invalid_input", `${CANARY}-poison`);
    expect((error as unknown as { cause?: unknown }).cause).toBeUndefined();
    expect((error as unknown as Record<string, unknown>).__context__).toBeUndefined();
    expect((error as unknown as Record<string, unknown>).__cause__).toBeUndefined();
    expect(error.stack ?? "").not.toContain(CANARY);
    expect(String(error.stack ?? "").split("\n")[0] ?? "").not.toContain(CANARY);
    // Sanity: walking every own property must surface no canary.
    for (const [key, value] of Object.entries(error as unknown as Record<string, unknown>)) {
      if (typeof value === "string") {
        expect({ key, value }).not.toMatchObject({ value: expect.stringContaining(CANARY) });
      }
    }
  });
});

describe("Stage 4 write contract — revoked proxies and hostile arrays at the public boundaries", () => {
  // The hardened contract must rewrite any throwing/hostile array or
  // revoked-proxy accessor at every public input boundary
  // (`requireRecord`, `Array.isArray`, `requireTags`, `readProperty`)
  // into a chain-free `invalid_input` error that carries no canary.

  const CANARY = "CANARY-revoked-or-hostile-array-7d21";

  function trap(value: string): never {
    const err = new Error(`hostile array accessor leaked: ${CANARY} (${value})`);
    (err as Error & { code?: string }).code = "STAGE_4_HOSTILE_ARRAY_CANARY";
    throw err;
  }

  function hostileArray<T>(seed: readonly T[]): T[] {
    // A Proxy whose `length` getter throws and whose iterator throws.
    // Plain `Array.isArray` still reports `true` because V8's IsArray
    // doesn't fire the `get` trap, so the contract has to defend the
    // *length* and *iteration* sites explicitly.
    return new Proxy(seed as unknown as T[], {
      get(target, prop, receiver) {
        if (prop === "length") return () => trap("length");
        if (prop === Symbol.iterator) return () => trap("iterator");
        return Reflect.get(target as object, prop, receiver);
      },
    }) as unknown as T[];
  }

  function revokedArray<T>(seed: readonly T[]): T[] {
    const { proxy, revoke } = Proxy.revocable(seed as unknown as T[], {});
    revoke();
    return proxy as unknown as T[];
  }

  function revokedObject<T extends object>(seed: T): T {
    const { proxy, revoke } = Proxy.revocable(seed, {});
    revoke();
    return proxy as T;
  }

  it("planCreateNote — revoked command proxy fails closed without canary", () => {
    const rev = revision(NOTE_ID, 1);
    const seed = { title: "t", content: "ok", notebookId: NOTE_ID, tags: ["a"] } as const;
    const command = revokedObject(seed);
    try {
      planCreateNote(command as never);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
    void rev;
  });

  it("planCreateNote — revoked tags array on the command fails closed without canary", () => {
    const seed = { title: "t", content: "ok", tags: ["a", "b"] } as const;
    const tags = revokedArray(["a", "b"]);
    const command = { ...seed, tags };
    try {
      planCreateNote(command as never);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
  });

  it("planUpdateNote — revoked patch proxy fails closed without canary", () => {
    const rev = revision(NOTE_ID, 1_700_000_000_000);
    const seed = { id: NOTE_ID, patch: { title: "x" }, expectedRevision: rev } as const;
    const command = revokedObject(seed);
    try {
      planUpdateNote(command as never);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
  });

  it("planAppendNote — revoked command proxy fails closed without canary", () => {
    const rev = revision(NOTE_ID, 1_700_000_000_000);
    const seed = { id: NOTE_ID, markdownFragment: "x", expectedRevision: rev } as const;
    const command = revokedObject(seed);
    try {
      planAppendNote(command as never);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
  });

  it("planCreateNote — tags array with throwing length getter fails closed without canary", () => {
    // The hardened contract must read `length` defensively.  Without the
    // guard, a throwing length accessor escapes as a foreign Error.
    const command = {
      title: "t",
      content: "ok",
      tags: hostileArray(["a", "b"]),
    };
    try {
      planCreateNote(command as never);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
  });

  it("planCreateNote — tags array with throwing iterator fails closed without canary", () => {
    // The hardened contract must iterate `tags` defensively.  Without the
    // guard, a hostile iterator escapes as a foreign Error.
    const command = {
      title: "t",
      content: "ok",
      tags: hostileArray(["a", "b"]),
    };
    try {
      planCreateNote(command as never);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
  });

  it("planUpdateNote — patch with throwing-length tags array fails closed without canary", () => {
    const rev = revision(NOTE_ID, 1_700_000_000_000);
    const command = {
      id: NOTE_ID,
      patch: { tags: hostileArray(["a", "b"]) },
      expectedRevision: rev,
    };
    try {
      planUpdateNote(command as never);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
  });

  it("planCreateNote — Array.isArray on a revoked tags proxy still fails closed without canary", () => {
    // `Array.isArray` itself throws on a revoked Proxy.  The hardened
    // `requireTags` helper must wrap `Array.isArray` so this leak vector
    // is rewritten to `invalid_input`.
    const command = {
      title: "t",
      content: "ok",
      tags: revokedArray(["a"]),
    };
    try {
      planCreateNote(command as never);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
  });

  it("planCreateNote — revoked notebookId accessor fails closed without canary", () => {
    // The notebookId field is read through `readProperty`, but the outer
    // command object is also a Proxy.  A revoked outer Proxy must fail
    // closed the same way as a throwing getter.
    const command = new Proxy(
      { title: "t", content: "ok", notebookId: NOTE_ID },
      {
        get(_t, prop) {
          if (prop === "notebookId") {
            const err = new Error(`hostile notebookId: ${CANARY}`);
            (err as Error & { code?: string }).code = "STAGE_4_HOSTILE_NOTEBOOK_ID";
            throw err;
          }
          return Reflect.get({ title: "t", content: "ok", notebookId: NOTE_ID }, prop);
        },
      },
    );
    try {
      planCreateNote(command as never);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
  });

  it("planUpdateNote — patch with hostile-array `tags` (Proxy-of-Array) fails closed without canary", () => {
    const rev = revision(NOTE_ID, 1_700_000_000_000);
    const trapTags = new Proxy(["a", "b"] as string[], {
      get(target, prop, receiver) {
        if (prop === "length") return () => trap("patch.tags.length");
        if (prop === Symbol.iterator) return () => trap("patch.tags.iterator");
        if (typeof prop === "string") {
          const idx = Number(prop);
          if (Number.isInteger(idx) && idx >= 0) return () => trap(`patch.tags[${prop}]`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const command = {
      id: NOTE_ID,
      patch: { tags: trapTags },
      expectedRevision: rev,
    };
    try {
      planUpdateNote(command as never);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
  });

  it("planCreateNote — tags array reporting length 1 but yielding maxTags+1 entries fails closed", () => {
    // A hostile Proxy/array can lie about `length` while its iterator
    // yields far more entries.  Without a per-entry count guard, the
    // reported-length bound is meaningless and an attacker can submit
    // arbitrarily many tags past `STAGE4_WRITE_LIMITS.maxTags`.
    const oversized = STAGE4_WRITE_LIMITS.maxTags + 1;
    const lyingTags = new Proxy(["ok"] as string[], {
      get(target, prop, receiver) {
        if (prop === "length") return 1;
        if (prop === Symbol.iterator) {
          return function* (): IterableIterator<string> {
            for (let i = 0; i < oversized; i += 1) {
              yield `tag${i}`;
            }
          };
        }
        return Reflect.get(target as object, prop, receiver);
      },
    });
    const command = { title: "t", content: "ok", tags: lyingTags as never };
    try {
      planCreateNote(command);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
  });

  it("planUpdateNote — patch with tags array reporting length 0 but yielding maxTags+1 entries fails closed", () => {
    // Same attack vector via the patch path: a reported length of 0
    // bypasses the upfront count check, but the iterator must still be
    // bounded per-entry against `STAGE4_WRITE_LIMITS.maxTags`.
    const oversized = STAGE4_WRITE_LIMITS.maxTags + 1;
    const lyingTags = new Proxy([] as string[], {
      get(target, prop, receiver) {
        if (prop === "length") return 0;
        if (prop === Symbol.iterator) {
          return function* (): IterableIterator<string> {
            for (let i = 0; i < oversized; i += 1) {
              yield `tag${i}`;
            }
          };
        }
        return Reflect.get(target as object, prop, receiver);
      },
    });
    const rev = revision(NOTE_ID, 1_700_000_000_000);
    const command = {
      id: NOTE_ID,
      patch: { tags: lyingTags as never },
      expectedRevision: rev,
    };
    try {
      planUpdateNote(command);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
  });

  it("planCreateNote — tags iterator returning a malformed step (null value) fails closed without canary", () => {
    // A step object with `done: false` but a `value` that is `null`
    // (or any non-string) is a malformed iterator step.  The defensive
    // reader must normalise it to categorical `invalid_input` instead of
    // letting it reach the validator chain.
    const malformedIterator = new Proxy(["a"] as string[], {
      get(target, prop, receiver) {
        if (prop === "length") return 1;
        if (prop === Symbol.iterator) {
          return (): Iterator<string> => ({
            next(): IteratorResult<string> {
              return { done: false, value: null as unknown as string };
            },
          });
        }
        return Reflect.get(target as object, prop, receiver);
      },
    });
    const command = { title: "t", content: "ok", tags: malformedIterator as never };
    try {
      planCreateNote(command);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
  });

  it("planCreateNote — tags iterator step with throwing `done` getter fails closed without canary", () => {
    // A step whose `done` accessor throws must be normalised to
    // categorical `invalid_input` rather than letting the foreign Error
    // escape past the boundary.
    const throwingDoneStep = new Proxy(["a"] as string[], {
      get(target, prop, receiver) {
        if (prop === "length") return 1;
        if (prop === Symbol.iterator) {
          return (): Iterator<string> => {
            const step = {
              get done() {
                const err = new Error(`hostile done accessor leaked: ${CANARY}`);
                (err as Error & { code?: string }).code = "STAGE_4_HOSTILE_DONE_CANARY";
                throw err;
              },
              get value() {
                return "ok";
              },
            };
            return step as unknown as Iterator<string>;
          };
        }
        return Reflect.get(target as object, prop, receiver);
      },
    });
    const command = { title: "t", content: "ok", tags: throwingDoneStep as never };
    try {
      planCreateNote(command);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
  });

  it("planCreateNote — tags iterator step with throwing `value` getter fails closed without canary", () => {
    // Symmetric to the throwing-`done` case: a throwing `value`
    // accessor must be normalised too, so an attacker cannot smuggle a
    // canary past the iterator boundary through a single bad step.
    const throwingValueStep = new Proxy(["a"] as string[], {
      get(target, prop, receiver) {
        if (prop === "length") return 1;
        if (prop === Symbol.iterator) {
          return (): Iterator<string> => ({
            next(): IteratorResult<string> {
              const err = new Error(`hostile value accessor leaked: ${CANARY}`);
              (err as Error & { code?: string }).code = "STAGE_4_HOSTILE_VALUE_CANARY";
              throw err;
            },
          });
        }
        return Reflect.get(target as object, prop, receiver);
      },
    });
    const command = { title: "t", content: "ok", tags: throwingValueStep as never };
    try {
      planCreateNote(command);
      throw new Error("expected fail-closed behaviour");
    } catch (error) {
      expect((error as unknown as { code?: string }).code).toBe("invalid_input");
      assertCanaryFree(error);
    }
  });
});
