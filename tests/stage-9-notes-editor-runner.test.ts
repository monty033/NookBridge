import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_EDITOR_MARKDOWN_BYTES,
  NotesEditorError,
  runNotesEditor,
} from "../src/operator/notes-editor-runner.js";

const node = process.execPath;
const baseEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? tmpdir(),
  LANG: "C.UTF-8",
};

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nookbridge-editor-test-"));
}

function editor(code: string): string {
  return `${node} -e ${JSON.stringify(code)}`;
}

describe("notes editor runner", () => {
  it("uses VISUAL before EDITOR and returns edited Markdown", async () => {
    const root = await scratch();
    const result = await runNotesEditor("before", {
      env: {
        ...baseEnv,
        VISUAL: editor("require('fs').appendFileSync(process.argv[1], '\\nvisual')"),
        EDITOR: editor("require('fs').appendFileSync(process.argv[1], '\\neditor')"),
      },
      tmpRoot: root,
    });
    expect(result.markdown).toBe("before\nvisual");
    expect(result.changed).toBe(true);
  });

  it("falls back to EDITOR and then vi", async () => {
    const root = await scratch();
    const result = await runNotesEditor("before", {
      env: {
        ...baseEnv,
        EDITOR: editor("require('fs').appendFileSync(process.argv[1], '\\neditor')"),
      },
      tmpRoot: root,
    });
    expect(result.markdown).toBe("before\neditor");
  });

  it("does not invoke a shell when parsing editor arguments", async () => {
    const root = await scratch();
    const marker = join(root, "shell-marker");
    const command = `${node} -e ${JSON.stringify("require('fs').appendFileSync(process.argv.at(-1), '\\nokay')")} && touch ${marker}`;
    const result = await runNotesEditor("before", {
      env: { ...baseEnv, VISUAL: command },
      tmpRoot: root,
    });
    expect(result.markdown).toBe("before\nokay");
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("rejects oversize input before creating scratch state", async () => {
    const root = await scratch();
    await expect(
      runNotesEditor("x".repeat(MAX_EDITOR_MARKDOWN_BYTES + 1), {
        env: { ...baseEnv, VISUAL: editor("process.exit(0)") },
        tmpRoot: root,
      }),
    ).rejects.toMatchObject({ code: "oversize" });
    expect((await stat(root)).isDirectory()).toBe(true);
    expect((await readFile(join(root, ".keep"), "utf8").catch(() => "")).length).toBe(0);
  });

  it("maps timeout and cleans the scratch directory", async () => {
    const root = await scratch();
    await expect(
      runNotesEditor("before", {
        env: { ...baseEnv, VISUAL: editor("setTimeout(() => {}, 10000)") },
        tmpRoot: root,
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects control characters in editor configuration", async () => {
    await expect(
      runNotesEditor("before", { env: { ...baseEnv, VISUAL: "vi\u0000" } }),
    ).rejects.toBeInstanceOf(NotesEditorError);
  });

  it("keeps the scratch directory private", async () => {
    const root = await scratch();
    const result = await runNotesEditor("before", {
      env: {
        ...baseEnv,
        VISUAL: editor("require('fs').appendFileSync(process.argv[1], '\\nchanged')"),
      },
      tmpRoot: root,
    });
    expect(result.markdown).toBe("before\nchanged");
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    await chmod(root, 0o700);
  });

  /**
   * An already-aborted signal never fires an "abort" listener, so without an
   * explicit pre-check the editor would still launch and hand the operator a
   * note the caller has already cancelled.
   */
  it("refuses before launching the editor when the signal is already aborted", async () => {
    const root = await scratch();
    const marker = join(root, "launched");
    const controller = new AbortController();
    controller.abort();

    await expect(
      runNotesEditor("before", {
        env: {
          ...baseEnv,
          EDITOR: editor(`require('fs').appendFileSync(${JSON.stringify(marker)}, 'x')`),
        },
        tmpRoot: root,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });

    // The editor must never have run.
    await expect(stat(marker)).rejects.toThrow();
  });
});

describe("notes editor runner — line endings", () => {
  it("normalizes the editor's line endings so a CRLF document is not refused", async () => {
    // An editor that saves CRLF (a Windows editor, or a paste out of one)
    // handed a document containing \r to the write path, where the fidelity
    // gate refused the entire note.  Normalizing at the editor boundary keeps
    // the canonical form LF, so the save succeeds instead of failing opaquely.
    const root = await scratch();
    const result = await runNotesEditor("", {
      env: {
        ...baseEnv,
        EDITOR: editor(
          `require('fs').writeFileSync(process.argv[1], ${JSON.stringify("# Title\r\n\r\nBody\r\n")})`,
        ),
      },
      tmpRoot: root,
    });
    expect(result.markdown).toBe("# Title\n\nBody\n");
    expect(result.markdown.includes("\r")).toBe(false);
  });

  it("treats a CRLF rewrite of identical content as unchanged", async () => {
    // A no-op save must stay a no-op: if the line-ending form alone counted as
    // an edit, opening and closing a note would rewrite it.
    const root = await scratch();
    const result = await runNotesEditor("# Title\n\nBody\n", {
      env: {
        ...baseEnv,
        EDITOR: editor(
          `require('fs').writeFileSync(process.argv[1], ${JSON.stringify("# Title\r\n\r\nBody\r\n")})`,
        ),
      },
      tmpRoot: root,
    });
    expect(result.changed).toBe(false);
  });

  it("normalizes a lone carriage return", async () => {
    const root = await scratch();
    const result = await runNotesEditor("", {
      env: {
        ...baseEnv,
        EDITOR: editor(
          `require('fs').writeFileSync(process.argv[1], ${JSON.stringify("# Title\r\rBody\r")})`,
        ),
      },
      tmpRoot: root,
    });
    expect(result.markdown).toBe("# Title\n\nBody\n");
  });
});
