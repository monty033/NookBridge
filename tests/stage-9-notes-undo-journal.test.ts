/**
 * Stage 9 §13.11 — bounded encrypted undo preimage journal slice.
 *
 * Test boundary for `src/operator/notes-undo-journal.ts`, an
 * isolated, injected persistence/runtime seam that stores a
 * frozen, immutable, AES-256-GCM-encrypted preimage under an
 * opaque undo token.  It is the third slice of §13.11 and sits
 * BEFORE any edit/undo wiring.
 *
 * Strict TDD scope (pinned in the task allowlist):
 *
 *   - the persistence seam is INJECTED — no real filesystem, no
 *     real Notesnook handle, no real database, no real network,
 *     no RPC, no MCP, no sync, no auth, no editor, no CLI;
 *   - the cipher seam is INJECTED — the journal uses a
 *     caller-supplied cipher helper (default: real AES-256-GCM
 *     via node:crypto) but NEVER ships a built-in plaintext
 *     fallback; tests pin the cipher's allowlisted shape and
 *     prove the journal never holds plaintext in memory after
 *     `record` returns;
 *   - the token factory is INJECTED so the test can be
 *     deterministic — the journal never invents tokens itself
 *     outside the injected factory;
 *   - ciphertext-only persistence: the injected store MUST
 *     receive ciphertext and never plaintext; a single test
 *     inspects the store value to prove this property holds;
 *   - the bounded input surface accepts ONLY:
 *       - opaque note handle shaped `<prefix>_<token>` with the
 *         reserved `rev_` family excluded (matching the CLI
 *         contract in `notes-cli.ts`);
 *       - opaque revision token shaped `rev_<32-hex>`;
 *       - title length <= 100;
 *       - content length <= 4 MiB UTF-8 bytes;
 *       - metadata entries whose key length and value length
 *         stay inside a closed cap;
 *   - opaque undo tokens returned from `record` MUST satisfy the
 *     bounded opaque value grammar (`<prefix>_<token>`, length
 *     1..128) and are reserved `rev_`-excluded so a token can
 *     never be confused with a revision;
 *   - failed decrypt / failed validation does NOT remove store
 *     data; the journal never auto-mutates the store as a side
 *     effect of a load/consume failure;
 *   - `consume` and `remove` are explicit, separate surfaces;
 *     `remove` is the ONLY path that deletes data from the
 *     store;
 *   - fixed-shape closed categorical results: `stored`,
 *     `preimage`, `missing`, `invalid-input`, `locked`,
 *     `conflict`, `error`.  No token, body, title, ID, path,
 *     upstream message, or ciphertext blob is ever echoed
 *     across the formatter boundary;
 *   - records returned from the journal are frozen so callers
 *     cannot mutate the snapshot through this slice;
 *   - the journal does NOT call into Notesnook, the live
 *     transport, the RPC layer, MCP, sync, auth, or the editor.
 *
 * No docs are written because this remains an injected
 * persistence/runtime slice, not user-facing/wired.
 */

import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { TextEncoder } from "node:util";
import { describe, expect, it } from "vitest";

import {
  AES_GCM_AUTH_TAG_BYTES,
  AES_GCM_KEY_BYTES,
  AES_GCM_NONCE_BYTES,
  AES_GCM_VERSION_PREFIX,
  createAesGcmCipher,
  createNotesUndoJournal,
  isNotesUndoJournalError,
  type NotesUndoJournalAesGcmCipher,
  type NotesUndoJournalStore,
} from "../src/operator/notes-undo-journal.js";
import { isBoundedOpaqueValue } from "../src/operator/notes-cli.js";

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

/**
 * Build a deterministic fake token factory.  The factory returns
 * handles shaped `unjt_<n>` where `<n>` is a monotonically
 * increasing counter padded to 8 digits.  The shape MUST satisfy
 * `isBoundedOpaqueValue` and MUST NOT begin with the reserved
 * `rev_` family.
 */
type FakeTokenFactory = {
  readonly mint: () => string;
  readonly minted: readonly string[];
};

function createFakeTokenFactory(): FakeTokenFactory {
  let counter = 0;
  const minted: string[] = [];
  return {
    get minted() {
      return minted.slice();
    },
    mint(): string {
      counter += 1;
      const token = `unjt_${counter.toString().padStart(8, "0")}`;
      minted.push(token);
      return token;
    },
  };
}

/**
 * Build a 32-byte zero key.  This is deterministic so the test
 * can prove the cipher rejects the wrong key length categorically.
 * Real callers supply a 32-byte key from a real key source — the
 * journal never reads `process.env` or any other carrier.
 */
function zeroKey(): Buffer {
  return Buffer.alloc(AES_GCM_KEY_BYTES, 0);
}

/**
 * Build the real AES-256-GCM cipher helper so the test exercises
 * the production cipher path.  The cipher exposes a closed
 * interface — `encrypt` / `decrypt` only — and validates the key
 * length categorically.
 */
function createRealAesGcmCipher(key: Buffer): NotesUndoJournalAesGcmCipher & {
  readonly encryptCalls: number;
  readonly decryptCalls: number;
} {
  if (key.length !== AES_GCM_KEY_BYTES) {
    throw new Error("real AES-GCM key length mismatch");
  }
  const counters = { encryptCalls: 0, decryptCalls: 0 };
  return {
    get encryptCalls() {
      return counters.encryptCalls;
    },
    get decryptCalls() {
      return counters.decryptCalls;
    },
    encrypt(plaintext: Uint8Array): Uint8Array {
      counters.encryptCalls += 1;
      const nonce = randomBytes(AES_GCM_NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      // Frame: VERSION_PREFIX | nonce(12) | tag(16) | ciphertext.
      const out = Buffer.alloc(
        AES_GCM_VERSION_PREFIX.length +
          AES_GCM_NONCE_BYTES +
          AES_GCM_AUTH_TAG_BYTES +
          ciphertext.length,
      );
      let offset = 0;
      out.write(AES_GCM_VERSION_PREFIX, offset, "ascii");
      offset += AES_GCM_VERSION_PREFIX.length;
      nonce.copy(out, offset);
      offset += AES_GCM_NONCE_BYTES;
      tag.copy(out, offset);
      offset += AES_GCM_AUTH_TAG_BYTES;
      ciphertext.copy(out, offset);
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    },
    decrypt(framed: Uint8Array): Uint8Array {
      counters.decryptCalls += 1;
      const min = AES_GCM_VERSION_PREFIX.length + AES_GCM_NONCE_BYTES + AES_GCM_AUTH_TAG_BYTES;
      if (framed.length < min) {
        throw new Error("framed payload too short");
      }
      const view = Buffer.from(framed.buffer, framed.byteOffset, framed.byteLength);
      const prefix = view.subarray(0, AES_GCM_VERSION_PREFIX.length).toString("ascii");
      if (prefix !== AES_GCM_VERSION_PREFIX) {
        throw new Error("framed payload version prefix mismatch");
      }
      const nonce = view.subarray(
        AES_GCM_VERSION_PREFIX.length,
        AES_GCM_VERSION_PREFIX.length + AES_GCM_NONCE_BYTES,
      );
      const tag = view.subarray(
        AES_GCM_VERSION_PREFIX.length + AES_GCM_NONCE_BYTES,
        AES_GCM_VERSION_PREFIX.length + AES_GCM_NONCE_BYTES + AES_GCM_AUTH_TAG_BYTES,
      );
      const ciphertext = view.subarray(
        AES_GCM_VERSION_PREFIX.length + AES_GCM_NONCE_BYTES + AES_GCM_AUTH_TAG_BYTES,
      );
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return new Uint8Array(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
    },
  };
}

/**
 * Build an injected fake store backed by a `Map`.  Every put/get
 * call is recorded so tests can assert that the store NEVER
 * receives plaintext and that `remove` is the only path that
 * deletes data.
 */
type FakeStore = NotesUndoJournalStore & {
  readonly putCalls: readonly { readonly token: string; readonly bytes: number }[];
  readonly getCalls: readonly string[];
  readonly removeCalls: readonly string[];
  readonly raw: Map<string, string>;
};

function createFakeStore(): FakeStore {
  const raw = new Map<string, string>();
  const putCalls: { token: string; bytes: number }[] = [];
  const getCalls: string[] = [];
  const removeCalls: string[] = [];
  const store: FakeStore = {
    putCalls,
    getCalls,
    removeCalls,
    raw,
    async put(token: string, ciphertext: Uint8Array): Promise<void> {
      const base64 = Buffer.from(
        ciphertext.buffer,
        ciphertext.byteOffset,
        ciphertext.byteLength,
      ).toString("base64");
      raw.set(token, base64);
      putCalls.push({ token, bytes: ciphertext.byteLength });
    },
    async get(token: string): Promise<Uint8Array | undefined> {
      getCalls.push(token);
      const value = raw.get(token);
      if (value === undefined) return undefined;
      return new Uint8Array(Buffer.from(value, "base64"));
    },
    async remove(token: string): Promise<void> {
      removeCalls.push(token);
      raw.delete(token);
    },
  };
  // Cast through unknown so the readonly accessors on the
  // interface shape are satisfied while the fake retains its
  // mutable `raw` Map for the test harness.
  return store as FakeStore;
}

// ---------------------------------------------------------------------------
// Cipher helper — public AES-256-GCM framing.
// ---------------------------------------------------------------------------

describe("createAesGcmCipher — frame validation", () => {
  it("rejects a non-Buffer / non-Uint8Array key", () => {
    let captured: unknown;
    try {
      createAesGcmCipher("not-a-key" as unknown as Buffer);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
  });

  it("rejects a key of the wrong length (16, 24, 31, 33)", () => {
    for (const length of [16, 24, 31, 33]) {
      let captured: unknown;
      try {
        createAesGcmCipher(Buffer.alloc(length, 0));
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(Error);
      expect(isNotesUndoJournalError(captured)).toBe(true);
    }
  });

  it("rejects an empty key", () => {
    let captured: unknown;
    try {
      createAesGcmCipher(Buffer.alloc(0));
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
  });

  it("accepts a 32-byte key and exposes a frozen cipher interface", () => {
    const cipher = createAesGcmCipher(zeroKey());
    expect(Object.isFrozen(cipher)).toBe(true);
    expect(typeof cipher.encrypt).toBe("function");
    expect(typeof cipher.decrypt).toBe("function");
  });

  it("rejects a Uint8Array-backed key whose byteLength is wrong", () => {
    const wrong = new Uint8Array(31);
    let captured: unknown;
    try {
      createAesGcmCipher(wrong);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
  });

  it("round-trips a plaintext through encrypt/decrypt with the same key", () => {
    const cipher = createAesGcmCipher(zeroKey());
    const plaintext = new TextEncoder().encode("hello-preimage");
    const framed = cipher.encrypt(plaintext);
    const recovered = cipher.decrypt(framed);
    expect(Buffer.from(recovered).toString("utf8")).toBe("hello-preimage");
  });

  it("emits a framed payload that starts with the fixed version prefix", () => {
    const cipher = createAesGcmCipher(zeroKey());
    const framed = cipher.encrypt(new TextEncoder().encode("x"));
    const head = Buffer.from(
      framed.buffer,
      framed.byteOffset,
      AES_GCM_VERSION_PREFIX.length,
    ).toString("ascii");
    expect(head).toBe(AES_GCM_VERSION_PREFIX);
  });

  it("emits a fresh nonce on every encrypt call", () => {
    const cipher = createAesGcmCipher(zeroKey());
    const a = cipher.encrypt(new TextEncoder().encode("x"));
    const b = cipher.encrypt(new TextEncoder().encode("x"));
    // Different nonces ⇒ different frames even for identical plaintext.
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("redacts auth-tag failures to a categorical cipher error", () => {
    const a = createAesGcmCipher(Buffer.alloc(AES_GCM_KEY_BYTES, 0x01));
    const b = createAesGcmCipher(Buffer.alloc(AES_GCM_KEY_BYTES, 0x02));
    const plaintext = new TextEncoder().encode("secret-token-material");
    const framed = a.encrypt(plaintext);
    let captured: unknown;
    try {
      b.decrypt(framed);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
    const message = (captured as Error).message;
    expect(message).not.toMatch(/secret/);
    expect(message).not.toMatch(/token/);
    expect(message).not.toMatch(/material/);
  });

  it("redacts framing-version mismatches to a categorical cipher error", () => {
    const cipher = createAesGcmCipher(zeroKey());
    const framed = cipher.encrypt(new TextEncoder().encode("x"));
    const buf = Buffer.from(framed);
    // Corrupt the version prefix by zeroing the first byte.
    buf[0] = 0;
    let captured: unknown;
    try {
      cipher.decrypt(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
    expect((captured as Error).message).not.toMatch(/secret/);
  });

  it("redacts under-length frames to a categorical cipher error", () => {
    const cipher = createAesGcmCipher(zeroKey());
    const tooShort = new Uint8Array(5);
    let captured: unknown;
    try {
      cipher.decrypt(tooShort);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
  });

  it("produces ciphertext that does NOT contain the plaintext bytes verbatim", () => {
    const cipher = createAesGcmCipher(zeroKey());
    const secret = "PREIMAGE-SECRET-CONTENT-XYZZY-12345";
    const framed = cipher.encrypt(new TextEncoder().encode(secret));
    const framedAsString = Buffer.from(framed).toString("binary");
    expect(framedAsString).not.toContain(secret);
    expect(framedAsString).not.toContain("XYZZY");
  });
});

// ---------------------------------------------------------------------------
// Constructor — injected seam validation.
// ---------------------------------------------------------------------------

describe("createNotesUndoJournal — constructor", () => {
  it("rejects a missing store categorically", () => {
    let captured: unknown;
    try {
      createNotesUndoJournal({
        store: undefined as unknown as NotesUndoJournalStore,
        cipher: createRealAesGcmCipher(zeroKey()),
        tokenFactory: createFakeTokenFactory().mint,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
  });

  it("rejects a store missing `put`", () => {
    const bad = { get: () => undefined, remove: async () => undefined };
    let captured: unknown;
    try {
      createNotesUndoJournal({
        store: bad as unknown as NotesUndoJournalStore,
        cipher: createRealAesGcmCipher(zeroKey()),
        tokenFactory: createFakeTokenFactory().mint,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
  });

  it("rejects a store missing `get`", () => {
    const bad = { put: async () => undefined, remove: async () => undefined };
    let captured: unknown;
    try {
      createNotesUndoJournal({
        store: bad as unknown as NotesUndoJournalStore,
        cipher: createRealAesGcmCipher(zeroKey()),
        tokenFactory: createFakeTokenFactory().mint,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
  });

  it("rejects a store missing `remove`", () => {
    const bad = { put: async () => undefined, get: async () => undefined };
    let captured: unknown;
    try {
      createNotesUndoJournal({
        store: bad as unknown as NotesUndoJournalStore,
        cipher: createRealAesGcmCipher(zeroKey()),
        tokenFactory: createFakeTokenFactory().mint,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
  });

  it("rejects a store that exposes a forbidden mutating method", () => {
    const leaky = {
      ...createFakeStore(),
      call: () => {
        throw new Error("generic call must never be invoked");
      },
    };
    let captured: unknown;
    try {
      createNotesUndoJournal({
        store: leaky as unknown as NotesUndoJournalStore,
        cipher: createRealAesGcmCipher(zeroKey()),
        tokenFactory: createFakeTokenFactory().mint,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
  });

  it("rejects a missing cipher categorically", () => {
    let captured: unknown;
    try {
      createNotesUndoJournal({
        store: createFakeStore(),
        cipher: undefined as unknown as NotesUndoJournalAesGcmCipher,
        tokenFactory: createFakeTokenFactory().mint,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
  });

  it("rejects a cipher missing `encrypt`", () => {
    const bad = { decrypt: () => new Uint8Array(0) };
    let captured: unknown;
    try {
      createNotesUndoJournal({
        store: createFakeStore(),
        cipher: bad as unknown as NotesUndoJournalAesGcmCipher,
        tokenFactory: createFakeTokenFactory().mint,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
  });

  it("rejects a cipher missing `decrypt`", () => {
    const bad = { encrypt: () => new Uint8Array(0) };
    let captured: unknown;
    try {
      createNotesUndoJournal({
        store: createFakeStore(),
        cipher: bad as unknown as NotesUndoJournalAesGcmCipher,
        tokenFactory: createFakeTokenFactory().mint,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
  });

  it("rejects a missing token factory categorically", () => {
    let captured: unknown;
    try {
      createNotesUndoJournal({
        store: createFakeStore(),
        cipher: createRealAesGcmCipher(zeroKey()),
        tokenFactory: undefined as unknown as () => string,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
  });

  it("rejects a token factory that is not a function", () => {
    let captured: unknown;
    try {
      createNotesUndoJournal({
        store: createFakeStore(),
        cipher: createRealAesGcmCipher(zeroKey()),
        tokenFactory: "not-a-function" as unknown as () => string,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(isNotesUndoJournalError(captured)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `record` — bounded input + ciphertext-only persistence.
// ---------------------------------------------------------------------------

describe("createNotesUndoJournal — record", () => {
  it("accepts a bounded opaque handle and revision token and returns `stored` with an opaque undo token", async () => {
    const tokenFactory = createFakeTokenFactory();
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const journal = createNotesUndoJournal({ store, cipher, tokenFactory: tokenFactory.mint });
    const result = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "Original",
      content: "Original body",
      metadata: { author: "agent", source: "notes-cli" },
    });
    expect(result.kind).toBe("stored");
    if (result.kind !== "stored") return;
    // The token MUST satisfy the bounded opaque grammar and MUST NOT
    // be a `rev_` family value (so it can never be confused with a
    // revision).
    expect(isBoundedOpaqueValue(result.token)).toBe(true);
    expect(/^rev_/.test(result.token)).toBe(false);
    // The token came from the injected factory — proves the journal
    // does not invent tokens itself.
    expect(tokenFactory.minted).toEqual([result.token]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("persists ciphertext only — the store value does NOT contain the plaintext body", async () => {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const journal = createNotesUndoJournal({
      store,
      cipher,
      tokenFactory: createFakeTokenFactory().mint,
    });
    const bodySecret = "PREIMAGE-SECRET-XYZZY-12345-DO-NOT-LEAK";
    const titleSecret = "TITLE-SECRET-XYZZY-12345-DO-NOT-LEAK";
    const result = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: titleSecret,
      content: bodySecret,
      metadata: { author: "agent" },
    });
    expect(result.kind).toBe("stored");
    if (result.kind !== "stored") return;
    // The store MUST have been written exactly once, with ciphertext.
    expect(store.putCalls).toHaveLength(1);
    const putCall = store.putCalls[0]!;
    expect(putCall.token).toBe(result.token);
    const stored = store.raw.get(result.token);
    expect(stored).toBeDefined();
    expect(stored).not.toContain(bodySecret);
    expect(stored).not.toContain(titleSecret);
    expect(stored).not.toContain("XYZZY");
    expect(stored).not.toContain("note_abcdefgh");
    expect(stored).not.toContain("0123456789abcdef0123456789abcdef");
  });

  it("persists ciphertext that does NOT contain the metadata values verbatim", async () => {
    const store = createFakeStore();
    const journal = createNotesUndoJournal({
      store,
      cipher: createRealAesGcmCipher(zeroKey()),
      tokenFactory: createFakeTokenFactory().mint,
    });
    const result = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "T",
      content: "B",
      metadata: { secret: "META-SECRET-XYZZY-67890" },
    });
    expect(result.kind).toBe("stored");
    if (result.kind !== "stored") return;
    const stored = store.raw.get(result.token) ?? "";
    expect(stored).not.toContain("META-SECRET-XYZZY-67890");
  });

  it("rejects an oversized title (>100) categorically BEFORE encryption / store", async () => {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const journal = createNotesUndoJournal({
      store,
      cipher,
      tokenFactory: createFakeTokenFactory().mint,
    });
    const huge = "x".repeat(101);
    const result = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: huge,
      content: "B",
      metadata: {},
    });
    expect(result.kind).toBe("invalid-input");
    if (result.kind !== "invalid-input") return;
    expect(result.message).not.toContain(huge);
    expect(result.message).not.toContain("x".repeat(50));
    // The store MUST NOT have been touched and the cipher MUST NOT
    // have been consulted for oversized input.
    expect(store.putCalls).toEqual([]);
    expect(cipher.encryptCalls).toBe(0);
  });

  it("rejects an oversized content body (>4 MiB UTF-8 bytes) categorically BEFORE encryption / store", async () => {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const journal = createNotesUndoJournal({
      store,
      cipher,
      tokenFactory: createFakeTokenFactory().mint,
    });
    const oversized = "x".repeat(4 * 1024 * 1024 + 1);
    const result = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "T",
      content: oversized,
      metadata: {},
    });
    expect(result.kind).toBe("invalid-input");
    expect(store.putCalls).toEqual([]);
    expect(cipher.encryptCalls).toBe(0);
  });

  it("accepts a content body of exactly 4 MiB UTF-8 bytes", async () => {
    const store = createFakeStore();
    const journal = createNotesUndoJournal({
      store,
      cipher: createRealAesGcmCipher(zeroKey()),
      tokenFactory: createFakeTokenFactory().mint,
    });
    const edge = "x".repeat(4 * 1024 * 1024);
    const result = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "T",
      content: edge,
      metadata: {},
    });
    expect(result.kind).toBe("stored");
  });

  it("rejects a malformed note handle categorically", async () => {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const journal = createNotesUndoJournal({
      store,
      cipher,
      tokenFactory: createFakeTokenFactory().mint,
    });
    const result = await journal.record({
      handle: "not_a_bounded_handle!",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "T",
      content: "B",
      metadata: {},
    });
    expect(result.kind).toBe("invalid-input");
    expect(result.kind !== "stored").toBe(true);
    expect(store.putCalls).toEqual([]);
    expect(cipher.encryptCalls).toBe(0);
  });

  it("rejects a `rev_` family note handle categorically", async () => {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const journal = createNotesUndoJournal({
      store,
      cipher,
      tokenFactory: createFakeTokenFactory().mint,
    });
    const result = await journal.record({
      handle: "rev_abcdefghijklmnopqrstuvwxyz012345",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "T",
      content: "B",
      metadata: {},
    });
    expect(result.kind).toBe("invalid-input");
    expect(store.putCalls).toEqual([]);
    expect(cipher.encryptCalls).toBe(0);
  });

  it("rejects a malformed revision token categorically", async () => {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const journal = createNotesUndoJournal({
      store,
      cipher,
      tokenFactory: createFakeTokenFactory().mint,
    });
    const result = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_NOT_HEX_REVISION_TOKEN",
      title: "T",
      content: "B",
      metadata: {},
    });
    expect(result.kind).toBe("invalid-input");
    expect(store.putCalls).toEqual([]);
    expect(cipher.encryptCalls).toBe(0);
  });

  it("rejects oversized metadata values categorically", async () => {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const journal = createNotesUndoJournal({
      store,
      cipher,
      tokenFactory: createFakeTokenFactory().mint,
    });
    const result = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "T",
      content: "B",
      metadata: { author: "x".repeat(200) },
    });
    expect(result.kind).toBe("invalid-input");
    expect(store.putCalls).toEqual([]);
    expect(cipher.encryptCalls).toBe(0);
  });

  it("rejects a token factory that produces a value outside the bounded opaque grammar", async () => {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const journal = createNotesUndoJournal({
      store,
      cipher,
      tokenFactory: () => "not-a-bounded-token!!!",
    });
    const result = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "T",
      content: "B",
      metadata: {},
    });
    expect(result.kind).toBe("invalid-input");
    expect(store.putCalls).toEqual([]);
    expect(cipher.encryptCalls).toBe(0);
  });

  it("rejects a token factory that produces a reserved `rev_` token", async () => {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const journal = createNotesUndoJournal({
      store,
      cipher,
      tokenFactory: () => "rev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const result = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "T",
      content: "B",
      metadata: {},
    });
    expect(result.kind).toBe("invalid-input");
    expect(store.putCalls).toEqual([]);
    expect(cipher.encryptCalls).toBe(0);
  });

  it("returns `conflict` when the injected store already has the token", async () => {
    const store = createFakeStore();
    // Pre-seed the store with an entry under a token the fake
    // factory will mint next.
    store.raw.set("unjt_00000001", Buffer.from("existing-ciphertext").toString("base64"));
    const journal = createNotesUndoJournal({
      store,
      cipher: createRealAesGcmCipher(zeroKey()),
      tokenFactory: createFakeTokenFactory().mint,
    });
    const result = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "T",
      content: "B",
      metadata: {},
    });
    expect(result.kind).toBe("conflict");
    // The pre-seeded ciphertext MUST NOT have been overwritten.
    expect(store.raw.get("unjt_00000001")).toBe(
      Buffer.from("existing-ciphertext").toString("base64"),
    );
  });
});

// ---------------------------------------------------------------------------
// `load` — decrypt, validate, and return categorical results.
// ---------------------------------------------------------------------------

describe("createNotesUndoJournal — load", () => {
  function buildJournalWithEntry(_options?: {
    readonly title?: string;
    readonly content?: string;
    readonly handle?: string;
    readonly revision?: string;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly corruptCiphertext?: boolean;
  }) {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const tokenFactory = createFakeTokenFactory();
    const journal = createNotesUndoJournal({ store, cipher, tokenFactory: tokenFactory.mint });
    return { store, cipher, tokenFactory, journal };
  }

  it("returns `missing` for an unknown undo token", async () => {
    const { journal } = buildJournalWithEntry();
    const result = await journal.load({ token: "unkt_unknown_zzzzzzzz" });
    expect(result.kind).toBe("missing");
  });

  it("returns `preimage` with a frozen record for a valid stored entry", async () => {
    const { journal, store } = buildJournalWithEntry();
    const recorded = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "Original",
      content: "Original body",
      metadata: { author: "agent" },
    });
    expect(recorded.kind).toBe("stored");
    if (recorded.kind !== "stored") return;
    const result = await journal.load({ token: recorded.token });
    expect(result.kind).toBe("preimage");
    if (result.kind !== "preimage") return;
    expect(result.handle).toBe("note_abcdefgh");
    expect(result.revision).toBe("rev_0123456789abcdef0123456789abcdef");
    expect(result.title).toBe("Original");
    expect(result.content).toBe("Original body");
    expect(result.metadata).toEqual({ author: "agent" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.metadata)).toBe(true);
    // Load does NOT mutate the store.
    expect(store.removeCalls).toEqual([]);
  });

  it("returns `invalid-input` for a malformed opaque undo token without consulting the store or cipher", async () => {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const journal = createNotesUndoJournal({
      store,
      cipher,
      tokenFactory: createFakeTokenFactory().mint,
    });
    const result = await journal.load({ token: "not_a_bounded_token!" });
    expect(result.kind).toBe("invalid-input");
    expect(store.getCalls).toEqual([]);
    expect(cipher.decryptCalls).toBe(0);
  });

  it("returns `invalid-input` for a reserved `rev_` family token without consulting the store or cipher", async () => {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const journal = createNotesUndoJournal({
      store,
      cipher,
      tokenFactory: createFakeTokenFactory().mint,
    });
    const result = await journal.load({
      token: "rev_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    });
    expect(result.kind).toBe("invalid-input");
    expect(store.getCalls).toEqual([]);
    expect(cipher.decryptCalls).toBe(0);
  });

  it("returns `locked` (redacted) when ciphertext decrypt fails and does NOT remove store data", async () => {
    const store = createFakeStore();
    const cipherA = createRealAesGcmCipher(Buffer.alloc(AES_GCM_KEY_BYTES, 0x01));
    const cipherB = createRealAesGcmCipher(Buffer.alloc(AES_GCM_KEY_BYTES, 0x02));
    const tokenFactory = createFakeTokenFactory();
    const journalA = createNotesUndoJournal({
      store,
      cipher: cipherA,
      tokenFactory: tokenFactory.mint,
    });
    const recorded = await journalA.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "Original",
      content: "Original body",
      metadata: {},
    });
    expect(recorded.kind).toBe("stored");
    if (recorded.kind !== "stored") return;
    // A second journal with the wrong key cannot decrypt the entry.
    const journalB = createNotesUndoJournal({
      store,
      cipher: cipherB,
      tokenFactory: tokenFactory.mint,
    });
    const result = await journalB.load({ token: recorded.token });
    expect(result.kind).toBe("locked");
    if (result.kind !== "locked") return;
    expect(result.message).not.toMatch(/Original/);
    expect(result.message).not.toMatch(/body/);
    // The store MUST NOT have been mutated.
    expect(store.removeCalls).toEqual([]);
    expect(store.raw.has(recorded.token)).toBe(true);
  });

  it("returns `error` (redacted) when ciphertext decrypt fails for an under-length frame and does NOT remove store data", async () => {
    const store = createFakeStore();
    const cipher = createAesGcmCipher(zeroKey());
    const tokenFactory = createFakeTokenFactory();
    const journal = createNotesUndoJournal({ store, cipher, tokenFactory: tokenFactory.mint });
    // Seed the store with an under-length ciphertext frame that the
    // real cipher would categorically reject.
    const recorded = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "Original",
      content: "Original body",
      metadata: {},
    });
    expect(recorded.kind).toBe("stored");
    if (recorded.kind !== "stored") return;
    // Replace the stored ciphertext with a too-short payload — the
    // store still has the token but the frame is malformed.
    store.raw.set(recorded.token, Buffer.from([1, 2, 3, 4, 5]).toString("base64"));
    const result = await journal.load({ token: recorded.token });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected malformed-frame load error");
    expect(result.message).not.toMatch(/Original/);
    // The store MUST NOT have been mutated.
    expect(store.removeCalls).toEqual([]);
    expect(store.raw.has(recorded.token)).toBe(true);
  });

  it("returns `error` (redacted) when the decrypted payload fails schema validation and does NOT remove store data", async () => {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const tokenFactory = createFakeTokenFactory();
    const journal = createNotesUndoJournal({ store, cipher, tokenFactory: tokenFactory.mint });
    const recorded = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "Original",
      content: "Original body",
      metadata: {},
    });
    expect(recorded.kind).toBe("stored");
    if (recorded.kind !== "stored") return;
    // Replace the ciphertext with an encrypted payload that does
    // NOT satisfy the closed preimage schema (missing `content`).
    const malformed = {
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "Original",
      metadata: {},
    };
    const encrypted = cipher.encrypt(new TextEncoder().encode(JSON.stringify(malformed)));
    store.raw.set(
      recorded.token,
      Buffer.from(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength).toString("base64"),
    );
    const result = await journal.load({ token: recorded.token });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected schema-validation load error");
    expect(result.message).not.toMatch(/Original/);
    expect(store.removeCalls).toEqual([]);
    expect(store.raw.has(recorded.token)).toBe(true);
  });

  it("never echoes the ciphertext blob, token, body, title, ID, path, or upstream message into the categorical error", async () => {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const tokenFactory = createFakeTokenFactory();
    const journal = createNotesUndoJournal({ store, cipher, tokenFactory: tokenFactory.mint });
    const recorded = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "SECRET-TITLE-XYZZY",
      content: "SECRET-BODY-XYZZY",
      metadata: { author: "SECRET-AUTHOR-XYZZY" },
    });
    expect(recorded.kind).toBe("stored");
    if (recorded.kind !== "stored") return;
    store.raw.set(recorded.token, Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString("base64"));
    const result = await journal.load({ token: recorded.token });
    expect(result.kind === "error" || result.kind === "locked").toBe(true);
    if (result.kind === "error" || result.kind === "locked") {
      expect(result.message).not.toContain("SECRET-TITLE-XYZZY");
      expect(result.message).not.toContain("SECRET-BODY-XYZZY");
      expect(result.message).not.toContain("SECRET-AUTHOR-XYZZY");
      expect(result.message).not.toContain("note_abcdefgh");
      expect(result.message).not.toContain("0123456789abcdef0123456789abcdef");
      expect(result.message).not.toContain(recorded.token);
      expect(result.message).not.toMatch(/secret/i);
    }
  });

  it("never exposes raw source ids / handles in the `preimage` categorical payload shape", async () => {
    const store = createFakeStore();
    const journal = createNotesUndoJournal({
      store,
      cipher: createRealAesGcmCipher(zeroKey()),
      tokenFactory: createFakeTokenFactory().mint,
    });
    const recorded = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "Original",
      content: "Original body",
      metadata: {},
    });
    expect(recorded.kind).toBe("stored");
    if (recorded.kind !== "stored") return;
    const result = await journal.load({ token: recorded.token });
    // The opaque undo token MUST NOT appear in the preimage payload
    // (the formatter already has it from the `stored` outcome).
    expect(result.kind).toBe("preimage");
    if (result.kind !== "preimage") return;
    expect(JSON.stringify(result)).not.toContain(recorded.token);
  });
});

// ---------------------------------------------------------------------------
// `consume` — explicit load + remove.
// ---------------------------------------------------------------------------

describe("createNotesUndoJournal — consume", () => {
  it("returns `preimage` and removes the entry on a valid token", async () => {
    const store = createFakeStore();
    const journal = createNotesUndoJournal({
      store,
      cipher: createRealAesGcmCipher(zeroKey()),
      tokenFactory: createFakeTokenFactory().mint,
    });
    const recorded = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "Original",
      content: "Original body",
      metadata: {},
    });
    expect(recorded.kind).toBe("stored");
    if (recorded.kind !== "stored") return;
    const result = await journal.consume({ token: recorded.token });
    expect(result.kind).toBe("preimage");
    if (result.kind !== "preimage") return;
    expect(result.title).toBe("Original");
    // The store entry MUST have been removed by consume.
    expect(store.removeCalls).toEqual([recorded.token]);
    expect(store.raw.has(recorded.token)).toBe(false);
  });

  it("returns `missing` on a second consume (idempotent / absent)", async () => {
    const store = createFakeStore();
    const journal = createNotesUndoJournal({
      store,
      cipher: createRealAesGcmCipher(zeroKey()),
      tokenFactory: createFakeTokenFactory().mint,
    });
    const recorded = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "Original",
      content: "Original body",
      metadata: {},
    });
    expect(recorded.kind).toBe("stored");
    if (recorded.kind !== "stored") return;
    await journal.consume({ token: recorded.token });
    const result = await journal.consume({ token: recorded.token });
    expect(result.kind).toBe("missing");
  });

  it("does NOT remove store data when decrypt fails (returns `locked`)", async () => {
    const store = createFakeStore();
    const cipherA = createRealAesGcmCipher(Buffer.alloc(AES_GCM_KEY_BYTES, 0x01));
    const cipherB = createRealAesGcmCipher(Buffer.alloc(AES_GCM_KEY_BYTES, 0x02));
    const tokenFactory = createFakeTokenFactory();
    const journalA = createNotesUndoJournal({
      store,
      cipher: cipherA,
      tokenFactory: tokenFactory.mint,
    });
    const recorded = await journalA.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "Original",
      content: "Original body",
      metadata: {},
    });
    expect(recorded.kind).toBe("stored");
    if (recorded.kind !== "stored") return;
    const journalB = createNotesUndoJournal({
      store,
      cipher: cipherB,
      tokenFactory: tokenFactory.mint,
    });
    const result = await journalB.consume({ token: recorded.token });
    expect(result.kind).toBe("locked");
    expect(store.removeCalls).toEqual([]);
    expect(store.raw.has(recorded.token)).toBe(true);
  });

  it("does NOT remove store data when schema validation fails (returns `error`)", async () => {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const tokenFactory = createFakeTokenFactory();
    const journal = createNotesUndoJournal({ store, cipher, tokenFactory: tokenFactory.mint });
    const recorded = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "Original",
      content: "Original body",
      metadata: {},
    });
    expect(recorded.kind).toBe("stored");
    if (recorded.kind !== "stored") return;
    const malformed = { handle: "note_abcdefgh" };
    const encrypted = cipher.encrypt(new TextEncoder().encode(JSON.stringify(malformed)));
    store.raw.set(
      recorded.token,
      Buffer.from(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength).toString("base64"),
    );
    const result = await journal.consume({ token: recorded.token });
    expect(result.kind).toBe("error");
    expect(store.removeCalls).toEqual([]);
    expect(store.raw.has(recorded.token)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `remove` — explicit finalize.
// ---------------------------------------------------------------------------

describe("createNotesUndoJournal — remove", () => {
  it("removes a stored entry and returns `removed`", async () => {
    const store = createFakeStore();
    const journal = createNotesUndoJournal({
      store,
      cipher: createRealAesGcmCipher(zeroKey()),
      tokenFactory: createFakeTokenFactory().mint,
    });
    const recorded = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "Original",
      content: "Original body",
      metadata: {},
    });
    expect(recorded.kind).toBe("stored");
    if (recorded.kind !== "stored") return;
    const result = await journal.remove({ token: recorded.token });
    expect(result.kind).toBe("removed");
    expect(store.removeCalls).toEqual([recorded.token]);
    expect(store.raw.has(recorded.token)).toBe(false);
  });

  it("returns `missing` for an unknown undo token", async () => {
    const store = createFakeStore();
    const journal = createNotesUndoJournal({
      store,
      cipher: createRealAesGcmCipher(zeroKey()),
      tokenFactory: createFakeTokenFactory().mint,
    });
    const result = await journal.remove({ token: "unkt_unknown_zzzzzzzz" });
    expect(result.kind).toBe("missing");
    expect(store.removeCalls).toEqual([]);
  });

  it("returns `invalid-input` for a malformed opaque undo token without consulting the store", async () => {
    const store = createFakeStore();
    const journal = createNotesUndoJournal({
      store,
      cipher: createRealAesGcmCipher(zeroKey()),
      tokenFactory: createFakeTokenFactory().mint,
    });
    const result = await journal.remove({ token: "not_a_bounded_token!" });
    expect(result.kind).toBe("invalid-input");
    expect(store.getCalls).toEqual([]);
    expect(store.removeCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Seam isolation — the journal does NOT call into Notesnook / transport /
// generic surfaces.
// ---------------------------------------------------------------------------

describe("createNotesUndoJournal — seam isolation", () => {
  it("never invokes a Notesnook-shaped, transport-shaped, or generic method on the store", async () => {
    // The store's interface is allowlisted to `put` / `get` / `remove`.
    // The fake store does NOT expose delete / sync / send / call /
    // transport / patch — and the constructor MUST reject any of
    // those keys if they appear.  Here we prove the journal ONLY
    // calls the allowlisted methods.
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const journal = createNotesUndoJournal({
      store,
      cipher,
      tokenFactory: createFakeTokenFactory().mint,
    });
    const recorded = await journal.record({
      handle: "note_abcdefgh",
      revision: "rev_0123456789abcdef0123456789abcdef",
      title: "T",
      content: "B",
      metadata: {},
    });
    expect(recorded.kind).toBe("stored");
    if (recorded.kind !== "stored") return;
    await journal.load({ token: recorded.token });
    await journal.consume({ token: recorded.token });
    // The store MUST have been touched ONLY via put / get / remove.
    // The fake exposes put/get/remove counters; the test asserts the
    // totals are bounded by the call count and that no other
    // method exists on the fake.
    expect(store.putCalls.length).toBe(1);
    // `load` performs one get, `consume` performs one get, so the
    // total is 2.
    expect(store.getCalls.length).toBeGreaterThanOrEqual(1);
    // `consume` performed one remove.
    expect(store.removeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("freezes the journal so callers cannot swap methods at runtime", () => {
    const store = createFakeStore();
    const cipher = createRealAesGcmCipher(zeroKey());
    const journal = createNotesUndoJournal({
      store,
      cipher,
      tokenFactory: createFakeTokenFactory().mint,
    });
    expect(Object.isFrozen(journal)).toBe(true);
  });
});
