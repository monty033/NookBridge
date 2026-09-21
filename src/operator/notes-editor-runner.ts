import { constants } from "node:fs";
import { Buffer } from "node:buffer";
import { spawn, type SpawnOptions } from "node:child_process";
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Shape of a failed `spawn`: Node attaches the errno as `code`. */
type ErrnoException = Error & { readonly code?: string | undefined };

export const MAX_EDITOR_MARKDOWN_BYTES = 4 * 1024 * 1024;
export const DEFAULT_EDITOR_TIMEOUT_MS = 60_000;

export type NotesEditorErrorCode =
  | "invalid-input"
  | "oversize"
  | "editor-missing"
  | "editor-failed"
  | "timeout"
  | "cancelled"
  | "unsafe-file"
  | "io";

export class NotesEditorError extends Error {
  readonly code: NotesEditorErrorCode;

  constructor(code: NotesEditorErrorCode) {
    super(`notes editor: ${code}`);
    this.name = "NotesEditorError";
    this.code = code;
  }
}

export type NotesEditorResult = Readonly<{
  markdown: string;
  changed: boolean;
}>;

export type NotesEditorOptions = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  tmpRoot?: string;
  timeoutMs?: number;
  cwd?: string;
  signal?: SpawnOptions["signal"];
}>;

/**
 * Opens an external editor without a shell. Note content is written only to
 * the private temporary file; it is never placed in argv or the child env.
 * Editors may replace the file atomically, so the final open uses O_NOFOLLOW.
 */
export async function runNotesEditor(
  initialMarkdown: string,
  options: NotesEditorOptions = {},
): Promise<NotesEditorResult> {
  if (typeof initialMarkdown !== "string") throw new NotesEditorError("invalid-input");
  if (Buffer.byteLength(initialMarkdown, "utf8") > MAX_EDITOR_MARKDOWN_BYTES)
    throw new NotesEditorError("oversize");
  const timeoutMs = options.timeoutMs ?? DEFAULT_EDITOR_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new NotesEditorError("invalid-input");
  // An already-aborted signal never fires the "abort" listener below, so
  // without this check the editor would still launch and hand the operator a
  // note the caller has already cancelled.  Refuse before creating any file.
  if (options.signal?.aborted === true) throw new NotesEditorError("cancelled");

  const environment = options.env ?? process.env;
  const command = resolveEditor(environment);
  const parsed = parseEditorCommand(command);
  const root = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "nookbridge-notes-edit-"));
  const file = join(root, "note.md");
  try {
    await chmod(root, 0o700);
    await writeFile(file, initialMarkdown, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const childOptions: {
      readonly env: Record<string, string | undefined>;
      readonly timeoutMs: number;
      readonly cwd?: string;
      readonly signal?: SpawnOptions["signal"];
    } = {
      env: filteredEnvironment(environment),
      timeoutMs,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    await runChild(parsed.executable, [...parsed.args, file], childOptions);
    const markdown = normalizeEditorLineEndings(await readPrivateMarkdown(file));
    return Object.freeze({ markdown, changed: markdown !== initialMarkdown });
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Normalize the line endings an editor wrote back to the canonical LF form.
 *
 * The document the rest of the system consumes is LF-only by design: the
 * fidelity gate refuses content containing a carriage return, and the preimage
 * comparison is byte-bound.  An editor that saves CRLF — a Windows editor, or a
 * paste out of one — therefore made an otherwise valid save fail with no usable
 * diagnostic.  Normalizing at the boundary keeps the canonical form in exactly
 * one place, is a no-op for an editor that already writes LF, and makes the
 * saved-line-ending form irrelevant to whether a save counts as a change.
 */
export function normalizeEditorLineEndings(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n");
}

function resolveEditor(env: Readonly<Record<string, string | undefined>>): string {
  const command = env.VISUAL || env.EDITOR || "vi";
  // eslint-disable-next-line no-control-regex -- rejecting C0 control characters is the intent here
  if (command.length === 0 || command.length > 256 || /[\u0000-\u001f\u007f]/u.test(command))
    throw new NotesEditorError("invalid-input");
  return command;
}

type ParsedEditor = Readonly<{ executable: string; args: readonly string[] }>;

function parseEditorCommand(command: string): ParsedEditor {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped || quote !== undefined) throw new NotesEditorError("invalid-input");
  if (current.length > 0) tokens.push(current);
  if (
    tokens.length === 0 ||
    // eslint-disable-next-line no-control-regex -- rejecting C0 control characters is the intent here
    tokens.some((token) => token.length === 0 || /[\u0000-\u001f\u007f]/u.test(token))
  )
    throw new NotesEditorError("invalid-input");
  return Object.freeze({ executable: tokens[0]!, args: Object.freeze(tokens.slice(1)) });
}

function filteredEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === "VISUAL" || key === "EDITOR") continue;
    if (
      key === "PATH" ||
      key === "HOME" ||
      key === "TERM" ||
      key === "LANG" ||
      /^LC_[A-Z_]+$/u.test(key)
    )
      result[key] = value;
  }
  return result;
}

async function runChild(
  executable: string,
  args: readonly string[],
  options: Readonly<{
    env: Record<string, string | undefined>;
    cwd?: string;
    timeoutMs: number;
    signal?: SpawnOptions["signal"];
  }>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(executable, args, {
      shell: false,
      env: options.env,
      cwd: options.cwd,
      stdio: "inherit",
    });
    const finish = (error?: NotesEditorError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = (): void => {
      child.kill("SIGTERM");
      finish(new NotesEditorError("cancelled"));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      finish(new NotesEditorError("timeout"));
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error: ErrnoException) => {
      finish(new NotesEditorError(error.code === "ENOENT" ? "editor-missing" : "editor-failed"));
    });
    child.once("close", (code, signal) => {
      if (timedOut || settled) return;
      if (code === 0) finish();
      else if (signal === "SIGTERM" && options.signal?.aborted)
        finish(new NotesEditorError("cancelled"));
      else finish(new NotesEditorError("editor-failed"));
    });
  });
}

async function readPrivateMarkdown(file: string): Promise<string> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const details = await handle.stat();
    if (!details.isFile() || (process.getuid && details.uid !== process.getuid()))
      throw new NotesEditorError("unsafe-file");
    if (details.size > MAX_EDITOR_MARKDOWN_BYTES) throw new NotesEditorError("oversize");
    const content = await handle.readFile("utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_EDITOR_MARKDOWN_BYTES)
      throw new NotesEditorError("oversize");
    return content;
  } catch (error) {
    if (error instanceof NotesEditorError) throw error;
    throw new NotesEditorError("unsafe-file");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
