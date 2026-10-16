import { Buffer } from "node:buffer";
import type * as FsModule from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const writeFault = vi.hoisted(() => ({ armed: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      if (writeFault.armed) {
        writeFault.armed = false;
        throw new Error("injected write failure");
      }
      return actual.writeSync(...args);
    },
  };
});

import { acquireInspectLock, lockPath, releaseLock, tryAcquireLock } from "../src/config/lock.js";

describe("Stage 1 — lock release integrity", () => {
  const dirs: string[] = [];
  afterEach(() => {
    writeFault.armed = false;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "nb-lock-release-"));
    dirs.push(dir);
    return dir;
  }

  it("preserves a foreign replacement during releaseLock", () => {
    const dir = freshDir();
    const path = lockPath(dir);
    expect(tryAcquireLock(dir)).not.toBeNull();
    unlinkSync(path);
    const foreign = Buffer.from("foreign replacement\n");
    writeFileSync(path, foreign);
    expect(releaseLock(dir)).toBe(true);
    expect(readFileSync(path)).toEqual(foreign);
  });

  it("removes a matching inode and record", () => {
    const dir = freshDir();
    const acquired = acquireInspectLock(dir);
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    expect(acquired.handle.release()).toBe("released");
    expect(readdirSync(dir).filter((name) => name.includes(".release-"))).toEqual([]);
  });

  it("preserves the file when the expected record differs", () => {
    const dir = freshDir();
    const path = lockPath(dir);
    const acquired = acquireInspectLock(dir);
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    // Replace the holder record under the same inode, so the inode matches but
    // the record does not and ownership cannot be proved.
    writeFileSync(path, "wrong record");
    const bytes = readFileSync(path);
    expect(acquired.handle.release()).toBe("foreign");
    expect(readFileSync(path)).toEqual(bytes);
  });

  it("returns gone for an absent path", () => {
    const dir = freshDir();
    const path = lockPath(dir);
    const acquired = acquireInspectLock(dir);
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    // Remove the file out from under the handle: release finds nothing to detach.
    unlinkSync(path);
    expect(acquired.handle.release()).toBe("gone");
    expect(readdirSync(dir).filter((name) => name.includes(".release-"))).toEqual([]);
  });

  it("cleans up after a holder-record write fault and can retry", () => {
    const dir = freshDir();
    writeFault.armed = true;
    expect(tryAcquireLock(dir)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    const release = tryAcquireLock(dir);
    expect(release).not.toBeNull();
    release?.();
    expect(readdirSync(dir)).toEqual([]);
  });
});
