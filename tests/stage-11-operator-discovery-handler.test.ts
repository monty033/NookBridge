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
});
