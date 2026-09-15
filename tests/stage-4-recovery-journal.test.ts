import { describe, expect, it } from "vitest";

import {
  PersistentNotesnookRecoveryJournal,
  type NotesnookRecoveryJournal,
} from "../src/core/notesnook-recovery-journal.js";
import type { PersistentStorage } from "../src/storage/persistent-storage.js";

function storageFixture(): {
  storage: PersistentStorage;
  values: Map<string, unknown>;
} {
  const values = new Map<string, unknown>();
  const storage = {
    readSync: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    writeSync: <T>(key: string, value: T): void => {
      values.set(key, value);
    },
  } as unknown as PersistentStorage;
  return { storage, values };
}

describe("PersistentNotesnookRecoveryJournal", () => {
  it("persists only bounded recovery metadata across journal instances", () => {
    const first = storageFixture();
    const journal = new PersistentNotesnookRecoveryJournal(first.storage);

    journal.record({ operation: "create", noteId: "note-1", stage: "create-notebook-attach" });

    const restarted = new PersistentNotesnookRecoveryJournal(first.storage);
    expect(restarted.snapshot()).toEqual([
      { operation: "create", noteId: "note-1", stage: "create-notebook-attach" },
    ]);
    expect(JSON.stringify([...first.values.values()])).not.toContain("title");
    expect(JSON.stringify([...first.values.values()])).not.toContain("body");
  });

  it("rejects malformed marker data without exposing stored content", () => {
    const { storage, values } = storageFixture();
    values.set("nookbridge:recovery-journal:v1", [{ noteId: "leak", body: "secret" }]);

    const journal: NotesnookRecoveryJournal = new PersistentNotesnookRecoveryJournal(storage);
    expect(journal.snapshot()).toEqual([]);
  });
});
