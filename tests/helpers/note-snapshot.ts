/**
 * Test double for the `readNoteSnapshot` slot.
 *
 * Builds a snapshot reader from a metadata reader and a content reader, the
 * way the live factory does under the shared lock: metadata first, content
 * only when the note is not locked, a content failure converted to a
 * category. It takes no lock; the lock itself is covered against the real
 * factory and mutex.
 */

type MetadataReader = (id: string) => Promise<unknown>;
type ContentReader = (id: string) => Promise<unknown>;
type NotebookPathSnapshotReader = (
  metadata: unknown,
) => Promise<readonly { notebookId: string; path: string }[] | undefined>;

export function snapshotFrom(
  readMetadata: MetadataReader,
  readContent: ContentReader,
  readNotebookPathSnapshot?: NotebookPathSnapshotReader,
): (id: string) => Promise<unknown> {
  return async (id: string) => {
    const metadata = await readMetadata(id);
    if (metadata === undefined) return undefined;
    const notebookPathSnapshot = await readNotebookPathSnapshot?.(metadata);
    const paths = notebookPathSnapshot === undefined ? {} : { notebookPathSnapshot };
    if ((metadata as { locked?: unknown }).locked === true) {
      return { metadata, ...paths, contentRefusal: "locked" };
    }
    try {
      return { metadata, ...paths, content: await readContent(id) };
    } catch (error) {
      const locked = error instanceof Error && error.message === "vault_locked";
      return { metadata, ...paths, contentRefusal: locked ? "locked" : "read_failed" };
    }
  };
}
