/**
 * Interactive selection of a pending undo operation.
 *
 * The frozen transport rule is that an undo is addressed by a
 * **daemon-minted opaque operation handle** chosen interactively — never
 * by a token on argv or in the environment.  This module owns the
 * process-I/O half of that: it decides whether a real interactive
 * terminal is present, prints the bounded handle list, and reads a
 * single bounded selection.
 *
 * Two properties are deliberate:
 *
 *   - Only opaque operation handles are printed.  No note id, title,
 *     body, path or revision is ever written, so the prompt itself
 *     cannot leak note content.
 *   - The selection is a bounded 1-based index, not free text echoed
 *     back.  The chosen handle is returned from the list this module
 *     just printed — and `runNotesCommand` re-validates it against the
 *     same list, so a hostile implementation cannot smuggle a handle
 *     the daemon never minted.
 */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** Never print more than this many pending operations. */
export const MAX_PROMPT_HANDLES = 100;

/** The bounded index grammar: 1-3 digits only. */
const INDEX_PATTERN = /^[0-9]{1,3}$/;

export interface NotesUndoPromptStreams {
  readonly input: Readable & { readonly isTTY?: boolean };
  readonly output: Writable & { readonly isTTY?: boolean };
}

/** The selection seam shape `runNotesCommand` accepts. */
export interface NotesUndoSelection {
  readonly tty: boolean;
  readonly select?: (handles: readonly string[]) => Promise<string | undefined>;
}

/**
 * `true` only when BOTH streams are interactive terminals.  A pipe on
 * either side means no operator is present to confirm a destructive
 * choice, so the bare `notes undo` form must fail categorical instead.
 */
export function isInteractiveTty(streams: NotesUndoPromptStreams): boolean {
  return streams?.input?.isTTY === true && streams?.output?.isTTY === true;
}

/**
 * Build the interactive seam for the CLI dispatcher.
 *
 * Returns `{ tty: false }` when no terminal is available, which makes a
 * bare `notes undo` fail closed before a runtime is even constructed.
 */
export function createNotesUndoSelection(streams: NotesUndoPromptStreams): NotesUndoSelection {
  if (!isInteractiveTty(streams)) return Object.freeze({ tty: false });
  return Object.freeze({
    tty: true,
    select: (handles: readonly string[]) => selectOperation(streams, handles),
  });
}

/**
 * Print the bounded operation list and read one selection.
 *
 * Returns `undefined` for every non-selection: an empty line, EOF, a
 * non-numeric answer, an out-of-range index, or an I/O failure.  A
 * refusal is never distinguished from a cancel in the return value
 * because the caller treats both as "no undo performed".
 */
export async function selectOperation(
  streams: NotesUndoPromptStreams,
  handles: readonly string[],
): Promise<string | undefined> {
  if (!Array.isArray(handles) || handles.length === 0) return undefined;
  const listed = handles.slice(0, MAX_PROMPT_HANDLES);

  let readline: ReturnType<typeof createInterface>;
  try {
    // Explicit non-terminal mode.  We only ever read one bounded line, so
    // full keypress handling buys nothing — and letting readline infer
    // terminal mode from `isTTY` makes the seam depend on real TTY
    // internals (setRawMode/keypress) instead of plain line input.
    readline = createInterface({
      input: streams.input,
      output: streams.output,
      terminal: false,
    });
  } catch {
    return undefined;
  }

  try {
    streams.output.write("Pending undo operations:\n");
    for (let index = 0; index < listed.length; index += 1) {
      streams.output.write(`  ${index + 1}. ${listed[index]}\n`);
    }

    // `node:readline`'s `question` is callback-only (the promise form
    // lives in `node:readline/promises`), so wrap it explicitly — and
    // settle on `close` too, or EOF would leave the operator hanging.
    const answer = await new Promise<string | undefined>((settle) => {
      let settled = false;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        settle(value);
      };
      readline.once("close", () => finish(undefined));
      readline.question("Select an operation number (empty line to cancel): ", (value: string) =>
        finish(value),
      );
    });
    if (answer === undefined) return undefined;

    const trimmed = String(answer).trim();
    if (!INDEX_PATTERN.test(trimmed)) return undefined;
    const selected = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > listed.length) {
      return undefined;
    }
    return listed[selected - 1];
  } catch {
    return undefined;
  } finally {
    readline.close();
  }
}
