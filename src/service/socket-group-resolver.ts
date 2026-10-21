/**
 * Production socket-group resolver.
 *
 * Reads the local group file directly: no subprocess, no symlink following,
 * and a hard size cap. Groups that exist only through NSS (LDAP, SSSD, ...)
 * are intentionally unsupported, so startup fails closed for them.
 */

import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const GROUP_FILE_PATH = "/etc/group";
export const MAX_GROUP_FILE_BYTES = 1024 * 1024;

export type GroupIdResolver = (name: string) => Promise<number | undefined>;

const GID_FIELD = /^[0-9]+$/;

/** Build a resolver over one group file. The path is injectable for tests. */
export function createGroupIdResolver(groupFilePath: string = GROUP_FILE_PATH): GroupIdResolver {
  return async (name: string): Promise<number | undefined> => {
    if (typeof name !== "string" || name.length === 0) return undefined;
    const text = await readBoundedGroupFile(groupFilePath);
    if (text === undefined) return undefined;
    for (const line of text.split("\n")) {
      const fields = line.split(":");
      if (fields.length < 3 || fields[0] !== name) continue;
      const gidField = fields[2] as string;
      if (!GID_FIELD.test(gidField)) continue;
      const gid = Number(gidField);
      if (Number.isSafeInteger(gid) && gid >= 0) return gid;
    }
    return undefined;
  };
}

/** The production resolver over the system group file. */
export const resolveGroupId: GroupIdResolver = createGroupIdResolver();

async function readBoundedGroupFile(groupFilePath: string): Promise<string | undefined> {
  try {
    // O_NOFOLLOW makes a symlinked final component fail instead of resolving.
    const handle = await open(groupFilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_GROUP_FILE_BYTES) return undefined;
      // Read one byte past the cap so a file that grew after the stat is
      // still rejected rather than silently truncated.
      const buffer = Buffer.alloc(MAX_GROUP_FILE_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > MAX_GROUP_FILE_BYTES) return undefined;
      return buffer.toString("utf8", 0, total);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
