import { describe, expect, it } from "vitest";
import { createOperatorDiscoveryHandler } from "../src/service/operator-discovery-handler.js";
import { OPERATOR_METHODS } from "../src/service/operator-methods.js";

describe("operator discovery handler", () => {
  it("publishes an exact set of nine operator methods", () => {
    // Review finding: the module header claimed the vocabulary was "exactly"
    // seven while the constant held nine, so the documented contract and the
    // code disagreed.  Pinning the set here means a future alias, addition, or
    // removal has to update this test as well as the header.
    expect(OPERATOR_METHODS).toHaveLength(9);
    expect([...OPERATOR_METHODS]).toEqual([
      "notes.get-view",
      "notes.edit-preimage",
      "notes.apply-edit",
      "notes.apply-undo",
      "notes.create",
      "notes.operation-status",
      "notes.operation-list",
      "notes.browse",
      "notes.search-operator",
    ]);
  });

  it("dispatches browse and returns only the bounded page projection", async () => {
    const handler = createOperatorDiscoveryHandler({
      browse: async (params) => ({
        notes: [{ handle: "h_one", label: `page-${params.limit ?? 0}`, bytes: 6 }],
        next: null,
      }),
      search: async () => ({ notes: [], next: null }),
    });
    const response = await handler(
      { id: "1", method: "notes.browse", params: { limit: 10 } },
      { uid: 1, gid: 2, groups: [] },
    );
    expect(response).toMatchObject({
      id: "1",
      ok: true,
      result: { kind: "operator-page", notes: [{ handle: "h_one", label: "page-10", bytes: 6 }] },
    });
  });

  it("normalizes runtime failures categorically", async () => {
    const handler = createOperatorDiscoveryHandler({
      browse: async () => {
        throw new Error("raw note data must not escape");
      },
      search: async () => ({ notes: [], next: null }),
    });
    const response = await handler(
      { id: "2", method: "notes.browse", params: {} },
      { uid: 1, gid: 2, groups: [] },
    );
    expect(response).toEqual({
      id: "2",
      ok: false,
      error: { code: "service_unavailable", message: "Service unavailable" },
    });
  });

  it("collapses a bare vocabulary message on an untrusted error", async () => {
    // Review finding: mapping any thrown object whose MESSAGE equals a
    // vocabulary word let an unrelated upstream error be reported to the
    // operator as a categorical refusal — a random failure carrying the text
    // "not_found" or "permission_denied" became that category.  Only a
    // class-identity-checked projection refusal may be read from its message, so
    // a plain Error collapses instead.  The trusted path is exercised through
    // the projection's own read surface, which is the only thing that can raise
    // that error class.
    const handler = createOperatorDiscoveryHandler({
      browse: async () => ({ notes: [], next: null }),
      search: async () => ({ notes: [], next: null }),
      view: async () => {
        throw new Error("vault_locked");
      },
    });
    const response = await handler(
      { id: "3", method: "notes.get-view", params: { id: "h_one" } },
      { uid: 1, gid: 2, groups: [] },
    );
    expect(response).toMatchObject({
      id: "3",
      ok: false,
      error: { code: "service_unavailable" },
    });
  });

  it("still collapses a failure whose message is not in the closed vocabulary", async () => {
    // Guard: only exact vocabulary members map.  Free text — including text
    // that merely mentions a category — must not become a category, and no
    // upstream detail may cross the boundary.
    const handler = createOperatorDiscoveryHandler({
      browse: async () => ({ notes: [], next: null }),
      search: async () => ({ notes: [], next: null }),
      view: async () => {
        throw new Error("upstream locked detail must stay internal");
      },
    });
    const response = await handler(
      { id: "4", method: "notes.get-view", params: { id: "h_one" } },
      { uid: 1, gid: 2, groups: [] },
    );
    expect(response).toEqual({
      id: "4",
      ok: false,
      error: { code: "service_unavailable", message: "Service unavailable" },
    });
  });
});
