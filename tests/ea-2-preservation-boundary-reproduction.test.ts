/**
 * EA-2 — reproduction of the preservation boundary on an app-shaped note.
 *
 * The note is synthetic: a two-level `checklist`, an app-produced `<hr>`, and
 * one attribute outside the allow-list (`contenteditable` on the closing `<p>`,
 * src/core/note-document-native.ts allow-list). The level under test is the
 * daemon's own, driven the way tests/ea-1-write-gate-reproduction.test.ts
 * drives it (shared harness: tests/helpers/ea-synthetic-daemon.ts).
 *
 * Part 1 pins the two facts the plan row claims. They hold on 67b2627, so
 * they pass before and after this step:
 *   - a one-checkbox edit is refused as `unsupported_content`, and the
 *     decoder is what refuses it;
 *   - `notes.get` still serves the note through the read-only fallback
 *     (src/service/rpc-handler.ts, the `catch` in `readBoundedNoteContent`).
 * Each assertion has a control that differs from the fixture in exactly one
 * respect, so each discriminates.
 *
 * Part 2 is RED on 67b2627 and green after: the whole-document refusal now
 * carries an internal reason and class, and it names the allow-list
 * attribute, not the checklist or the `<hr>`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeNoteDocumentNative,
  hasNonemptyNativeTaskListTitle,
  NoteDocumentNativeError,
  nativeFailureClass,
} from "../src/core/note-document-native.js";
import type * as NoteDocumentNativeModule from "../src/core/note-document-native.js";
import { NOTE_DOCUMENT_MARKDOWN_HEADER } from "../src/core/note-document-markdown.js";
import { noteHtmlReadonlyMarkdown } from "../src/core/note-html-readonly-markdown.js";
import { handleRpcRequest } from "../src/service/rpc-handler.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import type { ServiceRuntime } from "../src/service/service-runtime.js";
import { cleanupSyntheticDaemons, startDaemon } from "./helpers/ea-synthetic-daemon.js";

const trace = vi.hoisted(() => ({
  events: [] as string[],
}));

vi.mock("../src/core/note-document-native.js", async (importOriginal) => {
  const actual = await importOriginal<typeof NoteDocumentNativeModule>();
  return {
    ...actual,
    decodeNoteDocumentNative: ((...args: Parameters<typeof actual.decodeNoteDocumentNative>) => {
      try {
        const out = actual.decodeNoteDocumentNative(...args);
        trace.events.push("decode:ok");
        return out;
      } catch (error) {
        trace.events.push("decode:threw");
        throw error;
      }
    }) as typeof actual.decodeNoteDocumentNative,
    hasNonemptyNativeTaskListTitle: ((html: string) => {
      try {
        const out = actual.hasNonemptyNativeTaskListTitle(html);
        trace.events.push("titleProbe:ok");
        return out;
      } catch (error) {
        trace.events.push("titleProbe:threw");
        throw error;
      }
    }) as typeof actual.hasNonemptyNativeTaskListTitle,
  };
});

afterEach(cleanupSyntheticDaemons);

const policy = createReadWriteNoDeleteServicePolicy();

const CHECKLIST =
  '<ul class="checklist"><li class="checklist--item checked"><p>Synthetic parent</p>' +
  '<ul class="checklist"><li class="checklist--item"><p>Synthetic child</p></li></ul></li>' +
  '<li class="checklist--item"><p>Synthetic sibling</p></li></ul>';
const APP_HR = "<hr>";
const TAIL = "<p>Synthetic tail</p>";
const TAIL_WITH_ATTRIBUTE = '<p contenteditable="false">Synthetic tail</p>';

const APP_NOTE = `${CHECKLIST}${APP_HR}${TAIL_WITH_ATTRIBUTE}`;
const WITHOUT_ATTRIBUTE = `${CHECKLIST}${APP_HR}${TAIL}`;
const WITHOUT_ATTRIBUTE_OR_HR = `${CHECKLIST}${TAIL}`;

const BINDING = { noteId: "synthetic", revision: "rev_synthetic" } as const;

async function rpc(runtime: ServiceRuntime, request: unknown) {
  return handleRpcRequest(request as RpcRequest, runtime, policy);
}

async function getNote(runtime: ServiceRuntime, id: string) {
  const response = await rpc(runtime, { id: "get", method: "notes.get", params: { id } });
  if (!response.ok) throw new Error(`notes.get refused: ${JSON.stringify(response)}`);
  return response.result as unknown as {
    note: { revision: string };
    contentStatus: string;
    markdown?: string;
  };
}

/** The one-checkbox edit an agent makes: read the projection, flip one box, write it back. */
async function flipChildCheckbox(runtime: ServiceRuntime, id: string) {
  const read = await getNote(runtime, id);
  const markdown = read.markdown ?? "";
  const edited = markdown.replace("- [ ] Synthetic child", "- [x] Synthetic child");
  expect(edited).not.toBe(markdown);
  trace.events.length = 0;
  const response = await rpc(runtime, {
    id: "edit",
    method: "notes.update",
    params: { id, expectedRevision: read.note.revision, patch: { content: edited } },
  });
  return { response, events: [...trace.events] };
}

function decodeError(html: string): unknown {
  try {
    decodeNoteDocumentNative({ type: "tiptap", data: html }, BINDING);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("EA-2 part 1: the claims on 67b2627 (green before and after)", () => {
  it("notes.get serves the app-shaped note through the read-only fallback", async () => {
    const { runtime } = await startDaemon([{ id: "app", data: APP_NOTE }]);
    const read = await getNote(runtime, "app");

    expect(read.contentStatus).toBe("ok");
    expect(read.markdown).toBe(noteHtmlReadonlyMarkdown(APP_NOTE));
    expect(read.markdown).not.toContain(NOTE_DOCUMENT_MARKDOWN_HEADER);
    expect(read.markdown).toContain("- [ ] Synthetic child");
  });

  it("control: without the attribute the same note is served as the strict projection", async () => {
    const { runtime } = await startDaemon([{ id: "app", data: WITHOUT_ATTRIBUTE }]);
    const read = await getNote(runtime, "app");

    expect(read.contentStatus).toBe("ok");
    expect(read.markdown?.startsWith(NOTE_DOCUMENT_MARKDOWN_HEADER)).toBe(true);
  });

  it("a one-checkbox edit is refused as unsupported_content and stored bytes are untouched", async () => {
    const { runtime } = await startDaemon([{ id: "app", data: APP_NOTE }]);
    const { response } = await flipChildCheckbox(runtime, "app");

    expect(response).toMatchObject({ ok: false, error: { code: "unsupported_content" } });
    const after = await getNote(runtime, "app");
    expect(after.markdown).toBe(noteHtmlReadonlyMarkdown(APP_NOTE));
  });

  it("the refusal is the pre-mutation title probe, which cannot parse the stored markup", async () => {
    const { runtime } = await startDaemon([{ id: "app", data: APP_NOTE }]);
    const { events } = await flipChildCheckbox(runtime, "app");

    // The adapter probes the stored bytes before it decodes them for the
    // preserved-content check. That probe throws, and the decode at the later
    // gate is never reached: the later gate cannot be the one that refused.
    expect(events).toEqual(["decode:threw", "titleProbe:threw"]);
    expect(() => hasNonemptyNativeTaskListTitle(APP_NOTE)).toThrow(NoteDocumentNativeError);
    trace.events.length = 0;
  });

  it("control: with neither the attribute nor the <hr> the same edit is accepted", async () => {
    const { runtime } = await startDaemon([{ id: "app", data: WITHOUT_ATTRIBUTE_OR_HR }]);
    const { response } = await flipChildCheckbox(runtime, "app");

    expect(response, JSON.stringify(response)).toMatchObject({ ok: true });
  });

  // Control: on 67b2627 the `<hr>` alone does NOT refuse the edit. The strict
  // read projection carries the preserved region as a directive, and the
  // write path re-emits it. This test originally asserted a refusal at the
  // preserved-content gate; that assertion is false on the base commit, so it
  // is recorded here as the accepted control instead of bending the fixture.
  it("control: with the <hr> but without the attribute the edit is accepted", async () => {
    const { runtime } = await startDaemon([{ id: "app", data: WITHOUT_ATTRIBUTE }]);
    const { response, events } = await flipChildCheckbox(runtime, "app");

    expect(response, JSON.stringify(response)).toMatchObject({ ok: true });
    expect(events).toEqual(["decode:ok", "decode:ok"]);
  });
});

describe("EA-2 part 2: the cause is classed (RED on 67b2627)", () => {
  it("the whole-document refusal names the unrecognised attribute and classes it uninterpretable", () => {
    const error = decodeError(APP_NOTE);

    expect(error).toBeInstanceOf(NoteDocumentNativeError);
    const refusal = error as NoteDocumentNativeError;
    expect(refusal.reason).toBe("attr_unrecognised");
    expect(nativeFailureClass("attr_unrecognised")).toBe("uninterpretable");
  });

  it("the checklist and the <hr> alone do not refuse the document", () => {
    expect(decodeError(WITHOUT_ATTRIBUTE)).toBeUndefined();
  });

  it("the reason never reaches the RPC error, its message, or the serialised envelope", async () => {
    const { runtime } = await startDaemon([{ id: "app", data: APP_NOTE }]);
    const { response } = await flipChildCheckbox(runtime, "app");
    const wire = JSON.stringify(response);

    expect(response).toMatchObject({ ok: false });
    for (const secret of ["attr_unrecognised", "uninterpretable", "hostile", "reason", "class"]) {
      expect(wire).not.toContain(secret);
    }
  });
});
