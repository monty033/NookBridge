import { Buffer } from "node:buffer";
import process from "node:process";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";

import {
  OPERATOR_ADMITTED_GROUPS,
  OPERATOR_MUTATION_GROUP,
  createOperatorAuthorizer,
} from "../src/service/operator-authorizer.js";
import { createOperatorDiscoveryHandler } from "../src/service/operator-discovery-handler.js";
import { startOperatorSocketServer } from "../src/service/operator-socket-server.js";
import type { OperatorPeer } from "../src/service/operator-server.js";
import { handleRpcRequest, runOperatorPathDiagnostic } from "../src/service/rpc-handler.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";
import {
  authorizeServiceMethod,
  createCustomServicePolicy,
  createReadOnlyServicePolicy,
  createReadWriteNoDeleteServicePolicy,
} from "../src/service/service-policy.js";

const CLIENT_ONLY: OperatorPeer = { uid: 1, gid: 2, groups: ["nookbridge-clients"] };
const OPERATOR: OperatorPeer = {
  uid: 1,
  gid: 2,
  groups: ["nookbridge-clients", "nookbridge-operators"],
};
const OPERATOR_ONLY_GROUP: OperatorPeer = { uid: 1, gid: 2, groups: ["nookbridge-operators"] };

const PATH = "Notebook/Note";

const deps = () => ({
  resolveHandle: () => undefined,
  resolveOperationNoteId: undefined,
  readNoteLockState: async () => "unlocked" as const,
  readNoteNotebookPath: async () => "Public",
  evaluateNotebookPolicy: () => true,
});

const request = (method: string, params: Record<string, unknown> = {}): never =>
  ({ id: "r1", method, params }) as never;

const diagnosticResult = {
  kind: "path_diagnostic" as const,
  pathBytes: Buffer.byteLength(PATH, "utf8"),
  title: "one" as const,
  notebook: "present" as const,
  directMembership: "present" as const,
  recursiveMembership: "present" as const,
  revision: "valid" as const,
  contentType: "tiptap" as const,
  htmlPrefix: "present" as const,
  simpleChecklist: "absent" as const,
  taskList: "absent" as const,
  literalMarkdown: "absent" as const,
};

describe("F1 — operator authorizer admits only the operators group", () => {
  it("refuses a peer whose only admitted group is nookbridge-clients", async () => {
    const authorize = createOperatorAuthorizer(deps());
    for (const method of ["notes.get-view", "notes.browse", "notes.path_diagnostic"]) {
      await expect(authorize(method as never, CLIENT_ONLY, request(method))).resolves.toMatchObject(
        { allowed: false, reason: "permission_denied" },
      );
    }
  });

  it("admits a peer in nookbridge-operators", async () => {
    const authorize = createOperatorAuthorizer(deps());
    await expect(
      authorize("notes.browse", OPERATOR, request("notes.browse")),
    ).resolves.toMatchObject({ allowed: true, method: "notes.browse" });
    await expect(
      authorize("notes.browse", OPERATOR_ONLY_GROUP, request("notes.browse")),
    ).resolves.toMatchObject({ allowed: true, method: "notes.browse" });
  });

  it("control: the refusal is group-driven, not a blanket deny", async () => {
    const authorize = createOperatorAuthorizer(deps());
    const clientOnly = await authorize("notes.browse", CLIENT_ONLY, request("notes.browse"));
    const operator = await authorize("notes.browse", OPERATOR, request("notes.browse"));
    expect(clientOnly.allowed).toBe(false);
    expect(operator.allowed).toBe(true);
    // Same request, same method: only the peer's group membership differs.
  });

  it("pins the invariant: every admitted group is the mutation group", () => {
    // The general property, not just "clients are gone": admitting ANY second
    // group would grant that peer mutations unless the capability split is
    // restored here, so the list must be exactly the mutation group.
    expect([...OPERATOR_ADMITTED_GROUPS]).toEqual([OPERATOR_MUTATION_GROUP]);
  });

  it("operator access is all-or-nothing: admission and mutation capability are the same group", async () => {
    // Removing the client group from the operator listener collapses the
    // read-only operator tier that used to exist: a peer that is admitted is
    // necessarily in the mutation group, so `isOperator` can no longer deny a
    // mutation to an already-admitted peer.  Pin that, so a future read-only
    // operator group is a deliberate change rather than an accident.
    const authorize = createOperatorAuthorizer(deps());
    for (const method of ["notes.browse", "notes.create"]) {
      await expect(authorize(method as never, OPERATOR, request(method))).resolves.toMatchObject({
        allowed: true,
      });
      await expect(authorize(method as never, CLIENT_ONLY, request(method))).resolves.toMatchObject(
        {
          allowed: false,
          reason: "permission_denied",
        },
      );
    }
  });
});

describe("F1 — notes.path_diagnostic is refused by daemon policy", () => {
  const profiles = {
    readOnly: createReadOnlyServicePolicy(),
    readWriteNoDelete: createReadWriteNoDeleteServicePolicy(),
    custom: createCustomServicePolicy([
      "notes.search",
      "notes.status",
      "notes.list_notebooks",
      "notes.get",
      "notes.path_diagnostic",
    ]),
  };

  for (const [name, policy] of Object.entries(profiles)) {
    it(`denies notes.path_diagnostic for ${name} and still admits notes.search`, () => {
      expect(authorizeServiceMethod(policy, "notes.path_diagnostic")).toEqual({
        allowed: false,
        reason: "permission_denied",
      });
      expect(authorizeServiceMethod(policy, "notes.search")).toEqual({
        allowed: true,
        method: "notes.search",
      });
    });
  }
});

describe("F1 — daemon vs operator surface", () => {
  const runtime = {
    pathDiagnostic: vi.fn(async () => diagnosticResult),
  } as never;
  const call = { id: "r1", method: "notes.path_diagnostic", params: { path: PATH } } as RpcRequest;

  it("is permission_denied over the daemon surface for every profile", async () => {
    for (const policy of [
      createReadOnlyServicePolicy(),
      createReadWriteNoDeleteServicePolicy(),
      createCustomServicePolicy(["notes.path_diagnostic", "notes.get"]),
    ]) {
      const response = await handleRpcRequest(call, runtime, policy);
      expect(response).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    }
    expect(
      (runtime as unknown as { pathDiagnostic: ReturnType<typeof vi.fn> }).pathDiagnostic,
    ).not.toHaveBeenCalled();
  });

  async function exchange(path: string, method: string, params: object): Promise<unknown> {
    const payload = Buffer.from(JSON.stringify({ id: "r1", method, params }), "utf8");
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection(path);
      let pending = Buffer.alloc(0);
      socket.on("connect", () => socket.write(frame));
      socket.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length < 4) return;
        const length = pending.readUInt32BE(0);
        if (pending.length < length + 4) return;
        socket.destroy();
        resolve(JSON.parse(pending.subarray(4, length + 4).toString("utf8")));
      });
      socket.on("error", reject);
      socket.on("close", () => {
        if (pending.length === 0) reject(new Error("closed without response"));
      });
    });
  }

  async function withOperatorSocket(
    peer: OperatorPeer,
    run: (path: string) => Promise<void>,
  ): Promise<void> {
    const path = `/tmp/f1-operator-${process.pid}-${Math.random().toString(16).slice(2)}.sock`;
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: () => peer,
      authorize: createOperatorAuthorizer(deps()),
      handle: createOperatorDiscoveryHandler({
        browse: async () => ({ notes: [], next: null }),
        search: async () => ({ notes: [], next: null }),
        pathDiagnostic: (req) => runOperatorPathDiagnostic(req as never, runtime),
      }),
    });
    try {
      await run(path);
    } finally {
      await server.close();
    }
  }

  it("is admitted over the operator socket for an operator peer", async () => {
    await withOperatorSocket(OPERATOR, async (path) => {
      const response = await exchange(path, "notes.path_diagnostic", { path: PATH });
      expect(response).toMatchObject({
        ok: true,
        result: { kind: "path_diagnostic", pathBytes: diagnosticResult.pathBytes },
      });
    });
  });

  it("is permission_denied over the operator socket for a client-group-only peer", async () => {
    await withOperatorSocket(CLIENT_ONLY, async (path) => {
      const response = await exchange(path, "notes.path_diagnostic", { path: PATH });
      expect(response).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    });
  });
});

describe("F1 — nookctl path-diagnostic targets the operator socket", () => {
  it("builds an OperatorSocketClient on operator.sock, not the daemon socket", async () => {
    vi.resetModules();
    const operatorPaths: string[] = [];
    const daemonPaths: string[] = [];
    vi.doMock("../src/operator/operator-socket-client.js", () => ({
      OperatorSocketClient: class {
        constructor(options: { socketPath: string }) {
          operatorPaths.push(options.socketPath);
        }
        async request() {
          return { ok: true, result: diagnosticResult };
        }
      },
    }));
    vi.doMock("../src/mcp/socket-client.js", () => ({
      NookdSocketClient: class {
        constructor(options: { socketPath: string }) {
          daemonPaths.push(options.socketPath);
        }
      },
    }));
    try {
      const mod = await import("../src/operator/path-diagnostic.js");
      const { runtime } = await mod.createProductionPathDiagnosticRuntime({});
      expect(operatorPaths).toEqual(["/run/nookbridge/operator.sock"]);
      expect(daemonPaths).toEqual([]);
      await expect(runtime.pathDiagnostic(PATH)).resolves.toMatchObject({
        kind: "path_diagnostic",
      });
    } finally {
      vi.doUnmock("../src/operator/operator-socket-client.js");
      vi.doUnmock("../src/mcp/socket-client.js");
      vi.resetModules();
    }
  });
});
