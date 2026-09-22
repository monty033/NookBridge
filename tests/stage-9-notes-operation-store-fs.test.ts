import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createOperationStoreFs,
  deriveOperationStoreKey,
  OPERATION_STORE_KEY_BYTES,
} from "../src/service/notes-operation-store-fs.js";
import { createNotesUndoStore } from "../src/service/notes-undo-store.js";

const HANDLE = `op_${"a".repeat(64)}`;
const TEMP = `tmp_${"b".repeat(64)}`;

function dir(): string {
  return mkdtempSync(join(tmpdir(), "nookbridge-opstore-"));
}

describe("daemon operation store filesystem adapter", () => {
  it("round-trips exact bytes and lists the stored name", async () => {
    const root = dir();
    try {
      const fs = createOperationStoreFs(root);
      const bytes = new Uint8Array([1, 2, 3, 250]);
      await fs.writeExclusive(TEMP, bytes, 0o600);
      await fs.syncFile(TEMP);
      await fs.rename(TEMP, HANDLE);
      await fs.syncDirectory();
      expect(await fs.list(10)).toEqual([HANDLE]);
      expect(Array.from(await fs.read(HANDLE, 1024))).toEqual([1, 2, 3, 250]);
      await fs.remove(HANDLE);
      await fs.syncDirectory();
      expect(await fs.list(10)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing record", async () => {
    const root = dir();
    try {
      const fs = createOperationStoreFs(root);
      await fs.writeExclusive(HANDLE, new Uint8Array([1]), 0o600);
      await expect(fs.writeExclusive(HANDLE, new Uint8Array([2]), 0o600)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlink where a record is expected", async () => {
    const root = dir();
    try {
      const target = join(root, "outside");
      writeFileSync(target, "secret");
      symlinkSync(target, join(root, HANDLE));
      const fs = createOperationStoreFs(root);
      await expect(fs.read(HANDLE, 1024)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a non-regular file where a record is expected", async () => {
    const root = dir();
    try {
      await mkdir(join(root, HANDLE));
      const fs = createOperationStoreFs(root);
      await expect(fs.read(HANDLE, 1024)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["a traversal name", "../leaked-record", true],
    ["an absolute path", "/etc/hostname", false],
    ["a name outside the closed grammar", "notes.db", false],
  ])("refuses %s", async (_label, name, seedParent) => {
    const root = dir();
    try {
      // Plant a real file where a naive `join(directory, name)` would land,
      // so this test only passes if the closed-grammar guard actually runs
      // BEFORE any path is built.
      if (seedParent) {
        await writeFile(join(root, "..", "leaked-record"), "leaked");
      }
      const fs = createOperationStoreFs(root);
      await expect(fs.read(name, 1024)).rejects.toThrow();
      await expect(fs.writeExclusive(name, new Uint8Array([1]), 0o600)).rejects.toThrow();
      await expect(fs.remove(name)).rejects.toThrow();
    } finally {
      await rm(join(root, "..", "leaked-record"), { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a read larger than the bounded envelope", async () => {
    const root = dir();
    try {
      const fs = createOperationStoreFs(root);
      await fs.writeExclusive(HANDLE, new Uint8Array(64), 0o600);
      await expect(fs.read(HANDLE, 16)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates the private store directory on first use", async () => {
    const root = dir();
    const nested = join(root, "operations");
    try {
      const fs = createOperationStoreFs(nested);
      await fs.writeExclusive(HANDLE, new Uint8Array([9]), 0o600);
      expect(Array.from(await fs.read(HANDLE, 16))).toEqual([9]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("backs a durable encrypted store across a reopen", async () => {
    const root = dir();
    try {
      const key = deriveOperationStoreKey("database-key-material");
      const first = await createNotesUndoStore({
        fs: createOperationStoreFs(root),
        daemonKey: key,
        now: () => 5000,
      });
      const record = await first.insert({ kind: "edit", payload: "preimage", ttlMs: 60_000 });
      await first.transition(record.handle, "prepared", "committing");
      await first.transition(record.handle, "committing", "committed");
      await first.close();

      const second = await createNotesUndoStore({
        fs: createOperationStoreFs(root),
        daemonKey: deriveOperationStoreKey("database-key-material"),
        now: () => 5000,
      });
      const recovered = await second.get(record.handle);
      expect(recovered.state).toBe("committed");
      expect(recovered.payload).toBe("preimage");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives a domain-separated 32-byte key that never contains the raw material", () => {
    const material = "CANARY-database-key-material-7f3a";
    const key = deriveOperationStoreKey(material);
    expect(key.length).toBe(OPERATION_STORE_KEY_BYTES);
    expect(key.toString("utf8")).not.toContain("CANARY");
    expect(key.equals(deriveOperationStoreKey(material))).toBe(true);
    expect(key.equals(deriveOperationStoreKey("other-material"))).toBe(false);
  });
});
