import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeNoteDocumentNative,
  nativeFailureClass,
  NoteDocumentNativeError,
  serializeNoteDocumentNative,
} from "../src/core/note-document-native.js";
import {
  NOTE_DOCUMENT_MARKDOWN_HEADER,
  parseNoteDocumentMarkdown,
  serializeNoteDocumentMarkdown,
} from "../src/core/note-document-markdown.js";
import { handleRpcRequest } from "../src/service/rpc-handler.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";
import type * as MarkdownModule from "../src/core/note-document-markdown.js";
import type * as NativeModule from "../src/core/note-document-native.js";
import type { NativeFailureReason as NativeFailure } from "../src/core/note-document-native.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import type { ServiceRuntime } from "../src/service/service-runtime.js";
import { cleanupSyntheticDaemons, startDaemon } from "./helpers/ea-synthetic-daemon.js";

afterEach(cleanupSyntheticDaemons);

const EMPTY_LIST = "<ul></ul>";
const PRESERVED_HEADING = '<h4 style="text-align:center">Synthetic heading</h4>';
const CHECKLIST =
  '<ul class="checklist"><li class="checklist--item"><p>Synthetic child</p></li></ul>';
const APP_NOTE = `${EMPTY_LIST}${CHECKLIST}${PRESERVED_HEADING}`;
const BINDING = { noteId: "synthetic", revision: "rev_synthetic" } as const;
const envelope = (data: string) => ({
  type: "tiptap" as const,
  data: `<div data-type="document">${data}</div>`,
});
const policy = createReadWriteNoDeleteServicePolicy();

async function rpc(runtime: ServiceRuntime, request: unknown) {
  return handleRpcRequest(request as RpcRequest, runtime, policy);
}

async function getNote(runtime: ServiceRuntime, id: string) {
  const response = await rpc(runtime, { id: "get", method: "notes.get", params: { id } });
  if (!response.ok) throw new Error("synthetic notes.get refused");
  return response.result as unknown as {
    note: { revision: string };
    contentStatus: string;
    markdown?: string;
  };
}

describe("EA-5: preserve native blocks the Markdown codec cannot represent", () => {
  it("demotes an unrepresentable empty list and preserves its exact native bytes on a neighboring edit", () => {
    const decoded = decodeNoteDocumentNative(envelope(APP_NOTE), BINDING);
    const markdown = serializeNoteDocumentMarkdown(decoded.document);

    expect(markdown.startsWith(NOTE_DOCUMENT_MARKDOWN_HEADER)).toBe(true);
    expect(markdown).toContain(":::nookbridge opaque ul");
    expect(markdown).toContain(":::nookbridge opaque h4");

    const editedMarkdown = markdown.replace("- [ ] Synthetic child", "- [x] Synthetic child");
    expect(editedMarkdown).not.toBe(markdown);
    const edited = parseNoteDocumentMarkdown(editedMarkdown, { preimage: decoded.document });
    const stored = serializeNoteDocumentNative(edited, {
      context: decoded.context,
      binding: BINDING,
    });

    expect(stored.data).toContain(EMPTY_LIST);
    expect(stored.data).toContain(PRESERVED_HEADING);
    expect(stored.data).toContain("checked");
  });

  it("serves the synthetic note strictly and accepts a checkbox edit through the public adapter", async () => {
    const { runtime } = await startDaemon([{ id: "app", data: envelope(APP_NOTE).data }]);
    const before = await getNote(runtime, "app");
    const markdown = before.markdown ?? "";

    expect(before.contentStatus).toBe("ok");
    expect(markdown.startsWith(NOTE_DOCUMENT_MARKDOWN_HEADER)).toBe(true);
    expect(markdown).toContain(":::nookbridge opaque ul");
    expect(markdown).toContain(":::nookbridge opaque h4");

    const edited = markdown.replace("- [ ] Synthetic child", "- [x] Synthetic child");
    expect(edited).not.toBe(markdown);
    const response = await rpc(runtime, {
      id: "edit",
      method: "notes.update",
      params: { id: "app", expectedRevision: before.note.revision, patch: { content: edited } },
    });
    expect(response).toMatchObject({ ok: true });

    const after = await getNote(runtime, "app");
    expect(after.markdown?.startsWith(NOTE_DOCUMENT_MARKDOWN_HEADER)).toBe(true);
    expect(after.markdown).toContain("- [x] Synthetic child");
    expect(after.markdown).toContain(":::nookbridge opaque ul");
    expect(after.markdown).toContain(":::nookbridge opaque h4");
  });

  it("round-trips empty containers through the Markdown codec instead of preserving them", () => {
    const empty = {
      version: 1 as const,
      blocks: [
        { type: "callout" as const, variant: "info" as const, blocks: [] },
        { type: "blockquote" as const, blocks: [] },
        { type: "paragraph" as const, inlines: [] },
      ],
    };
    const markdown = serializeNoteDocumentMarkdown(empty);
    expect(parseNoteDocumentMarkdown(markdown)).toEqual(empty);
  });

  it("does not paper over a codec validation refusal with a preserved block", async () => {
    // Only emission and round-trip refusals mean "cannot spell this block". A
    // validation refusal is the codec disagreeing with the document model, and
    // demoting it would hide an inconsistency behind an opaque reference.
    const MARKDOWN = "../src/core/note-document-markdown.js";
    vi.resetModules();
    const document = await import("../src/core/note-document.js");
    vi.doMock(MARKDOWN, async (importOriginal) => {
      const actual = await importOriginal<typeof MarkdownModule>();
      return {
        ...actual,
        serializeNoteDocumentMarkdown: ((
          input: Parameters<typeof actual.serializeNoteDocumentMarkdown>[0],
        ) => {
          if (input.blocks.length === 1)
            throw new document.NoteDocumentError("invalid_shape", "validation");
          return actual.serializeNoteDocumentMarkdown(input);
        }) as typeof actual.serializeNoteDocumentMarkdown,
      };
    });
    try {
      const { decodeNoteDocumentNative: fresh } = (await import(
        "../src/core/note-document-native.js"
      )) as typeof NativeModule;
      const decoded = fresh(envelope("<p>plain</p>"), BINDING);
      expect(decoded.document.blocks).toEqual([
        { type: "paragraph", inlines: [{ text: "plain" }] },
      ]);
    } finally {
      vi.doUnmock(MARKDOWN);
      vi.resetModules();
    }
  });

  it("tags an unexpected throw as unclassified instead of borrowing the stage", async () => {
    // The seam the probe relies on: a refusal the codec raised keeps its stage,
    // but any other throw must stay unclassified so no caller can mistake a
    // codec fault for "cannot spell this block".
    // Both modules must come from one freshly imported graph: the predicate is
    // prototype-identity based, so a second instance would look foreign.
    vi.resetModules();
    const document = await import("../src/core/note-document.js");
    const markdown = await import("../src/core/note-document-markdown.js");
    const thrown = (run: () => unknown): { code?: string; serializationStage?: string } => {
      try {
        run();
        return {};
      } catch (error) {
        return error as { code?: string; serializationStage?: string };
      }
    };
    try {
      expect(
        thrown(() =>
          markdown.atSerializationStage("markdown_emission", () => {
            throw new Error("synthetic codec fault");
          }),
        ),
      ).toMatchObject({ code: "invalid_shape", serializationStage: "unclassified" });

      // A refusal the codec actually raised keeps its own code and the stage.
      expect(
        thrown(() =>
          markdown.atSerializationStage("round_trip", () => {
            throw new document.NoteDocumentError("malformed_link");
          }),
        ),
      ).toMatchObject({ code: "malformed_link", serializationStage: "round_trip" });
    } finally {
      vi.resetModules();
    }
  });

  it("does not demote a block when the serializer throws something it did not classify", async () => {
    // An unexpected internal throw is not a representability verdict. It must
    // not borrow a stage's authority, or a codec bug would be preserved as if
    // it were an unspellable block and never surface at all.
    const MARKDOWN = "../src/core/note-document-markdown.js";
    vi.resetModules();
    vi.doMock(MARKDOWN, async (importOriginal) => {
      const actual = await importOriginal<typeof MarkdownModule>();
      return {
        ...actual,
        serializeNoteDocumentMarkdown: ((
          input: Parameters<typeof actual.serializeNoteDocumentMarkdown>[0],
        ) => {
          if (input.blocks.length === 1) throw new Error("synthetic codec fault");
          return actual.serializeNoteDocumentMarkdown(input);
        }) as typeof actual.serializeNoteDocumentMarkdown,
      };
    });
    try {
      // Class identity is per module instance, so read the predicate from the
      // same freshly-imported graph the decoder ran in.
      const fresh = (await import("../src/core/note-document-native.js")) as typeof NativeModule;
      let failure: unknown;
      try {
        fresh.decodeNoteDocumentNative(envelope("<p>plain</p>"), BINDING);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(fresh.NoteDocumentNativeError);
      expect(fresh.nativeFailureClass((failure as { reason: NativeFailure }).reason)).toBe(
        "unclassified",
      );
    } finally {
      vi.doUnmock(MARKDOWN);
      vi.resetModules();
    }
  });

  it("still treats executable markup as hostile rather than preserving it", () => {
    let failure: unknown;
    try {
      decodeNoteDocumentNative(envelope(`<script>synthetic</script>${CHECKLIST}`), BINDING);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(NoteDocumentNativeError);
    const nativeError = failure as NoteDocumentNativeError;
    expect(nativeFailureClass(nativeError.reason)).toBe("hostile");
  });
});
