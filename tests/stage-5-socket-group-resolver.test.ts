/** Stage 5 tests for the subprocess-free /etc/group socket-group resolver. */

import type { Buffer } from "node:buffer";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createGroupIdResolver,
  MAX_GROUP_FILE_BYTES,
} from "../src/service/socket-group-resolver.js";

const tempDirectories: string[] = [];

async function resolverFor(
  content: string | Buffer | undefined,
): Promise<(name: string) => Promise<number | undefined>> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nbk-group-"));
  tempDirectories.push(directory);
  const groupFile = path.join(directory, "group");
  if (content !== undefined) await writeFile(groupFile, content);
  return createGroupIdResolver(groupFile);
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("socket group resolver", () => {
  it("resolves an exact group name to its gid", async () => {
    const resolve = await resolverFor(
      "root:x:0:\nnookbridge-clients:x:993:alice,bob\nusers:x:100:\n",
    );

    await expect(resolve("nookbridge-clients")).resolves.toBe(993);
    await expect(resolve("root")).resolves.toBe(0);
  });

  it("does not match a prefix, suffix, or the trailing colon", async () => {
    const resolve = await resolverFor("nookbridge-clients2:x:5:\nold-nookbridge-clients:x:6:\n");

    await expect(resolve("nookbridge-clients")).resolves.toBeUndefined();
    await expect(resolve("nookbridge-clients:")).resolves.toBeUndefined();
    await expect(resolve("nookbridge-clients:x")).resolves.toBeUndefined();
    await expect(resolve("")).resolves.toBeUndefined();
  });

  it("uses the first entry when a name is duplicated", async () => {
    const resolve = await resolverFor("dup:x:10:\ndup:x:20:\n");

    await expect(resolve("dup")).resolves.toBe(10);
  });

  it("ignores entries whose gid is not a non-negative safe integer", async () => {
    const resolve = await resolverFor(
      [
        "alpha:x:abc:",
        "beta:x:-5:",
        "gamma:x::",
        "delta:x:1.5:",
        "epsilon:x:99999999999999999999:",
        "zeta:x:0x10:",
        "short:x",
        "eta:x:7:",
      ].join("\n"),
    );

    for (const name of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "short"]) {
      await expect(resolve(name)).resolves.toBeUndefined();
    }
    await expect(resolve("eta")).resolves.toBe(7);
  });

  it("takes the first entry with a valid gid when an earlier duplicate is malformed", async () => {
    const resolve = await resolverFor("dup:x:oops:\ndup:x:30:\n");

    await expect(resolve("dup")).resolves.toBe(30);
  });

  it("returns undefined for a group file over the 1 MiB cap", async () => {
    expect(MAX_GROUP_FILE_BYTES).toBe(1024 * 1024);
    const padding = "#".repeat(MAX_GROUP_FILE_BYTES);
    const resolve = await resolverFor(`target:x:42:\n${padding}\n`);

    await expect(resolve("target")).resolves.toBeUndefined();
  });

  it("accepts a group file of exactly the cap", async () => {
    const line = "target:x:42:\n";
    const resolve = await resolverFor(line + "#".repeat(MAX_GROUP_FILE_BYTES - line.length));

    await expect(resolve("target")).resolves.toBe(42);
  });

  it("returns undefined for a missing group file", async () => {
    const resolve = await resolverFor(undefined);

    await expect(resolve("anything")).resolves.toBeUndefined();
  });

  it("does not follow a symlinked group file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nbk-group-"));
    tempDirectories.push(directory);
    const real = path.join(directory, "real-group");
    const link = path.join(directory, "group");
    await writeFile(real, "linked:x:77:\n");
    await symlink(real, link);

    await expect(createGroupIdResolver(link)("linked")).resolves.toBeUndefined();
  });

  it("returns undefined when the group path is not a regular file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nbk-group-"));
    tempDirectories.push(directory);

    await expect(createGroupIdResolver(directory)("anything")).resolves.toBeUndefined();
  });

  it("does not resolve a name that only NSS would provide", async () => {
    const resolve = await resolverFor("root:x:0:\n+::::\n+@netgroup\n");

    await expect(resolve("ldap-only-group")).resolves.toBeUndefined();
  });
});
