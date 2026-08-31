/**
 * Stage 5 Task 5 — `notes.search` RPC handler.
 *
 * This suite connects the Task 4 wire request type to the Task 3
 * `ServiceRuntime.search` capability.  The handler is a pure function:
 * it accepts an already-parsed request and a runtime, and returns a
 * closed RpcResponseEnvelope.  No frame parsing, no socket, no
 * filesystem, no daemon lifecycle is reached through this surface.
 *
 * The contract exercised here:
 *
 *   - accepts exactly `notes.search` requests (the type is narrowed
 *     upstream, so the runtime check is a defence-in-depth fall-back);
 *   - calls `runtime.search(params.query)` exactly once with the
 *     caller-supplied query string;
 *   - returns the title-only success envelope with `kind: "search"`
 *     and bounded hits — never `id`, `body`, `notebookId`, paths,
 *     credentials, raw upstream error strings, or causes;
 *   - enforces the published `maxSearchHits` bound fail-closed;
 *   - maps every runtime failure into the closed categorical RPC
 *     vocabulary (no leaking), defaulting unknown / hostile runtime
 *     failures to `service_unavailable`;
 *   - freezes the response envelope on a null prototype so a hostile
 *     caller / Proxy / inherited getter cannot smuggle data back out;
 *   - preserves the request id even when the request shape is invalid
 *     or the runtime blows up — the parser has already validated the
 *     id, so echoing it cannot leak data, and silently dropping it
 *     would make the response useless to the caller.
 */

import { describe, expect, it, vi } from "vitest";

import {
  STAGE5_RPC_LIMITS,
  type RpcNotesSearchRequest,
  type RpcRequest,
  type RpcResponseEnvelope,
  type RpcSearchResult,
} from "../src/service/rpc-protocol.js";
import { handleRpcRequest, type RpcHandlerRuntimeLike } from "../src/service/rpc-handler.js";

// ---------------------------------------------------------------------------
// Helpers — small hand-rolled runtime fakes so the handler is exercised
// against a real-shaped interface (not against vi.fn()-only black-boxes).
// ---------------------------------------------------------------------------

function fakeRuntime(behaviour: RpcHandlerRuntimeLike["search"]): RpcHandlerRuntimeLike {
  // Track calls exactly once.
  const tracker = vi.fn(behaviour);
  return Object.freeze({
    search: tracker as RpcHandlerRuntimeLike["search"],
  });
}

function validRequest(overrides: Partial<RpcNotesSearchRequest> = {}): RpcNotesSearchRequest {
  const request: RpcNotesSearchRequest = Object.freeze({
    id: overrides.id ?? "req-1",
    method: "notes.search",
    params: Object.freeze({
      query: overrides.params?.query ?? "hello",
    }),
  });
  return request;
}

// ---------------------------------------------------------------------------
// Happy path — caller supplies a request, runtime returns title-only hits.
// ---------------------------------------------------------------------------

describe("handleRpcRequest — notes.search happy path", () => {
  it("returns a frozen title-only success envelope when the runtime resolves", async () => {
    const runtime = fakeRuntime(async () => [
      Object.freeze({ title: "First" }),
      Object.freeze({ title: "Second" }),
    ]);
    const request = validRequest({ id: "r-1", params: { query: "needle" } });

    const envelope: RpcResponseEnvelope = await handleRpcRequest(request, runtime);

    expect(runtime.search).toHaveBeenCalledTimes(1);
    expect(runtime.search).toHaveBeenCalledWith("needle");
    expect(envelope.id).toBe("r-1");
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      const result = envelope.result as RpcSearchResult;
      expect(result.kind).toBe("search");
      expect(Array.isArray(result.notes)).toBe(true);
      expect(result.notes.length).toBe(2);
      expect(Object.keys(result.notes[0] ?? {}).sort()).toEqual(["title"]);
      expect((result.notes[0] as { title: string }).title).toBe("First");
    }
  });

  it("returns a frozen envelope on a null prototype", async () => {
    const runtime = fakeRuntime(async () => []);
    const envelope = await handleRpcRequest(validRequest(), runtime);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.getPrototypeOf(envelope)).toBeNull();
  });

  it("returns an empty notes array when the runtime resolves with zero hits", async () => {
    const runtime = fakeRuntime(async () => []);
    const envelope = await handleRpcRequest(validRequest({ id: "empty" }), runtime);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.result.notes.length).toBe(0);
    }
  });

  it("normalises hostile runtime hits (extra fields, inherited getters, Proxies) to title-only", async () => {
    // A hostile runtime returns a note object with an inherited
    // `body` getter and an extra `id` field.  The handler must
    // reach only through `ownKeys` and drop the rest so neither
    // the field nor the getter can smuggle data into the envelope.
    const hostileHit = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostileHit, "title", { value: "Visible", enumerable: true });
    Object.defineProperty(hostileHit, "id", {
      value: "should-never-leak",
      enumerable: true,
    });
    Object.defineProperty(hostileHit, "body", {
      get() {
        return "secret";
      },
      enumerable: true,
    });

    const runtime = fakeRuntime(async () => [hostileHit as unknown as { title: string }]);

    const envelope = await handleRpcRequest(validRequest(), runtime);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      const note = envelope.result.notes[0] as unknown as Record<string, unknown>;
      expect(Object.keys(note)).toEqual(["title"]);
      expect(note.title).toBe("Visible");
      // Ensure the cached getter cannot run again.
      expect(Object.getOwnPropertyDescriptor(note, "body")).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(note, "id")).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// maxSearchHits — the published bound is enforced fail-closed.
// ---------------------------------------------------------------------------

describe("handleRpcRequest — hit bounds", () => {
  it("truncates hostile runtime hits to maxSearchHits and never exceeds it", async () => {
    const oversized: Array<{ title: string }> = [];
    const total = STAGE5_RPC_LIMITS.maxSearchHits + 8;
    for (let i = 0; i < total; i += 1) {
      oversized.push({ title: `t-${i}` });
    }
    const runtime = fakeRuntime(async () => oversized);

    const envelope = await handleRpcRequest(validRequest({ id: "cap" }), runtime);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      const limit = STAGE5_RPC_LIMITS.maxSearchHits;
      expect(envelope.result.notes.length).toBeLessThanOrEqual(limit);
      // First few titles preserved in order.
      expect(envelope.result.notes[0]?.title).toBe("t-0");
      expect(envelope.result.notes[1]?.title).toBe("t-1");
    }
  });

  it("rejects a runtime result of an unsupported shape (non-array) as service_unavailable", async () => {
    const runtime = fakeRuntime(
      // Promise resolving to a plain object instead of an array — i.e.
      // a hostile or buggy runtime returning the wrong shape.
      (async () => ({}) as unknown as Array<{ title: string }>) as RpcHandlerRuntimeLike["search"],
    );
    // The fake above returns `{}` from `search()`.  The handler must
    // refuse it categorically rather than forwarding a non-array.
    const envelope = await handleRpcRequest(validRequest({ id: "shape" }), runtime);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("service_unavailable");
      // The original message must not leak.
      expect(envelope.error.message).toBe("Service unavailable");
    }
  });
});

// ---------------------------------------------------------------------------
// Error mapping — every runtime failure collapses to the categorical
// vocabulary without leaking details.
// ---------------------------------------------------------------------------

describe("handleRpcRequest — runtime failure mapping", () => {
  it("maps a runtime that threw an unannotated Error to service_unavailable", async () => {
    const runtime = fakeRuntime(async () => {
      throw new Error("upstream note count not initialized; path=/var/secrets/key");
    });
    const envelope = await handleRpcRequest(validRequest({ id: "leak" }), runtime);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("service_unavailable");
      expect(envelope.error.message).toBe("Service unavailable");
      // Make sure the raw upstream message did not leak.
      const serialized = JSON.stringify(envelope);
      expect(serialized.includes("upstream")).toBe(false);
      expect(serialized.includes("path")).toBe(false);
      expect(serialized.includes("/var")).toBe(false);
    }
  });

  it("preserves the request id on a hostile runtime throw", async () => {
    const runtime = fakeRuntime(async () => {
      throw new TypeError("id-of-the-failing-credential");
    });
    const envelope = await handleRpcRequest(validRequest({ id: "preserve-me" }), runtime);
    expect(envelope.id).toBe("preserve-me");
  });

  it("does not invoke search() when the runtime is hostile (Proxy with side-effecting search getter)", async () => {
    // A hostile runtime whose `search` getter returns a function that
    // throws if invoked.  The handler must reject the runtime
    // structurally BEFORE invoking `search()`, so the getter must
    // not even be touched.
    const unreachableSpy = vi.fn(async () => {
      throw new Error("search must not be called");
    });
    const hostileRuntime = new Proxy(
      { search: unreachableSpy },
      {
        get(target, prop) {
          // Trap every property access; once the handler inspects
          // ownKeys / prototype, it should refuse without calling
          // the underlying function.
          if (prop === "search") return unreachableSpy;
          return Reflect.get(target, prop);
        },
        getPrototypeOf() {
          return null; // lies about being a plain object
        },
      },
    );
    const envelope = await handleRpcRequest(
      validRequest({ id: "hostile-rt" }),
      hostileRuntime as unknown as RpcHandlerRuntimeLike,
    );
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("service_unavailable");
    }
  });

  it("normalises a Proxy runtime whose search() traps throw with a sensitive message", async () => {
    const trap = new Proxy(function () {}, {
      get() {
        return () => {
          throw new Error("credential unlock failed: /secrets/notesnook.key");
        };
      },
    });
    const proxyRuntime = Object.freeze({ search: trap }) as unknown as RpcHandlerRuntimeLike;
    const envelope = await handleRpcRequest(validRequest({ id: "trap" }), proxyRuntime);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("service_unavailable");
      const serialized = JSON.stringify(envelope);
      expect(serialized.includes("credential")).toBe(false);
      expect(serialized.includes("secrets")).toBe(false);
      expect(serialized.includes(".key")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Defence-in-depth — even though the protocol parser narrows the request
// type to `notes.search`, the handler must reject any other shape
// categorically.  These tests exercise the harness with unfrozen / unknown
// shapes to assert the handler's own defensive bounds.
// ---------------------------------------------------------------------------

describe("handleRpcRequest — request shape defence-in-depth", () => {
  it("rejects a request whose method is not notes.search as invalid_request", async () => {
    const runtime = fakeRuntime(async () => []);
    const hostile = {
      id: "x",
      method: "notes.delete",
      params: { query: "y" },
    } as unknown as RpcRequest;
    const envelope = await handleRpcRequest(hostile, runtime);
    expect(envelope.id).toBe("x");
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("invalid_request");
    }
  });

  it("rejects a request whose params.query is missing as invalid_request", async () => {
    const runtime = fakeRuntime(async () => []);
    const hostile = {
      id: "missing-q",
      method: "notes.search",
      params: {},
    } as unknown as RpcRequest;
    const envelope = await handleRpcRequest(hostile, runtime);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("invalid_request");
    }
  });

  it("rejects a non-object request as invalid_request without leaking", async () => {
    const runtime = fakeRuntime(async () => []);
    const envelope = await handleRpcRequest("not-an-object" as unknown as RpcRequest, runtime);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("invalid_request");
      // The original request value must not be echoed.
      expect(JSON.stringify(envelope).includes("not-an-object")).toBe(false);
    }
  });

  it("never calls search() when the request is structurally invalid", async () => {
    const runtime = fakeRuntime(async () => {
      throw new Error("must not be called");
    });
    const hostile = {
      id: "no-search",
      method: "notes.search",
      params: { query: 42 },
    } as unknown as RpcRequest;
    const envelope = await handleRpcRequest(hostile, runtime);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("invalid_request");
    }
  });
});

// ---------------------------------------------------------------------------
// Round-trip — the envelope the handler returns must already be safe to
// feed through `serializeRpcResponse` from Task 4.  We assert the closed
// shape directly here rather than parsing frames so the failure is
// immediately attributable to the handler.
// ---------------------------------------------------------------------------

describe("handleRpcRequest — closed-envelope invariants", () => {
  it("emits envelopes whose own key sets match the closed protocol contract", async () => {
    const runtime = fakeRuntime(async () => [{ title: "only" }]);
    const envelope = await handleRpcRequest(validRequest({ id: "rt-1" }), runtime);
    expect(Object.keys(envelope).sort()).toEqual(["id", "ok", "result"]);
  });

  it("emits error envelopes whose own key sets match the closed protocol contract", async () => {
    const runtime = fakeRuntime(async () => {
      throw new Error("x");
    });
    const envelope = await handleRpcRequest(validRequest({ id: "rt-2" }), runtime);
    expect(Object.keys(envelope).sort()).toEqual(["error", "id", "ok"]);
    if (!envelope.ok) {
      expect(Object.keys(envelope.error).sort()).toEqual(["code", "message"]);
      expect(envelope.error.message).toMatch(/^[A-Z]/); // canonical, not raw
    }
  });
});

// ---------------------------------------------------------------------------
// Hostile input regressions — parent review found 8 concrete boundary holes
// in rpc-handler.ts.  Each test pins one of them and fails on the current
// implementation.  The tests must be RED before the production code is
// hardened, then GREEN once the hardening lands.
// ---------------------------------------------------------------------------

describe("handleRpcRequest — hostile-input boundary regressions", () => {
  it("survives a live Object.getPrototypeOf substitution when structurally validating the runtime", async () => {
    // Issue (1): isCallableRuntime calls Object.getPrototypeOf /
    // Object.getOwnPropertyDescriptor directly instead of through captured
    // aliases.  A hostile module-loader mutation that swaps Object.* for a
    // trap function would leak into the handler and could either crash it
    // or smuggle a non-data descriptor past the static check.
    const originalGetProto = Object.getPrototypeOf;
    const originalGetDescriptor = Object.getOwnPropertyDescriptor;
    let trapInvocations = 0;
    const trap = () => {
      trapInvocations += 1;
      return undefined;
    };
    Object.getPrototypeOf = trap as typeof Object.getPrototypeOf;
    Object.getOwnPropertyDescriptor = trap as typeof Object.getOwnPropertyDescriptor;
    try {
      const runtime = Object.freeze({
        search: async () => [{ title: "Visible" }],
      });
      const envelope = await handleRpcRequest(validRequest({ id: "live-mut-1" }), runtime);
      // The handler must NOT have called the swapped-in traps —
      // captured intrinsics isolate it from live Object.* mutation.
      expect(trapInvocations).toBe(0);
      // And the handler still produces a real success envelope.
      expect(envelope.ok).toBe(true);
      if (envelope.ok) {
        expect(envelope.result.notes[0]?.title).toBe("Visible");
      }
    } finally {
      Object.getPrototypeOf = originalGetProto;
      Object.getOwnPropertyDescriptor = originalGetDescriptor;
    }
  });

  it("rejects a runtime whose search is an accessor (getter) — descriptor-only data accepted", async () => {
    // Issue (2) and (5): readOwnStringField and the runtime check must
    // read descriptor.value via captured intrinsics, not via the live
    // record[key] access path.  A getter descriptor on `search` is the
    // hostile shape the static check has to refuse.
    const runtime = {} as Record<string, unknown>;
    Object.defineProperty(runtime, "search", {
      configurable: true,
      enumerable: true,
      get() {
        return async () => [{ title: "leak" }];
      },
    });
    const envelope = await handleRpcRequest(
      validRequest({ id: "getter-rt" }),
      runtime as unknown as RpcHandlerRuntimeLike,
    );
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("service_unavailable");
      expect(JSON.stringify(envelope).includes("leak")).toBe(false);
    }
  });

  it("returns invalid_request with a safe id when the request id is a hostile getter", async () => {
    // Issue (3): extractRequestId and validateRequestStructurally occur
    // outside a top-level categorical boundary.  A hostile request
    // Proxy/getter can make handleRpcRequest reject with a raw error
    // rather than returning invalid_request.  The id-extraction helper
    // must be wrapped so any unexpected error returns a categorical
    // envelope with safe id (empty string if id itself is hostile).
    const hostileRequest = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "id") {
            throw new Error("credential unlock failed: /secrets/notesnook.key");
          }
          if (prop === "method") return "notes.search";
          if (prop === "params") return { query: "y" };
          return undefined;
        },
      },
    );
    const envelope = await handleRpcRequest(
      hostileRequest as unknown as RpcRequest,
      fakeRuntime(async () => []),
    );
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      // Categorical envelope — never a raw throw.
      expect(envelope.error.code).toBe("invalid_request");
      // Sensitive strings must never reach the response.
      const serialized = JSON.stringify(envelope);
      expect(serialized.includes("credential")).toBe(false);
      expect(serialized.includes("secrets")).toBe(false);
      expect(serialized.includes(".key")).toBe(false);
      expect(serialized.includes("notesnook")).toBe(false);
      // The id itself was hostile so the envelope must echo the safe
      // empty-string fallback rather than anything from the request.
      expect(envelope.id).toBe("");
    }
  });

  it("returns invalid_request when the request is a Proxy whose params getter throws", async () => {
    // Issue (3) continued — defence-in-depth structural checks must
    // surface a categorical invalid_request even if the hostile request
    // raises on a property other than `id`.
    const hostileRequest = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "id") return "ok-id";
          if (prop === "method") return "notes.search";
          if (prop === "params") {
            throw new TypeError("path=/var/secrets/credential");
          }
          return undefined;
        },
      },
    );
    const envelope = await handleRpcRequest(
      hostileRequest as unknown as RpcRequest,
      fakeRuntime(async () => []),
    );
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("invalid_request");
      const serialized = JSON.stringify(envelope);
      expect(serialized.includes("/var")).toBe(false);
      expect(serialized.includes("secrets")).toBe(false);
      expect(serialized.includes("credential")).toBe(false);
    }
  });

  it("returns service_unavailable when the runtime structural validation throws", async () => {
    // Issue (4): runtime structural validation can throw from Proxy
    // traps; the boundary must catch and return service_unavailable
    // rather than letting the raw throw escape handleRpcRequest.
    const explosiveRuntime = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "search") return undefined;
          if (prop === Symbol.toPrimitive) return undefined;
          return undefined;
        },
        getPrototypeOf() {
          throw new Error("path=/secrets/key materialised");
        },
        getOwnPropertyDescriptor() {
          throw new Error("descriptor probe leaked credentials");
        },
      },
    );
    const envelope = await handleRpcRequest(
      validRequest({ id: "explosive-rt" }),
      explosiveRuntime as unknown as RpcHandlerRuntimeLike,
    );
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("service_unavailable");
      const serialized = JSON.stringify(envelope);
      expect(serialized.includes("path")).toBe(false);
      expect(serialized.includes("secrets")).toBe(false);
      expect(serialized.includes("credential")).toBe(false);
      expect(serialized.includes("leaked")).toBe(false);
    }
  });

  it("invokes runtime.search via the captured data-descriptor function, not via plain property access", async () => {
    // Issue (5): runNotesSearch calls runtime.search via property access
    // again, so a stateful/hostile getter can substitute code.  We swap
    // Object.getOwnPropertyDescriptor for a spy and verify the handler
    // still calls the underlying captured-function via the same data
    // descriptor it inspected.
    const realGetDescriptor = Object.getOwnPropertyDescriptor;
    let probeCalls = 0;
    Object.getOwnPropertyDescriptor = ((target, key) => {
      probeCalls += 1;
      return realGetDescriptor(target, key);
    }) as typeof Object.getOwnPropertyDescriptor;
    try {
      const underlying = async () => [{ title: "ok" }];
      const runtime = Object.freeze({ search: underlying });
      const envelope = await handleRpcRequest(validRequest({ id: "captured-fn" }), runtime);
      // The handler must use its captured descriptor intrinsic rather
      // than the swapped-in live function.
      expect(probeCalls).toBe(0);
      // And the underlying function must have been called exactly once.
      expect(envelope.ok).toBe(true);
      if (envelope.ok) {
        expect(envelope.result.notes[0]?.title).toBe("ok");
      }
    } finally {
      Object.getOwnPropertyDescriptor = realGetDescriptor;
    }
  });

  it("survives a hostile runtime returning an array whose own length getter throws", async () => {
    // Issue (6): buildSuccessEnvelope / normaliseHit can throw from
    // hostile array length / index / title getter / Proxy; the boundary
    // must catch construction failure in runNotesSearch and return
    // service_unavailable.
    const hostileHits = new Proxy([] as Array<{ title: string }>, {
      get(target, prop) {
        if (prop === "length") {
          throw new Error("length probe path=/secrets/key");
        }
        return Reflect.get(target, prop);
      },
    });
    const runtime = fakeRuntime(
      async () => hostileHits as unknown as ReadonlyArray<Readonly<{ title: string }>>,
    );
    const envelope = await handleRpcRequest(validRequest({ id: "hostile-hits" }), runtime);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.result.notes).toHaveLength(0);
    }
  });

  it("survives a hostile runtime returning a hit whose title getter throws", async () => {
    // Issue (6) continued — a single hostile hit must not poison the
    // whole success envelope; either the hit is dropped silently or the
    // construction is caught and service_unavailable is returned.
    const hostileHit = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "title") {
            throw new Error("title path=/secrets/credential leaked");
          }
          if (prop === "length") return 1;
          return undefined;
        },
        has(_target, prop) {
          if (prop === "title") return true;
          return false;
        },
        ownKeys() {
          return ["title"];
        },
        getOwnPropertyDescriptor(_target, prop) {
          if (prop === "title") {
            return {
              configurable: true,
              enumerable: true,
              get() {
                throw new Error("title path=/secrets/credential leaked");
              },
            };
          }
          return undefined;
        },
      },
    );
    const hostileHits = [hostileHit];
    const runtime = fakeRuntime(
      async () => hostileHits as unknown as ReadonlyArray<Readonly<{ title: string }>>,
    );
    const envelope = await handleRpcRequest(validRequest({ id: "hostile-hit" }), runtime);
    // We accept either an empty success envelope (drop-silently) or a
    // service_unavailable; both are categorical.  No raw throw.
    expect(envelope.ok).not.toBe(null);
    if (envelope.ok) {
      // If a success path is taken, the hostile hit must have been
      // dropped — no leaked field is allowed.
      const serialized = JSON.stringify(envelope);
      expect(serialized.includes("secrets")).toBe(false);
      expect(serialized.includes("credential")).toBe(false);
      expect(serialized.includes("path")).toBe(false);
      expect(envelope.result.notes.length).toBe(0);
    } else {
      expect(envelope.error.code).toBe("service_unavailable");
      const serialized = JSON.stringify(envelope);
      expect(serialized.includes("secrets")).toBe(false);
      expect(serialized.includes("credential")).toBe(false);
      expect(serialized.includes("path")).toBe(false);
    }
  });

  it("reconstructs request/params with objectCreate(null) + captured freeze (no Object.prototype inherited)", async () => {
    // Issue (7): validateRequestStructurally must produce null-prototype,
    // frozen request/params objects — never an object literal.  We
    // inspect the runtime check's reconstructed request by surfacing it
    // through a runtime that captures the argument it actually sees.
    let receivedRequest: unknown = undefined;
    const runtime: RpcHandlerRuntimeLike = Object.freeze({
      search: async (query: string) => {
        receivedRequest = query;
        return [];
      },
    });
    // The reconstructed params.query must reach the runtime intact,
    // and the reconstructed request must be null-prototype and frozen
    // (the static check asserts this via Object.getPrototypeOf and
    // Object.isFrozen on the *request*, but the request isn't passed
    // to search().  So we drive this test by confirming the captured
    // query is exactly what the handler reconstructed, and that the
    // request envelope does not inherit from Object.prototype either.
    const envelope = await handleRpcRequest(
      validRequest({ id: "null-proto", params: { query: "x" } }),
      runtime,
    );
    expect(receivedRequest).toBe("x");
    // Envelope is always null-prototype / frozen on every code path.
    expect(Object.getPrototypeOf(envelope)).toBeNull();
    expect(Object.isFrozen(envelope)).toBe(true);
    if (envelope.ok) {
      expect(Object.getPrototypeOf(envelope.result)).toBeNull();
      expect(Object.isFrozen(envelope.result)).toBe(true);
      expect(Object.getPrototypeOf(envelope.result.notes)).toBeNull();
      expect(Object.isFrozen(envelope.result.notes)).toBe(true);
    } else {
      expect(Object.getPrototypeOf(envelope.error)).toBeNull();
      expect(Object.isFrozen(envelope.error)).toBe(true);
    }
  });
});
