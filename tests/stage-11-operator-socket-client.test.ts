import process from "node:process";
import { describe, expect, it } from "vitest";
import { startOperatorSocketServer } from "../src/service/operator-socket-server.js";
import { OperatorSocketClient } from "../src/operator/operator-socket-client.js";
import { createOperatorDiscoveryHandler } from "../src/service/operator-discovery-handler.js";

const socketPath = () =>
  `/tmp/operator-client-${process.pid}-${Math.random().toString(16).slice(2)}.sock`;

const HANDLE = `not_${"A".repeat(16)}`;
const PREIMAGE = {
  kind: "preimage" as const,
  id: HANDLE,
  revision: `rev_${"a".repeat(32)}`,
  markdown: "# Title\n\nbody\n",
  contentBytes: 14,
};

async function withServer(
  handle: Parameters<typeof createOperatorDiscoveryHandler>[0],
  run: (client: OperatorSocketClient) => Promise<void>,
): Promise<void> {
  const path = socketPath();
  const server = await startOperatorSocketServer({
    socketPath: path,
    socketPathRoot: "/tmp",
    resolvePeer: () => ({ uid: 1, gid: 2, groups: ["nookbridge-operators"] }),
    authorize: (method) => ({ allowed: true, method }),
    handle: createOperatorDiscoveryHandler(handle),
  });
  try {
    await run(new OperatorSocketClient({ socketPath: path }));
  } finally {
    await server.close();
  }
}

describe("operator socket client", () => {
  it("round-trips a protected discovery request", async () => {
    const path = socketPath();
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: () => ({ uid: 1, gid: 2, groups: ["nookbridge-operators"] }),
      authorize: (method) => ({ allowed: true, method }),
      handle: createOperatorDiscoveryHandler({
        browse: async () => ({ notes: [{ handle: "h_one", label: "One", bytes: 3 }], next: null }),
        search: async () => ({ notes: [], next: null }),
      }),
    });
    try {
      const client = new OperatorSocketClient({ socketPath: path });
      const result = await client.request("notes.browse", { limit: 1 });
      expect(result).toEqual({
        ok: true,
        result: {
          kind: "operator-page",
          notes: [{ handle: "h_one", label: "One", bytes: 3 }],
          next: null,
        },
      });
    } finally {
      await server.close();
    }
  });

  /**
   * The daemon answers a losing optimistic-concurrency check with a
   * categorical `stale_revision` or `conflict` envelope.  The client must
   * forward those categories: collapsing them to `service_unavailable`
   * would tell the operator "runtime unavailable" when the real answer is
   * "someone else changed this note".
   */
  it.each(["conflict", "stale_revision", "vault_locked", "sync_failed"] as const)(
    "forwards a %s envelope as its own category",
    async (code) => {
      await withServer(
        {
          browse: async () => ({ notes: [], next: null }),
          search: async () => ({ notes: [], next: null }),
          editPreimage: async () => PREIMAGE,
          applyEdit: async () => {
            const error = new Error("categorical") as Error & { code: string };
            error.code = code;
            throw error;
          },
        },
        async (client) => {
          const result = await client.request("notes.apply-edit", {
            id: HANDLE,
            expectedRevision: `rev_${"a".repeat(32)}`,
            markdown: "# Title\n\nbody\n",
          });
          expect(result).toEqual({ ok: false, code });
        },
      );
    },
  );

  it("collapses a category outside the daemon vocabulary to service_unavailable", async () => {
    await withServer(
      {
        browse: async () => ({ notes: [], next: null }),
        search: async () => ({ notes: [], next: null }),
        editPreimage: async () => PREIMAGE,
        applyEdit: async () => {
          const error = new Error("categorical") as Error & { code: string };
          error.code = "mystery_category";
          throw error;
        },
      },
      async (client) => {
        const result = await client.request("notes.apply-edit", {
          id: HANDLE,
          expectedRevision: `rev_${"a".repeat(32)}`,
          markdown: "# Title\n\nbody\n",
        });
        expect(result).toEqual({ ok: false, code: "service_unavailable" });
      },
    );
  });
});
