import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { expect, it } from "vitest";

const productionFlags = [
  "-std=c11",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-static",
  "-nostdlib",
  "-ffreestanding",
  "-fno-builtin",
  "-fno-stack-protector",
  "-fno-asynchronous-unwind-tables",
  "-fno-unwind-tables",
  "-fno-pie",
  "-no-pie",
  "-Wl,-e,_start",
  "-Wl,--build-id=none",
];

const compilerProbe = spawnSync("cc", ["--version"]);
const compilerUnavailable =
  compilerProbe.error !== undefined &&
  "code" in compilerProbe.error &&
  compilerProbe.error.code === "ENOENT";

it.skipIf(compilerUnavailable)(
  "native helper retains connect-time credentials after the peer is killed and reaped",
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nook-peercred-"));
    const helper = path.join(directory, "helper");
    const socketPath = path.join(directory, "peer.sock");
    const server = net.createServer({ allowHalfOpen: true });
    let socket: net.Socket | undefined;
    let peer: ReturnType<typeof spawn> | undefined;
    try {
      const build = spawnSync(
        "cc",
        [...productionFlags, "native/operator-peercred.c", "-o", helper],
        {
          encoding: "utf8",
        },
      );
      expect(build.error).toBeUndefined();
      expect(build.status, build.stderr).toBe(0);
      expect(readFileSync(helper).includes(Buffer.from("/proc/"))).toBe(false);

      server.listen(socketPath);
      await once(server, "listening");
      const connected = once(server, "connection");
      peer = spawn(process.execPath, [
        "-e",
        'const net = require("node:net"); net.connect(process.argv[1]); setInterval(() => {}, 1000);',
        socketPath,
      ]);
      [socket] = (await connected) as [net.Socket];
      // Keep the accepted descriptor alive even after the remote end closes.
      socket.pause();
      const fd = (socket as net.Socket & { _handle: { fd: number } })._handle.fd;
      const readCredentials = () => {
        const result = spawnSync(helper, [], { stdio: [fd, "pipe", "pipe"], encoding: "utf8" });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toMatch(/^\d+ \d+ \d+(?: [A-Za-z0-9_.+-]+)+\n$/);
        return result.stdout.trim().split(/\s+/);
      };
      const alive = readCredentials();
      expect(alive.slice(0, 3)).toEqual([
        String(process.getuid!()),
        String(process.getgid!()),
        String(peer.pid),
      ]);
      expect(alive.length).toBeLessThanOrEqual(67);
      const primaryGid = process.getgid!();
      const localName = readFileSync("/etc/group", "utf8")
        .split("\n")
        .map((line) => line.split(":"))
        .find(
          ([name, , gid]) =>
            Number(gid) === primaryGid && /^[A-Za-z0-9_.+-]{1,64}$/.test(name ?? ""),
        )?.[0];
      expect(alive.slice(3)).toContain(localName ?? String(primaryGid));

      const reaped = once(peer, "exit");
      peer.kill("SIGKILL");
      await reaped;
      // Node's exit event follows waitpid: the original peer no longer exists.
      const exited = readCredentials();
      expect(exited.slice(0, 3)).toEqual(alive.slice(0, 3));
      expect(exited.slice(3).sort()).toEqual(alive.slice(3).sort());
    } finally {
      if (peer && peer.exitCode === null && peer.signalCode === null) {
        const reaped = once(peer, "exit");
        peer.kill("SIGKILL");
        await reaped;
      }
      socket?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
  15_000,
);
