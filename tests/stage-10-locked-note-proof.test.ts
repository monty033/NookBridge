import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  formatLockedNoteProof,
  runLockedNoteProof,
  type LockedNoteProofRuntime,
} from "../src/operator/locked-note-proof.js";

const path = "General/Bernie Test Locked";

function makeRuntime(result: {
  readonly read: "vault_locked" | "ok" | "not_found" | "permission_denied" | "service_unavailable";
  readonly update:
    | "vault_locked"
    | "ok"
    | "not_found"
    | "permission_denied"
    | "service_unavailable";
  readonly delete:
    | "vault_locked"
    | "ok"
    | "not_found"
    | "permission_denied"
    | "service_unavailable";
}): LockedNoteProofRuntime {
  return {
    lockedNoteProof: async (requestedPath) => ({
      kind: "locked_note_proof",
      pathBytes: Buffer.byteLength(requestedPath, "utf8"),
      ...result,
    }),
  };
}

describe("locked-note proof", () => {
  it("returns vault_locked for read, update, and delete", async () => {
    const result = await runLockedNoteProof(
      path,
      makeRuntime({ read: "vault_locked", update: "vault_locked", delete: "vault_locked" }),
    );
    expect(result).toEqual({
      pathBytes: Buffer.byteLength(path, "utf8"),
      read: "vault_locked",
      update: "vault_locked",
      delete: "vault_locked",
    });
    expect(formatLockedNoteProof(result)).not.toContain("note-locked");
    expect(formatLockedNoteProof(result)).not.toContain("General/");
    expect(Object.keys(result)).toEqual(["pathBytes", "read", "update", "delete"]);
  });

  it("preserves the categorical nonlocked control", async () => {
    const result = await runLockedNoteProof(
      path,
      makeRuntime({ read: "ok", update: "ok", delete: "ok" }),
    );
    expect(result.read).toBe("ok");
    expect(result.update).toBe("ok");
    expect(result.delete).toBe("ok");
  });

  it("normalizes malformed and oversized paths to closed categories", async () => {
    let calls = 0;
    const runtime: LockedNoteProofRuntime = {
      lockedNoteProof: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    };
    expect((await runLockedNoteProof("../escape", runtime)).read).toBe("service_unavailable");
    expect((await runLockedNoteProof("x".repeat(513), runtime)).delete).toBe("service_unavailable");
    expect(calls).toBe(1);
  });

  it("rejects a malformed daemon result and redacts its details", async () => {
    const runtime: LockedNoteProofRuntime = {
      lockedNoteProof: async () =>
        ({
          kind: "wrong",
          pathBytes: 1,
          read: "vault_locked",
          update: "vault_locked",
          delete: "vault_locked",
          id: "note-secret",
          body: "private body",
        }) as never,
    };
    const result = await runLockedNoteProof(path, runtime);
    expect(result.read).toBe("service_unavailable");
    expect(formatLockedNoteProof(result)).not.toContain("note-secret");
    expect(formatLockedNoteProof(result)).not.toContain("private body");
  });
});
