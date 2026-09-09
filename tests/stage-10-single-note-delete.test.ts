/** Stage 10 bounded single-note delete vertical slice. */

import { TextEncoder } from "node:util";

import { describe, expect, it } from "vitest";

import { parseRpcFrame } from "../src/service/rpc-protocol.js";
import {
  createRevisionToken,
  planDeleteNote,
  type DeleteNoteCommand,
} from "../src/core/notesnook-write-contract.js";

function encodeFrame(payload: object): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const frame = new Uint8Array(4 + bytes.length);
  frame[0] = (bytes.length >>> 24) & 0xff;
  frame[1] = (bytes.length >>> 16) & 0xff;
  frame[2] = (bytes.length >>> 8) & 0xff;
  frame[3] = bytes.length & 0xff;
  frame.set(bytes, 4);
  return frame;
}

describe("Stage 10 notes.delete", () => {
  it("accepts exactly an exact note path on the wire", () => {
    const request = parseRpcFrame(
      encodeFrame({
        id: "delete-1",
        method: "notes.delete",
        params: { path: "Outdoors/Canoe Trip" },
      }),
    );

    expect(request).toMatchObject({
      id: "delete-1",
      method: "notes.delete",
      params: { path: "Outdoors/Canoe Trip" },
    });
  });

  it("plans a revision-guarded delete and rejects extra command fields", () => {
    const expectedRevision = createRevisionToken({ id: "note-1", dateEdited: 1 });
    const command = { id: "note-1", expectedRevision } satisfies DeleteNoteCommand;
    expect(planDeleteNote(command)).toMatchObject({
      operation: "delete",
      id: "note-1",
      expectedRevision,
      localCommitted: false,
      remoteSynced: false,
      pendingSync: true,
    });
    expect(() =>
      planDeleteNote({ ...command, force: true } as DeleteNoteCommand & { force: boolean }),
    ).toThrow();
  });
});
