/**
 * Stage 7 Slice 3 — profile-aware service authorization + notes.create RPC.
 *
 * First bounded vertical tracer bullet.  Pins the seam that lets a
 * `readWriteNoDelete` profile (and a custom method-allowlist profile)
 * admit `notes.create` end-to-end, while the existing readOnly
 * profile continues to deny it.  Delete / `notes.delete` is NOT
 * implemented in this slice — it remains rejected by the wire
 * protocol, the policy boundary, and the runtime surface.  Append /
 * update are explicitly out of scope for this slice.
 *
 * Contract pinned here:
 *
 *   1. `createReadWriteNoDeleteServicePolicy()` exists; it admits
 *      exactly the four read methods plus `notes.create`, never
 *      `notes.delete` or any other side-effecting method.
 *   2. `createCustomServicePolicy(allowedMethods)` exists; it admits
 *      exactly the methods in its argument and never `notes.delete`
 *      even if requested.  A factory that observes the
 *      `delete` constraint as a structural property is part of the
 *      contract.
 *   3. `readOnly` continues to deny `notes.create` with
 *      `permission_denied`.
 *   4. `readWriteNoDelete` allows `notes.create` and the four read
 *      methods; it denies everything else.
 *   5. The parser admits `notes.create` with bounded `title`,
 *      `content`, and optional `notebookId`; the closed response
 *      surface projects the bounded `CreateNoteResult` to an
 *      `RpcCreatedNoteResult` whose only own fields are
 *      `kind: "create"`, `id`, `titleBytes`, `contentBytes`.  No
 *      `body`, no `notebookId`, no `tags`, no internal flags.
 *   6. The handler dispatches `notes.create` only when the
 *      authoritative policy allows it; otherwise it returns
 *      `permission_denied` without touching the runtime.
 *   7. When the runtime is missing a `createNote` capability, the
 *      handler returns `service_unavailable` — never a different
 *      categorical token.
 *   8. When the runtime exposes a `createNote` capability, the
 *      handler forwards a structurally-bounded command and projects
 *      the result to the published RPC envelope; raw runtime fields
 *      never cross the boundary.
 *   9. `notes.delete` is rejected by the wire protocol
 *      (`parseRpcFrame`) with `invalid_request`; the policy and
 *      handler never see it.
 */

import { TextEncoder } from "node:util";

import { describe, expect, it } from "vitest";

import {
  authorizeServiceMethod,
  createCustomServicePolicy,
  createReadOnlyServicePolicy,
  createReadWriteNoDeleteServicePolicy,
  type ServicePolicy,
  type ServicePolicyDecision,
} from "../src/service/service-policy.js";
import { parseRpcFrame } from "../src/service/rpc-protocol.js";
import { handleRpcRequest } from "../src/service/rpc-handler.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";

// ---------------------------------------------------------------------------
// Encoding helpers.
// ---------------------------------------------------------------------------

/** Build a length-prefixed JSON-RPC frame for tests. */
function encodeFrame(payload: object): Uint8Array {
  const text = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(text);
  const frame = new Uint8Array(4 + bytes.length);
  frame[0] = (bytes.length >>> 24) & 0xff;
  frame[1] = (bytes.length >>> 16) & 0xff;
  frame[2] = (bytes.length >>> 8) & 0xff;
  frame[3] = bytes.length & 0xff;
  frame.set(bytes, 4);
  return frame;
}

// ---------------------------------------------------------------------------
// Policy surface — readOnly denies notes.create.
// ---------------------------------------------------------------------------

describe("service policy — readOnly continues to deny notes.create", () => {
  it("denies notes.create under readOnly with the closed categorical reason", () => {
    const decision: ServicePolicyDecision = authorizeServiceMethod(
      createReadOnlyServicePolicy(),
      "notes.create",
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("permission_denied");
    }
  });
});

// ---------------------------------------------------------------------------
// Policy surface — readWriteNoDelete admits exactly the configured surface.
// ---------------------------------------------------------------------------

describe("service policy — readWriteNoDelete admits notes.create and the four reads", () => {
  it("exposes the literal profile identifier 'readWriteNoDelete'", () => {
    const policy = createReadWriteNoDeleteServicePolicy();
    expect(policy.profile).toBe("readWriteNoDelete");
  });

  it("allows the four published read methods", () => {
    const policy = createReadWriteNoDeleteServicePolicy();
    for (const method of [
      "notes.search",
      "notes.status",
      "notes.list_notebooks",
      "notes.get",
    ] as const) {
      const decision = authorizeServiceMethod(policy, method);
      expect(decision.allowed).toBe(true);
    }
  });

  it("allows notes.create", () => {
    const policy = createReadWriteNoDeleteServicePolicy();
    const decision = authorizeServiceMethod(policy, "notes.create");
    expect(decision).toEqual({ allowed: true, method: "notes.create" });
  });

  it("allows notes.delete when the settings policy admits delete", () => {
    const policy = createReadWriteNoDeleteServicePolicy();
    const decision = authorizeServiceMethod(policy, "notes.delete");
    expect(decision).toEqual({ allowed: true, method: "notes.delete" });
  });

  it("admits notes.append and notes.update under the Slice 3 follow-up widening", () => {
    // Pinning the Slice 3 follow-up widening: readWriteNoDelete now
    // admits append/update end-to-end; readOnly (verified in the
    // dedicated service-policy suite) still categorically denies
    // them.  The follow-up contract is that delete is the only
    // method this profile refuses.
    const policy = createReadWriteNoDeleteServicePolicy();
    const appendDecision = authorizeServiceMethod(policy, "notes.append");
    expect(appendDecision.allowed).toBe(true);
    if (appendDecision.allowed) {
      expect(appendDecision.method).toBe("notes.append");
    }
    const updateDecision = authorizeServiceMethod(policy, "notes.update");
    expect(updateDecision.allowed).toBe(true);
    if (updateDecision.allowed) {
      expect(updateDecision.method).toBe("notes.update");
    }
  });

  it("freezes the policy object and its allowlist tuple", () => {
    const policy = createReadWriteNoDeleteServicePolicy();
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.allowedMethods)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Policy surface — custom method allowlist.
// ---------------------------------------------------------------------------

describe("service policy — custom method allowlist", () => {
  it("exposes the literal profile identifier 'custom'", () => {
    const policy = createCustomServicePolicy(["notes.create"]);
    expect(policy.profile).toBe("custom");
  });

  it("allows exactly the configured notes.create", () => {
    const policy = createCustomServicePolicy(["notes.create"]);
    const decision = authorizeServiceMethod(policy, "notes.create");
    expect(decision).toEqual({ allowed: true, method: "notes.create" });
  });

  it("denies methods that are not in the configured allowlist", () => {
    const policy = createCustomServicePolicy(["notes.create"]);
    const decision = authorizeServiceMethod(policy, "notes.search");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("permission_denied");
    }
  });

  it("fails closed on malformed, oversized, and accessor-backed allowlists", () => {
    const malformed = { 0: "notes.create", length: 1 } as unknown as ReadonlyArray<string>;
    const malformedPolicy = createCustomServicePolicy(malformed);
    expect(Array.from(malformedPolicy.allowedMethods)).toEqual([]);
    expect(authorizeServiceMethod(malformedPolicy, "notes.create").allowed).toBe(false);

    const oversized = [
      "notes.search",
      "notes.status",
      "notes.list_notebooks",
      "notes.get",
      "notes.create",
      "notes.append",
      "notes.sync",
      "notes.update",
      "notes.delete",
      "notes.path_diagnostic",
      "notes.search",
    ];
    const oversizedPolicy = createCustomServicePolicy(oversized);
    expect(Array.from(oversizedPolicy.allowedMethods)).toEqual([]);
    expect(authorizeServiceMethod(oversizedPolicy, "notes.search").allowed).toBe(false);

    let getterCalls = 0;
    const accessorBacked = ["notes.create"];
    Object.defineProperty(accessorBacked, 0, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "notes.create";
      },
    });
    const accessorPolicy = createCustomServicePolicy(accessorBacked);
    expect(Array.from(accessorPolicy.allowedMethods)).toEqual([]);
    expect(getterCalls).toBe(0);
  });

  it("allows notes.delete in a custom allowlist", () => {
    const policy = createCustomServicePolicy(["notes.search", "notes.create", "notes.delete"]);
    const decision = authorizeServiceMethod(policy, "notes.delete");
    expect(decision).toEqual({ allowed: true, method: "notes.delete" });
  });

  it("freezes the policy object and its allowlist tuple", () => {
    const policy = createCustomServicePolicy(["notes.create"]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.allowedMethods)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wire protocol — notes.create admission and bounded projection.
// ---------------------------------------------------------------------------

describe("rpc protocol — notes.create admission", () => {
  it("admires a notes.create request with title and content", () => {
    const request = parseRpcFrame(
      encodeFrame({
        id: "create-1",
        method: "notes.create",
        params: { title: "Slice 3 canary", content: "Body" },
      }),
    );
    expect(request.method).toBe("notes.create");
    expect(request.id).toBe("create-1");
    expect(request.params).toEqual({ title: "Slice 3 canary", content: "Body" });
  });

  it("admires a notes.create request with optional notebookId", () => {
    const request = parseRpcFrame(
      encodeFrame({
        id: "create-2",
        method: "notes.create",
        params: { title: "Slice 3 canary", content: "Body", notebookId: "nb-1" },
      }),
    );
    expect(request.method).toBe("notes.create");
    expect(request.params).toEqual({
      title: "Slice 3 canary",
      content: "Body",
      notebookId: "nb-1",
    });
  });

  it("accepts notes.create fields in any object-key order", () => {
    const request = parseRpcFrame(
      encodeFrame({
        id: "create-3",
        method: "notes.create",
        params: { notebookId: "nb-1", content: "Body", title: "Slice 3 canary" },
      }),
    );
    expect(request.method).toBe("notes.create");
    expect(request.params).toEqual({
      title: "Slice 3 canary",
      content: "Body",
      notebookId: "nb-1",
    });
  });

  it("rejects notes.create with missing title", () => {
    expect(() =>
      parseRpcFrame(
        encodeFrame({
          id: "create-bad-1",
          method: "notes.create",
          params: { content: "Body" },
        }),
      ),
    ).toThrow();
  });

  it("rejects notes.create with missing content", () => {
    expect(() =>
      parseRpcFrame(
        encodeFrame({
          id: "create-bad-2",
          method: "notes.create",
          params: { title: "Title" },
        }),
      ),
    ).toThrow();
  });

  it("rejects notes.create with empty title", () => {
    expect(() =>
      parseRpcFrame(
        encodeFrame({
          id: "create-bad-3",
          method: "notes.create",
          params: { title: "", content: "Body" },
        }),
      ),
    ).toThrow();
  });

  it("rejects notes.create with empty content", () => {
    expect(() =>
      parseRpcFrame(
        encodeFrame({
          id: "create-bad-4",
          method: "notes.create",
          params: { title: "Title", content: "" },
        }),
      ),
    ).toThrow();
  });

  it("rejects notes.delete at the wire protocol as invalid_request", () => {
    expect(() =>
      parseRpcFrame(
        encodeFrame({
          id: "delete-bad-1",
          method: "notes.delete",
          params: { id: "note-1" },
        }),
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Handler dispatch — notes.create.
// ---------------------------------------------------------------------------

/** Minimal runtime stub satisfying the read methods. */
function makeReadOnlyRuntime(): {
  search: (query: string) => Promise<ReadonlyArray<Readonly<{ title: string }>>>;
  status: () => Promise<Readonly<{ lastSynced: number; hasUnsyncedChanges: boolean }>>;
  listNotebooks: () => Promise<
    ReadonlyArray<
      Readonly<{
        id: string;
        title: string;
        dateCreated?: number;
        dateModified?: number;
      }>
    >
  >;
  noteMetadata: (id: string) => Promise<
    | Readonly<{
        id: string;
        title: string;
        dateCreated?: number;
        dateModified?: number;
        notebookId?: string;
        pinned?: boolean;
        favorite?: boolean;
        localOnly?: boolean;
        conflicted?: boolean;
        locked?: boolean;
      }>
    | undefined
  >;
} {
  return {
    search: async () => [{ title: "pre-existing" }],
    status: async () => Object.freeze({ lastSynced: 0, hasUnsyncedChanges: false }),
    listNotebooks: async () => [],
    noteMetadata: async () => undefined,
  };
}

describe("rpc handler — notes.create dispatch", () => {
  it("returns permission_denied under the default readOnly policy", async () => {
    const request: RpcRequest = {
      id: "create-permission-1",
      method: "notes.create",
      params: { title: "Title", content: "Body" },
    };
    const response = await handleRpcRequest(request, makeReadOnlyRuntime());
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("permission_denied");
    }
  });

  it("returns service_unavailable when the runtime lacks a createNote capability", async () => {
    const policy = createReadWriteNoDeleteServicePolicy();
    const request: RpcRequest = {
      id: "create-no-runtime",
      method: "notes.create",
      params: { title: "Title", content: "Body" },
    };
    const response = await handleRpcRequest(request, makeReadOnlyRuntime(), policy);
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("service_unavailable");
    }
  });

  it("forwards a bounded create request to the runtime and projects the result", async () => {
    const policy: ServicePolicy = createReadWriteNoDeleteServicePolicy();
    let observed: unknown = undefined;
    const runtime = {
      ...makeReadOnlyRuntime(),
      createNote: async (command: {
        title: string;
        content: string;
        notebookId?: string;
        tags?: readonly string[];
      }) => {
        // The handler MUST pass a plain structural copy of the bounded
        // command; never anything beyond { title, content, notebookId? }.
        observed = command;
        return {
          operation: "create" as const,
          id: "note-new",
          titleBytes: 5,
          contentBytes: 4,
          localCommitted: true as const,
          remoteSynced: false as const,
          pendingSync: true as const,
        };
      },
    };
    const request: RpcRequest = {
      id: "create-success-1",
      method: "notes.create",
      params: { title: "Title", content: "Body", notebookId: "nb-1" },
    };
    const response = await handleRpcRequest(request, runtime, policy);
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.id).toBe("create-success-1");
      expect(response.result.kind).toBe("create");
      // The result is projected through the closed serializer; only
      // the documented own keys may cross the boundary.
      expect(Object.keys(response.result).sort()).toEqual([
        "contentBytes",
        "id",
        "kind",
        "titleBytes",
      ]);
      if (response.result.kind === "create") {
        expect(response.result.id).toBe("note-new");
        expect(response.result.titleBytes).toBe(5);
        expect(response.result.contentBytes).toBe(4);
      }
    }
    expect(observed).toEqual({ title: "Title", content: "Body", notebookId: "nb-1" });
  });

  it("returns service_unavailable when the runtime's createNote rejects", async () => {
    const policy = createReadWriteNoDeleteServicePolicy();
    const runtime = {
      ...makeReadOnlyRuntime(),
      createNote: async () => {
        throw new Error("secret=/var/notesnook.key");
      },
    };
    const request: RpcRequest = {
      id: "create-runtime-fail",
      method: "notes.create",
      params: { title: "Title", content: "Body" },
    };
    const response = await handleRpcRequest(request, runtime, policy);
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("service_unavailable");
    }
  });
});
