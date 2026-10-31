import { Buffer } from "node:buffer";
import { createHmac, hkdfSync } from "node:crypto";

import { configureOpaquePlaceholderKey } from "../../src/core/note-document-native.js";

const KEY_MATERIAL = "opaque-placeholder-test-fixture-key";

/** Install the fixture key the expected tokens below are computed with. */
export function useFixturePlaceholderKey(): void {
  configureOpaquePlaceholderKey(KEY_MATERIAL);
}

/**
 * The token the daemon must mint for one opaque block.  It mirrors the key
 * schedule on purpose, so a test pins what a key, note id, revision, traversal
 * index and raw HTML have to produce.
 */
export function expectedPlaceholderToken(
  noteId: string,
  revision: string,
  index: number,
  raw: string,
): string {
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(KEY_MATERIAL, "utf8"),
      Buffer.from("nookbridge/opaque-placeholder/salt/v1"),
      Buffer.from("nookbridge/opaque-placeholder/key/v1"),
      32,
    ),
  );
  return createHmac("sha256", key)
    .update(JSON.stringify([JSON.stringify([noteId, revision]), index, raw]))
    .digest("hex")
    .slice(0, 36);
}
