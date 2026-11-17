/**
 * `notes.path_diagnostic` describes a note's body: content type, whether the
 * HTML opens with a tag, and which structures appear. A locked note must not be
 * described that way, and neither must a note whose lock cannot be decided.
 *
 * The content record's own flag is not the lock: core stores a Vault lock as a
 * `vault -> note` relation, so a record that reads `locked: false` can still
 * belong to a note the vault has locked.
 */

import { describe, expect, it } from "vitest";

import { flattenLiveDatabaseToReadOnly } from "../src/core/notesnook-readonly-projection.js";
import { LIVE_CONTENT, makeFakeCore } from "./helpers/bodyless-fake-core.js";

function diagnosticFor(
  options: Parameters<typeof makeFakeCore>[0],
): ReturnType<
  NonNullable<ReturnType<typeof flattenLiveDatabaseToReadOnly>["noteContentDiagnostic"]>
> {
  return flattenLiveDatabaseToReadOnly(makeFakeCore(options) as never).noteContentDiagnostic!("n1");
}

const note = { id: "n1", title: "Has a body", content: LIVE_CONTENT };

describe("the path diagnostic does not describe a locked or undecided note", () => {
  it("refuses a note that a vault links to, even though its content reads unlocked", async () => {
    await expect(diagnosticFor({ notes: [{ ...note, vaultLinks: 1 }] })).rejects.toThrow(
      /vault_locked/,
    );
  });

  it("refuses when the vault probe cannot answer", async () => {
    await expect(diagnosticFor({ notes: [note], omitRelations: true })).rejects.toMatchObject({
      message: "lock_state_unavailable",
    });
  });

  it("still describes an unlocked note", async () => {
    await expect(diagnosticFor({ notes: [note] })).resolves.toMatchObject({
      contentType: "tiptap",
      htmlPrefix: "present",
    });
  });

  it("reports a note with no content record as unavailable rather than refusing", async () => {
    await expect(diagnosticFor({ notes: [{ id: "n1", title: "No body" }] })).resolves.toMatchObject(
      { contentType: "unavailable" },
    );
  });
});
