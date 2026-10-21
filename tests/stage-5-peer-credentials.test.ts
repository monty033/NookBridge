/** Stage 5 — bounded peer-credential parsing and asynchronous resolution. */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type net from "node:net";

import { describe, expect, it, vi } from "vitest";

import { parsePeerHelperOutput, resolvePeerAsync } from "../src/service/peer-credentials.js";

const HELPER_PATH = "/usr/libexec/nookbridge/operator-peercred-helper";

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly kill = vi.fn(() => true);
}

type SpawnSeam = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

function peerSocket(fd = 3): net.Socket {
  return { _handle: { fd } } as unknown as net.Socket;
}

function seamFor(child: FakeChild): SpawnSeam {
  return vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => {
    return child as unknown as ChildProcess;
  });
}

describe("R11 — peer credential parsing", () => {
  it("B1 parses uid, gid and group names into a frozen peer", () => {
    const peer = parsePeerHelperOutput("1000 100 4242 nookbridge-clients wheel");

    expect(peer).toEqual({
      uid: 1000,
      gid: 100,
      groups: ["nookbridge-clients", "wheel"],
    });
    expect(Object.isFrozen(peer)).toBe(true);
  });

  it("B2 rejects every malformed helper shape", () => {
    const inputs = [
      "1000 100",
      "1e3 100 4242 nookbridge-clients",
      "1000 -1 4242 nookbridge-clients",
      "1000 100 4242",
      `1000 100 4242 ${Array.from({ length: 65 }, () => "g").join(" ")}`,
      "1000 100 4242 bad;group",
    ];

    for (const input of inputs) {
      expect(parsePeerHelperOutput(input)).toBeUndefined();
    }
  });

  it("B3 matches the operator resolver's previous inline behaviour", () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      [
        "1000 100 4242 nookbridge-clients wheel",
        { uid: 1000, gid: 100, groups: ["nookbridge-clients", "wheel"] },
      ],
      ["0 0 1 root", { uid: 0, gid: 0, groups: ["root"] }],
      ["1000 100 4242 1000", { uid: 1000, gid: 100, groups: ["1000"] }],
      ["1000 100", undefined],
      ["1e3 100 4242 nookbridge-clients", undefined],
      ["1000 -1 4242 nookbridge-clients", undefined],
      ["1000 100 4242", undefined],
      [`1000 100 4242 ${Array.from({ length: 65 }, () => "g").join(" ")}`, undefined],
      ["1000 100 4242 bad;group", undefined],
      ["1000 100 4242 bad/group", undefined],
      ["  \n1000\t100 4242  wheel \n", { uid: 1000, gid: 100, groups: ["wheel"] }],
    ];

    for (const [input, expected] of cases) {
      expect(parsePeerHelperOutput(input)).toEqual(expected);
    }
  });
});

describe("R11 — asynchronous peer resolution", () => {
  it("B4 returns undefined when the helper exits non-zero", async () => {
    const child = new FakeChild();
    const spawn = seamFor(child);
    const resolution = resolvePeerAsync(peerSocket(), {
      helperPath: HELPER_PATH,
      spawn,
    });

    child.emit("close", 1, null);

    await expect(resolution).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("B5 kills the helper and returns undefined when it times out", async () => {
    const child = new FakeChild();
    const resolution = resolvePeerAsync(peerSocket(), {
      helperPath: HELPER_PATH,
      timeoutMs: 50,
      spawn: seamFor(child),
    });

    await expect(resolution).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("B6 kills the helper and returns undefined when the signal aborts", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const resolution = resolvePeerAsync(peerSocket(), {
      helperPath: HELPER_PATH,
      signal: controller.signal,
      spawn: seamFor(child),
    });

    controller.abort();

    await expect(resolution).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalled();
  });

  it("B7 kills the helper and returns undefined when stdout exceeds 4 KiB", async () => {
    const child = new FakeChild();
    const resolution = resolvePeerAsync(peerSocket(), {
      helperPath: HELPER_PATH,
      spawn: seamFor(child),
    });

    child.stdout.emit("data", Buffer.alloc(4_097, 0x20));

    await expect(resolution).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("B8 refuses a relative helper path or a socket without a valid fd without spawning", async () => {
    const relativeChild = new FakeChild();
    const relativeSpawn = seamFor(relativeChild);
    await expect(
      resolvePeerAsync(peerSocket(), {
        helperPath: "operator-peercred-helper",
        spawn: relativeSpawn,
      }),
    ).resolves.toBeUndefined();
    expect(relativeSpawn).toHaveBeenCalledTimes(0);

    const fdlessChild = new FakeChild();
    const fdlessSpawn = seamFor(fdlessChild);
    await expect(
      resolvePeerAsync({} as net.Socket, { helperPath: HELPER_PATH, spawn: fdlessSpawn }),
    ).resolves.toBeUndefined();
    expect(fdlessSpawn).toHaveBeenCalledTimes(0);

    const negativeChild = new FakeChild();
    const negativeSpawn = seamFor(negativeChild);
    await expect(
      resolvePeerAsync(peerSocket(-1), { helperPath: HELPER_PATH, spawn: negativeSpawn }),
    ).resolves.toBeUndefined();
    expect(negativeSpawn).toHaveBeenCalledTimes(0);
  });
});
