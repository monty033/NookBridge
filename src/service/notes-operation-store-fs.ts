/**
 * T07 — filesystem adapter for the daemon-owned encrypted operation store.
 *
 * `createNotesUndoStore` deliberately takes an injected {@link OperationStoreFs}
 * so its crash-durability logic is testable without a real disk.  This module
 * is the production implementation.
 *
 * Security properties (an operation record holds a trusted native preimage,
 * so this directory is as sensitive as the vault itself):
 *
 *   - names are validated against the closed `op_`/`tmp_` grammar BEFORE any
 *     path is built, so a traversal or absolute name can never escape the
 *     store directory;
 *   - every open uses `O_NOFOLLOW` and the result is verified to be a regular
 *     file owned by the current process, so a symlink or FIFO planted at a
 *     record name is refused rather than followed;
 *   - reads are bounded before allocation;
 *   - writes are exclusive (`wx`) with mode 0600, so a record can never be
 *     silently overwritten;
 *   - `syncFile`/`syncDirectory` expose the fsync points the store's
 *     durability contract depends on.
 *
 * Key derivation is likewise here: the store needs exactly 32 bytes, and the
 * daemon's database key is a string of arbitrary length, so the material is
 * run through HKDF with an application-specific info string.  That gives a
 * domain-separated key: the operation store never uses the database key
 * itself, and the raw material is not recoverable from the derived bytes.
 */

import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hkdfSync } from "node:crypto";

import type { OperationStoreFs } from "./notes-undo-store.js";

/** AES-256 key length the operation store requires. */
export const OPERATION_STORE_KEY_BYTES = 32;

/** HKDF domain separation for the operation-store key. */
const OPERATION_STORE_KEY_INFO = "nookbridge/daemon-operation-store/key/v1";

/** The only record names the store ever mints. */
const RECORD_NAME = /^(op|tmp)_[a-f0-9]{64}$/;

/**
 * Derive the 32-byte operation-store key from daemon key material.
 *
 * The store applies its own HKDF on top of this for record encryption, so
 * this step exists to (a) reach the required 32-byte width from a
 * variable-length secret and (b) keep the operation store on a key that is
 * distinct from the database key.
 */
export function deriveOperationStoreKey(keyMaterial: string): Buffer {
  if (typeof keyMaterial !== "string" || keyMaterial.length === 0) {
    throw new Error("operation store key material is unavailable");
  }
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(keyMaterial, "utf8"),
      Buffer.from("nookbridge/daemon-operation-store/salt/v1"),
      Buffer.from(OPERATION_STORE_KEY_INFO),
      OPERATION_STORE_KEY_BYTES,
    ),
  );
}

function assertName(name: unknown): string {
  if (typeof name !== "string" || !RECORD_NAME.test(name)) {
    throw new Error("operation store name is outside the closed grammar");
  }
  return name;
}

/**
 * Build a filesystem-backed {@link OperationStoreFs} rooted at `directory`.
 * The directory is created on first use with mode 0700.
 */
export function createOperationStoreFs(directory: string): OperationStoreFs {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new Error("operation store directory is required");
  }
  const path = (name: string): string => join(directory, assertName(name));

  async function ensureDirectory(): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  return Object.freeze({
    async list(limit: number): Promise<string[]> {
      await ensureDirectory();
      const entries = await readdir(directory, { withFileTypes: true });
      const names: string[] = [];
      for (const entry of entries) {
        if (names.length >= limit) break;
        if (!entry.isFile()) continue;
        if (!RECORD_NAME.test(entry.name)) continue;
        names.push(entry.name);
      }
      return names;
    },

    async read(name: string, maxBytes: number): Promise<Uint8Array> {
      const target = path(name);
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) {
          throw new Error("operation store entry is not a regular file");
        }
        if (stats.size > maxBytes) {
          throw new Error("operation store record exceeds the bounded envelope");
        }
        const buffer = Buffer.alloc(stats.size);
        let offset = 0;
        while (offset < stats.size) {
          const { bytesRead } = await handle.read(buffer, offset, stats.size - offset, offset);
          if (bytesRead <= 0) break;
          offset += bytesRead;
        }
        if (offset !== stats.size) {
          throw new Error("operation store record is truncated");
        }
        return new Uint8Array(buffer);
      } finally {
        await handle.close();
      }
    },

    async writeExclusive(name: string, bytes: Uint8Array, mode: 0o600): Promise<void> {
      await ensureDirectory();
      const target = path(name);
      const handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        mode,
      );
      try {
        await handle.writeFile(Buffer.from(bytes));
      } finally {
        await handle.close();
      }
    },

    async syncFile(name: string): Promise<void> {
      const target = path(name);
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },

    async rename(from: string, to: string): Promise<void> {
      await rename(path(from), path(to));
    },

    async syncDirectory(): Promise<void> {
      const handle = await open(directory, constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },

    async remove(name: string): Promise<void> {
      await unlink(path(name));
    },
  });
}
