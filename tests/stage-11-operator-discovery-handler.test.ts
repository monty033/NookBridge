import { describe, expect, it } from "vitest";
import { createOperatorDiscoveryHandler } from "../src/service/operator-discovery-handler.js";

describe("operator discovery handler", () => {
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

  it("preserves a categorical refusal raised as a bare vocabulary message", async () => {
    // The read projection refuses a locked record by throwing an error whose
    // MESSAGE is the categorical name, carrying no `code` property.  Reading
    // only `code` collapsed that refusal into `service_unavailable`, so a
    // locked note was indistinguishable from a broken daemon: the operator saw
    // a generic error for a note that was simply locked, and the locked-note
    // acceptance proof could never return `vault_locked`.
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
      error: { code: "vault_locked", message: "Vault locked" },
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
