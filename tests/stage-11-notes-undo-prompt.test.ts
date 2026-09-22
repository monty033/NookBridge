import type { Buffer } from "node:buffer";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers";
import { describe, expect, it } from "vitest";

import {
  MAX_PROMPT_HANDLES,
  createNotesUndoSelection,
  isInteractiveTty,
  selectOperation,
} from "../src/operator/notes-undo-prompt.js";

const HANDLE_A = `op_${"a".repeat(64)}`;
const HANDLE_B = `op_${"b".repeat(64)}`;

/** A TTY-looking stream pair backed by memory, plus a capture of output. */
function streams(options: { tty: boolean; answer?: string }) {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  const output = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = options.tty;
  output.isTTY = options.tty;
  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString("utf8");
  });
  if (options.answer !== undefined) {
    // Answer on the next tick so readline has attached its listener.
    setImmediate(() => input.write(`${options.answer}\n`));
  }
  return { input, output, read: () => written };
}

describe("interactive undo selection", () => {
  it("reports no terminal when either stream is not a TTY", () => {
    expect(isInteractiveTty(streams({ tty: false }))).toBe(false);
    const halfTty = streams({ tty: true });
    halfTty.output.isTTY = false;
    expect(isInteractiveTty(halfTty)).toBe(false);
    // The seam fails closed: no selector is offered at all.
    expect(createNotesUndoSelection(streams({ tty: false }))).toEqual({ tty: false });
    expect(createNotesUndoSelection(streams({ tty: false })).select).toBeUndefined();
  });

  it("lists the bounded handle list and returns the chosen handle", async () => {
    const io = streams({ tty: true, answer: "2" });
    const selection = createNotesUndoSelection(io);
    expect(selection.tty).toBe(true);

    await expect(selection.select!([HANDLE_A, HANDLE_B])).resolves.toBe(HANDLE_B);
    expect(io.read()).toContain("1. " + HANDLE_A);
    expect(io.read()).toContain("2. " + HANDLE_B);
  });

  it.each([
    ["an empty line (cancel)", ""],
    ["a non-numeric answer", "yes"],
    ["an out-of-range index", "9"],
    ["a zero index", "0"],
    ["a free-text handle", HANDLE_A],
  ])("returns undefined for %s", async (_label, answer) => {
    const io = streams({ tty: true, answer });
    await expect(selectOperation(io, [HANDLE_A, HANDLE_B])).resolves.toBeUndefined();
  });

  it("never prints anything but operation handles", async () => {
    const io = streams({ tty: true, answer: "" });
    await selectOperation(io, [HANDLE_A]);
    const written = io.read();
    expect(written).toContain(HANDLE_A);
    // No note id, body, path or revision wording reaches the operator.
    for (const forbidden of ["/etc/", "note_", "body:", "rev_"]) {
      expect(written).not.toContain(forbidden);
    }
  });

  it("caps the printed list at the bounded maximum", async () => {
    const io = streams({ tty: true, answer: "3" });
    const handles = Array.from(
      { length: MAX_PROMPT_HANDLES + 5 },
      (_unused, index) => `op_${String(index).padStart(2, "0")}${"c".repeat(62)}`,
    );
    await expect(selectOperation(io, handles)).resolves.toBe(handles[2]);
    expect(io.read()).not.toContain(`  ${MAX_PROMPT_HANDLES + 1}. `);
  });

  it("returns undefined for an empty operation list", async () => {
    const io = streams({ tty: true, answer: "1" });
    await expect(selectOperation(io, [])).resolves.toBeUndefined();
  });
});
