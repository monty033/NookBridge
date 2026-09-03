import { describe, expect, it } from "vitest";

import { buildServiceAuditRecord } from "../src/service/service-audit.js";
import { STAGE5_RPC_LIMITS, serializeRpcResponse } from "../src/service/rpc-protocol.js";

const baseRecord = {
  event: "rpc.request.dispatched" as const,
  requestIdEcho: false,
  latencyMs: 1,
  peerCredentials: "self" as const,
};

describe("Stage 7 Slice 3 review regressions", () => {
  it("accepts write methods and stale/conflict audit outcomes", () => {
    for (const method of ["notes.create", "notes.append", "notes.update"] as const) {
      for (const outcome of ["stale_revision", "conflict"] as const) {
        expect(buildServiceAuditRecord({ ...baseRecord, method, outcome })).toMatchObject({
          method,
          outcome,
        });
      }
    }
  });

  it.each([
    ["create", { kind: "create", id: "note-1", titleBytes: 257, contentBytes: 1 }],
    ["append", { kind: "append", id: "note-1", fragmentBytes: 513 }],
    ["update", { kind: "update", id: "note-1", appliedFields: ["content"], contentBytes: 513 }],
  ])("rejects oversized %s result byte counts", (_kind, result) => {
    expect(() => serializeRpcResponse({ id: "rpc-1", ok: true, result })).toThrow();
    expect(STAGE5_RPC_LIMITS.maxQueryBytes).toBe(512);
  });
});
