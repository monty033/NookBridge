/**
 * releaseLock removes the lock file only while it is still the file this
 * process created.  A file that later replaced ours — same name, different
 * inode, even identical bytes — belongs to someone else and must survive
 * release.  Ownership is the inode the open fd pins, not the file's name.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as NodeFs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lockPath, releaseLock, tryAcquireLock } from "../src/config/lock.js";

// Fails the next fstat of the lock fd, so acquisition cannot prove ownership.
const fstatFault = vi.hoisted(() => ({ failNext: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      if (fstatFault.failNext) {
        fstatFault.failNext = false;
        throw Object.assign(new Error("fstat boom"), { code: "EIO" });
      }
      return actual.fstatSync(...args);
    },
  };
});

describe("Stage 1 — releaseLock removes only the lock file it created", () => {
  const dirs: string[] = [];

  afterEach(() => {
    fstatFault.failNext = false;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "nb-release-ownership-"));
    dirs.push(dir);
    return dir;
  }

  it("removes its own lock file on release", () => {
    const dir = freshDir();
    const release = tryAcquireLock(dir);
    expect(release).not.toBeNull();

    release?.();

    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("leaves a foreign lock file alone", () => {
    const dir = freshDir();
    const release = tryAcquireLock(dir);
    expect(release).not.toBeNull();

    unlinkSync(lockPath(dir));
    const foreign = "foreign-token\n";
    writeFileSync(lockPath(dir), foreign, { mode: 0o600 });

    try {
      release?.();
      expect(existsSync(lockPath(dir))).toBe(true);
      expect(readFileSync(lockPath(dir), "utf8")).toBe(foreign);
    } finally {
      rmSync(lockPath(dir), { force: true });
    }
  });

  it("leaves a replacement with identical bytes alone: ownership is the inode, not the contents", () => {
    const dir = freshDir();
    const release = tryAcquireLock(dir);
    expect(release).not.toBeNull();

    // Same bytes, new inode.  The open fd pins the original inode, so the
    // replacement cannot reuse its number while this process still holds it.
    const ours = readFileSync(lockPath(dir), "utf8");
    unlinkSync(lockPath(dir));
    writeFileSync(lockPath(dir), ours, { mode: 0o600 });

    try {
      release?.();
      expect(existsSync(lockPath(dir))).toBe(true);
      expect(readFileSync(lockPath(dir), "utf8")).toBe(ours);
    } finally {
      rmSync(lockPath(dir), { force: true });
    }
  });

  it("keeps an unverified lock file in place when acquisition cannot prove ownership of it", () => {
    const dir = freshDir();
    fstatFault.failNext = true;

    expect(tryAcquireLock(dir)).toBeNull();

    // Ownership is unprovable, so the file is not unlinked by path: a path
    // unlink could delete another holder's lock.  It stays on disk and the
    // next start refuses against it until an operator clears it.
    expect(existsSync(lockPath(dir))).toBe(true);
    expect(tryAcquireLock(dir)).toBeNull();
  });

  it("still reports the in-process release as completed", () => {
    const dir = freshDir();
    expect(tryAcquireLock(dir)).not.toBeNull();

    expect(releaseLock(dir)).toBe(true);
    expect(existsSync(lockPath(dir))).toBe(false);
  });
});
