/**
 * A crashed daemon leaves `nookbridge.lock` behind: the acquisition is an
 * exclusive create and the release only happens on a clean shutdown.  A
 * SIGKILL (OOM, power loss, `kill -9`) therefore leaves a lock that every
 * later start is refused against, forever, until an operator deletes the
 * file by hand — the service never comes back on its own.
 *
 * These tests pin the recovery contract: every existing lock fails closed,
 * regardless of whether its holder is alive.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { lockFileExists, lockPath, releaseLock, tryAcquireLock } from "../src/config/lock.js";

describe("Stage 1 — single-instance lock: fail-closed stale locks", () => {
  const dirs: string[] = [];
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill("SIGKILL");
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "nb-stale-lock-"));
    dirs.push(dir);
    return dir;
  }

  /** A pid that refers to no live process: spawn one, then wait for it. */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    if (typeof child.pid !== "number") {
      throw new Error("could not obtain a pid for the stale-lock fixture");
    }
    return child.pid;
  }

  function liveProcess(): ChildProcess {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    children.push(child);
    return child;
  }

  it("refuses a lock left behind by a holder that is gone", () => {
    const dir = freshDir();
    writeFileSync(lockPath(dir), `${deadPid()}\n`);

    const release = tryAcquireLock(dir);

    expect(release).toBeNull();
    expect(existsSync(lockPath(dir))).toBe(true);
    expect(lockFileExists(dir)).toBe(true);
    expect(readFileSync(lockPath(dir), "utf8")).toBeTruthy();
  });

  it("refuses a lock whose holder is still alive", () => {
    const dir = freshDir();
    const holder = liveProcess();
    writeFileSync(lockPath(dir), `${holder.pid}\n`);

    expect(tryAcquireLock(dir)).toBeNull();
  });

  it("refuses a lock recorded as held by this process", () => {
    const dir = freshDir();
    writeFileSync(lockPath(dir), `${process.pid}\n`);

    expect(tryAcquireLock(dir)).toBeNull();
  });

  it("refuses a freshly created lock file whose holder has not written a pid yet", () => {
    // Acquisition creates the file before writing the pid.  A second start
    // that lands inside that window must not steal the lock — it would give
    // two processes the same database.
    const dir = freshDir();
    writeFileSync(lockPath(dir), "");

    expect(tryAcquireLock(dir)).toBeNull();
  });

  it("refuses an old unidentified lock file", () => {
    const dir = freshDir();
    const path = lockPath(dir);
    writeFileSync(path, "");
    const old = new Date(Date.now() - 120_000);
    utimesSync(path, old, old);

    expect(tryAcquireLock(dir)).toBeNull();
    expect(lockFileExists(dir)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("");
  });

  it("refuses a lock whose recorded pid was reused by a different process", () => {
    const dir = freshDir();
    const holder = liveProcess();
    // The pid is alive, but the recorded start time is not that process's.
    writeFileSync(lockPath(dir), `${holder.pid}\n999999999\n`);

    const path = lockPath(dir);
    expect(tryAcquireLock(dir)).toBeNull();
    expect(existsSync(path)).toBe(true);
    expect(lockFileExists(dir)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(`${holder.pid}\n999999999\n`);
  });

  it("reports any existing stale lock as present", () => {
    const dir = freshDir();
    const path = lockPath(dir);

    writeFileSync(path, `${deadPid()}\n`);
    expect(lockFileExists(dir)).toBe(true);

    const holder = liveProcess();
    writeFileSync(path, `${holder.pid}\n`);
    expect(lockFileExists(dir)).toBe(true);
  });

  it("keeps a cleanly released lock acquirable", () => {
    const dir = freshDir();
    const release = tryAcquireLock(dir);
    expect(release).not.toBeNull();
    releaseLock(dir);

    const again = tryAcquireLock(dir);
    expect(again).not.toBeNull();
    again?.();
  });
});
