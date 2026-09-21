import { describe, expect, it, vi } from "vitest";
import { resolveOperatorRequestLockState } from "../src/service/operator-authorization-context.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";

const resolveHandle = (handle: string): string | undefined =>
  handle === "h_one" ? "note_one" : undefined;

const mutating = (params: Record<string, unknown>): RpcRequest =>
  ({ id: "r1", method: "notes.apply-edit", params }) as unknown as RpcRequest;

const readOnly = (params: Record<string, unknown>): RpcRequest =>
  ({ id: "r1", method: "notes.get-view", params }) as unknown as RpcRequest;

describe("operator request lock context", () => {
  it("reads the lock state of the note a mutating request names", async () => {
    // Finding 7: the evaluator must be able to see the lock state of the target
    // it is authorizing, which means resolving it before the sync seam runs.
    const read = vi.fn(async () => "locked" as const);
    await expect(
      resolveOperatorRequestLockState({
        method: "notes.apply-edit",
        request: mutating({ id: "h_one" }),
        resolveHandle,
        readNoteLockState: read,
      }),
    ).resolves.toEqual({ id: "note_one", locked: true });
    expect(read).toHaveBeenCalledWith("note_one");
  });

  it("reads no lock state when there is no target to resolve", async () => {
    // Guard: a read-only method, a forged handle, a request without a handle,
    // and a missing request must all leave the context untouched rather than
    // consulting the database on an untrusted id.
    const read = vi.fn(async () => "locked" as const);
    const cases: Array<{ method: "notes.apply-edit" | "notes.get-view"; request?: RpcRequest }> = [
      { method: "notes.get-view", request: readOnly({ id: "h_one" }) },
      { method: "notes.apply-edit", request: mutating({ id: "h_forged" }) },
      { method: "notes.apply-edit", request: mutating({}) },
      { method: "notes.apply-edit" },
    ];
    for (const testCase of cases) {
      await expect(
        resolveOperatorRequestLockState({
          method: testCase.method,
          request: testCase.request,
          resolveHandle,
          readNoteLockState: read,
        }),
      ).resolves.toBeUndefined();
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("reads no lock state when the daemon exposes no lock reader", async () => {
    await expect(
      resolveOperatorRequestLockState({
        method: "notes.apply-edit",
        request: mutating({ id: "h_one" }),
        resolveHandle,
        resolveOperationNoteId: undefined,
        readNoteLockState: undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it("resolves the lock state of a bare apply-undo through its operation handle", async () => {
    // Review finding: a bare apply-undo carries only an opaque operation handle,
    // so the authorization seam saw no target and skipped the lock check.  The
    // runtime refused the mutation anyway, but the seam is meant to be the first
    // line, so it must resolve the note from the operation record too.
    const read = vi.fn(async () => "locked" as const);
    const operationHandle = `op_${"a".repeat(64)}`;
    await expect(
      resolveOperatorRequestLockState({
        method: "notes.apply-undo",
        request: { id: "r1", method: "notes.apply-undo", params: { operationHandle } },
        resolveHandle,
        resolveOperationNoteId: (handle) =>
          handle === operationHandle ? "note_from_op" : undefined,
        readNoteLockState: read,
      }),
    ).resolves.toEqual({ id: "note_from_op", locked: true });
    expect(read).toHaveBeenCalledWith("note_from_op");
  });

  it("ignores a malformed or unresolvable operation handle", async () => {
    // Guard: a handle that is not the published shape, or that resolves to
    // nothing, must not cause a database read on an untrusted value.
    const read = vi.fn(async () => "locked" as const);
    const resolveOperationNoteId = vi.fn(() => undefined);
    for (const operationHandle of ["op_nothex", "h_one", ""]) {
      await expect(
        resolveOperatorRequestLockState({
          method: "notes.apply-undo",
          request: { id: "r1", method: "notes.apply-undo", params: { operationHandle } },
          resolveHandle,
          resolveOperationNoteId,
          readNoteLockState: read,
        }),
      ).resolves.toBeUndefined();
    }
    expect(resolveOperationNoteId).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
