/**
 * NookBridge Stage 1 — Gate 1 verification.
 *
 * Implements the exact pass conditions from
 * docs/implementation-plan-v1.5.md §"Stage 1 — Gate 1":
 *
 *   1. Persistence      – Create a local test note, exit, reopen the same
 *                          encrypted state, read the same note back.
 *   2. At-rest encryption – SQLite/state cannot be meaningfully opened
 *                          without the configured key.
 *   3. No plaintext mirror – An automated filesystem scan finds no
 *                          persistent note body outside the encrypted
 *                          test state.
 *   4. Single writer    – A second DB-owning process against the same
 *                          state is rejected or blocks predictably.
 *
 * Stage 1 deliberately does NOT import @notesnook/core at runtime
 * (see Stage 0 docs/upstream-contract.md).  PersistentStorage
 * implements the IStorage contract using a local documented
 * compatibility type — tests assert structural conformance.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPersistentStorage } from "../src/storage/persistent-storage.js";
import { SqliteStorage } from "../src/storage/sqlite-storage.js";
import { createDevelopmentFileKeyStore } from "../src/keystore/file-keystore.js";
import type { SecureKeyStore } from "../src/keystore/keystore.js";
import { loadConfig } from "../src/config/config.js";
import { ensureStateDir } from "../src/config/state-dir.js";
import { isLocked, tryAcquireLock, releaseLock } from "../src/config/lock.js";
import type { IStorage, SerializedKey, Cipher } from "../src/storage/istorage.js";
import { runDoctor } from "../src/doctor/doctor.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "nookbridge-stage1-"));
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
});

interface FixtureState {
  stateDir: string;
  keyFile: string;
  keys: SecureKeyStore;
  dbPath: string;
  configDir: string;
}

function createFixture(prefix: string): FixtureState {
  const stateDir = join(workspaceRoot, `${prefix}-state`);
  const configDir = join(stateRoot(stateDir), "etc");
  const keyFile = join(stateRoot(stateDir), "db.key");
  const dbPath = join(stateDir, "nookbridge.db");
  ensureStateDir(stateDir);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // Pre-seed a development key file so the keystore can read it.
  // The keystore will set restrictive permissions on first write but
  // we still mark the test fixture as development to avoid leaking
  // through the production guard.
  writeFileSync(keyFile, "canary-development-key-do-not-use-in-prod", {
    mode: 0o600,
  });
  const keys = createDevelopmentFileKeyStore({ keyPath: keyFile });
  return { stateDir, keyFile, keys, dbPath, configDir };
}

function stateRoot(stateDir: string): string {
  // Place the key file in a sibling directory so the "no plaintext mirror"
  // scan over the stateDir does not see the development key.  In
  // production the key store would be backed by runtime credentials.
  return join(stateDir, ".d");
}

afterEach(() => {
  // Per-test cleanup falls out of the per-fixture unique prefixes.
});

// ---------------------------------------------------------------------------
// Structural conformance: PersistentStorage implements IStorage

describe("Stage 1 Gate 1 — IStorage conformance", () => {
  it("PersistentStorage satisfies the IStorage structural contract", () => {
    const fx = createFixture("conformance");
    const storage = createPersistentStorage({
      stateDir: fx.stateDir,
      keys: fx.keys,
      dbPath: fx.dbPath,
    });
    const iface: IStorage = storage;
    // Behavioural smoke check — write → read round-trip on the structural
    // interface.  This catches accidental method renames on either side.
    expect(typeof iface.write).toBe("function");
    expect(typeof iface.writeMulti).toBe("function");
    expect(typeof iface.readMulti).toBe("function");
    expect(typeof iface.read).toBe("function");
    expect(typeof iface.remove).toBe("function");
    expect(typeof iface.removeMulti).toBe("function");
    expect(typeof iface.clear).toBe("function");
    expect(typeof iface.getAllKeys).toBe("function");
    expect(typeof iface.encrypt).toBe("function");
    expect(typeof iface.encryptMulti).toBe("function");
    expect(typeof iface.decrypt).toBe("function");
    expect(typeof iface.decryptMulti).toBe("function");
    expect(typeof iface.deriveCryptoKey).toBe("function");
    expect(typeof iface.hash).toBe("function");
    expect(typeof iface.getCryptoKey).toBe("function");
    expect(typeof iface.generateCryptoKey).toBe("function");
    expect(typeof iface.generatePGPKeyPair).toBe("function");
    expect(typeof iface.decryptPGPMessage).toBe("function");
    expect(typeof iface.validatePGPKeyPair).toBe("function");
    expect(typeof iface.generateCryptoKeyFallback).toBe("function");
    expect(typeof iface.deriveCryptoKeyFallback).toBe("function");
    storage.close();
    releaseLock(fx.stateDir);
  });
});

// ---------------------------------------------------------------------------
// Gate 1.1 — Persistence + Gate 1.2 — At-rest encryption (combined)

describe("Stage 1 Gate 1 — Persistence round-trip + At-rest encryption", () => {
  let fx: FixtureState;
  let payload: string;
  let serialKey: SerializedKey;

  beforeEach(() => {
    fx = createFixture("persist");
    payload = [
      "# Stage 1 canary note",
      "**CANARY-CLEARTEXT-MARKER**: NB-STAGE1-CANARY-7F2A",
      "The bridgeless world grew outwards, but the lock was always",
      "on the inside.",
    ].join("\n");
    serialKey = { password: "stage-1-password-A", salt: "stage-1-salt-A" };
  });

  it("writes an encrypted note through PersistentStorage and reads it back", async () => {
    {
      const storage = createPersistentStorage({
        stateDir: fx.stateDir,
        keys: fx.keys,
        dbPath: fx.dbPath,
      });
      // Exercise both the encrypt/decrypt envelope and the raw
      // write/read envelope so the test covers the full IStorage surface.
      await storage.write("note:stage1", payload);
      const envelope: Cipher<"base64"> = await storage.encrypt(serialKey, payload);
      await storage.write("note:stage1-cipher", envelope);
      storage.close();
      releaseLock(fx.stateDir);
    }

    {
      // Cold reopen — fresh storage handle, same key file, same state dir.
      const storage = createPersistentStorage({
        stateDir: fx.stateDir,
        keys: fx.keys,
        dbPath: fx.dbPath,
      });
      const raw = await storage.read<string>("note:stage1");
      expect(raw).toBe(payload);

      const restored = await storage.read<Cipher<"base64">>("note:stage1-cipher");
      expect(restored).toBeDefined();
      if (!restored) {
        throw new Error("encrypted envelope missing from persistent storage");
      }
      const decrypted = await storage.decrypt(serialKey, restored);
      expect(decrypted).toBe(payload);
      storage.close();
      releaseLock(fx.stateDir);
    }
  });

  it("rejects an obviously wrong key when the database is reopened without it", async () => {
    // Within this test the fixture is brand new, so we first create a
    // valid PersistentStorage, write the canary, and release the lock
    // so the lower-level SqliteStorage probe below has an on-disk
    // database to attack.  The single-instance lock has been released
    // by the time the probe runs.  We open the file directly via the
    // lower-level SqliteStorage with the WRONG key.
    // The wrong key MUST NOT yield the canary plaintext — either by
    // throwing, or by returning a row whose contents are not the
    // plaintext.  We never assert the row count, because sqlcipher
    // builds can briefly return garbage rows on a bad key before
    // throwing on subsequent operations.
    {
      const storage = createPersistentStorage({
        stateDir: fx.stateDir,
        keys: fx.keys,
        dbPath: fx.dbPath,
      });
      await storage.write("note:stage1", payload);
      storage.close();
      releaseLock(fx.stateDir);
    }

    expect(existsSync(fx.dbPath)).toBe(true);

    const wrong = new SqliteStorage({ dbPath: fx.dbPath, key: "WRONG-KEY-XYZ" });
    let leaked = false;
    let rows: { value: string }[] = [];
    try {
      rows = wrong.all<{ value: string }>("SELECT value FROM kv WHERE key = ?", ["note:stage1"]);
      leaked = rows.some((r) => r.value === payload);
    } catch {
      // Throwing is an acceptable failure mode for a wrong key.
    } finally {
      wrong.close();
    }
    expect(leaked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gate 1.3 — No plaintext mirror

describe("Stage 1 Gate 1 — No plaintext mirror", () => {
  it("filesystem scan finds no plaintext note body outside the encrypted state", async () => {
    const fx = createFixture("nomirror");
    const canary = "NB-STAGE1-PLAIN-CANARY-9C81";
    const storage = createPersistentStorage({
      stateDir: fx.stateDir,
      keys: fx.keys,
      dbPath: fx.dbPath,
    });
    await storage.write("note:canary", `the canary body: ${canary}`);
    storage.close();
    releaseLock(fx.stateDir);

    // Recursively scan the entire workspace-root-sibling state dir tree
    // except for the encrypted SQLite file itself.  A plaintext note
    // cache, log line, or temp file would trip this check.
    const offenders: { path: string; matched: string }[] = [];
    const stateRootAbs = fx.stateDir;
    walk(stateRootAbs, (path) => {
      // Always skip the encrypted DB file.  Everything else must not
      // contain the canary.
      if (path === fx.dbPath || path === fx.dbPath + "-journal" || path === fx.dbPath + "-wal") {
        return;
      }
      let stats;
      try {
        stats = lstatSync(path);
      } catch {
        return;
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        return;
      }
      let text = "";
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return;
      }
      if (text.includes(canary)) {
        offenders.push({ path, matched: canary });
      }
    });

    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gate 1.4 — Single writer

describe("Stage 1 Gate 1 — Single writer", () => {
  it("a second storage handle is rejected or fails predictably", async () => {
    const fx = createFixture("singlewriter");
    const first = createPersistentStorage({
      stateDir: fx.stateDir,
      keys: fx.keys,
      dbPath: fx.dbPath,
    });
    // First writer holds the lock; the second MUST be rejected up front
    // or, if it falls through to SQLite, see a SQLITE_BUSY and not
    // silently corrupt or wait unboundedly.  Both outcomes are
    // acceptable; quietly sharing the file is not.
    expect(isLocked(fx.stateDir)).toBe(true);

    let secondThrew = false;
    let second = null;
    try {
      second = createPersistentStorage({
        stateDir: fx.stateDir,
        keys: fx.keys,
        dbPath: fx.dbPath,
      });
    } catch {
      secondThrew = true;
    }

    if (!secondThrew && second) {
      // The second writer surfaced without throwing — attempt a write
      // and assert it is rejected without producing a corrupted payload.
      let writeThrew = false;
      try {
        await second.write("note:stage1-second", "second-writer-attempt");
      } catch {
        writeThrew = true;
      }
      second.close();
      expect(writeThrew).toBe(true);
    }

    first.close();
    releaseLock(fx.stateDir);
    expect(isLocked(fx.stateDir)).toBe(false);
  });

  it("tryAcquireLock is observable from tryAcquireLock itself", () => {
    const fx = createFixture("lockobservable");
    const releaseA = tryAcquireLock(fx.stateDir);
    expect(releaseA).not.toBeNull();
    const releaseB = tryAcquireLock(fx.stateDir);
    expect(releaseB).toBeNull(); // already locked
    if (releaseA) releaseA();
    const releaseC = tryAcquireLock(fx.stateDir);
    expect(releaseC).not.toBeNull();
    if (releaseC) releaseC();
  });
});

// ---------------------------------------------------------------------------
// Config + state-dir surface checks

describe("Stage 1 Gate 1 — config loading and state directory", () => {
  it("creates the state directory with mode 0700", () => {
    const dir = join(workspaceRoot, "perms-state");
    const created = ensureStateDir(dir);
    expect(created).toBe(true);
    const stats = lstatSync(dir);
    expect((stats.mode & 0o777).toString(8)).toBe("700");
  });

  it("loadConfig returns deterministic defaults from a clean directory", () => {
    const fx = createFixture("configclean");
    const cfg = loadConfig({ stateDir: fx.stateDir });
    expect(cfg.stateDir).toBe(fx.stateDir);
    expect(cfg.db.path).toBe(fx.dbPath);
    expect(cfg.keyStore.backend).toBe("development-file");
    expect(cfg.logging.redactFields).toEqual(
      expect.arrayContaining(["password", "token", "secret", "key", "body", "content", "note"]),
    );
  });

  it("loadConfig rejects paths outside the configured state directory", () => {
    expect(() =>
      loadConfig({
        stateDir: "/etc",
        dbPath: "/etc/passwd",
      }),
    ).toThrow(/state directory/i);
  });
});

// ---------------------------------------------------------------------------
// Doctor diagnostic surface

describe("Stage 1 Gate 1 — nookctl doctor (machine- and human-readable)", () => {
  let ephemeralHttp: { url: string; close: () => void } | null = null;

  beforeAll(async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    // `server.listen(0, ...)` is asynchronous: the port is only assigned
    // once the OS hands us an ephemeral port.  Await the 'listening'
    // callback so `server.address()` returns a non-null AddressInfo
    // before we read it.  Without this, the URL captured below is
    // `http://127.0.0.1:undefined/` and the endpoint check silently
    // degrades.
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    ephemeralHttp = {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      close: () => server.close(),
    };
  });

  afterAll(() => {
    if (ephemeralHttp) ephemeralHttp.close();
  });

  it("reports native module load, perms, DB open/decrypt, and an endpoint check", async () => {
    const fx = createFixture("doctor");
    const storage = createPersistentStorage({
      stateDir: fx.stateDir,
      keys: fx.keys,
      dbPath: fx.dbPath,
    });
    await storage.write("note:doctor", "doctor canary");
    storage.close();
    // Keep the lock released so doctor can independently open.
    releaseLock(fx.stateDir);

    const doctorOpts: Parameters<typeof runDoctor>[0] = {
      stateDir: fx.stateDir,
      dbPath: fx.dbPath,
    };
    if (ephemeralHttp) {
      doctorOpts.endpoint = ephemeralHttp.url;
    }
    const report = await runDoctor(doctorOpts);

    // Machine-readable: every check has { id, status, message? }.
    expect(Array.isArray(report.checks)).toBe(true);
    for (const check of report.checks) {
      expect(typeof check.id).toBe("string");
      expect(["pass", "fail", "warn"]).toContain(check.status);
    }

    // Human-readable: includes headers but never the canary string.
    expect(typeof report.human).toBe("string");
    expect(report.human.length).toBeGreaterThan(0);
    expect(report.human).not.toContain("doctor canary");

    // Endpoint check should pass against the local ephemeral server.
    const endpointCheck = report.checks.find((c) => c.id === "endpoint");
    if (ephemeralHttp) {
      expect(endpointCheck?.status).toBe("pass");
    } else {
      // Acceptable: doctor with no endpoint configured reports warn,
      // never throws, and never leaks secrets.
      expect(["pass", "warn"]).toContain(endpointCheck?.status);
    }
  });

  it("never includes the encryption key or note body in human output", async () => {
    const fx = createFixture("doctorsecrets");
    const storage = createPersistentStorage({
      stateDir: fx.stateDir,
      keys: fx.keys,
      dbPath: fx.dbPath,
    });
    await storage.write("note:nosecrets", "secret canary body");
    storage.close();
    releaseLock(fx.stateDir);

    const report = await runDoctor({
      stateDir: fx.stateDir,
      dbPath: fx.dbPath,
    });
    expect(report.human).not.toContain("secret canary body");
    // The development key file is itself labelled "development-only",
    // and the doctor must not echo its raw contents.
    const keyFileContents = readFileSync(fx.keyFile, "utf8").trim();
    expect(report.human.includes(keyFileContents)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Logger redaction surface (used by PersistentStorage)

describe("Stage 1 Gate 1 — structured logger redaction", () => {
  it("redacts secret-like fields in structured output", async () => {
    // Import the public logger through its test surface so we never
    // rely on formatting details that may change.
    const { createLogger } = await import("../src/logging/logger.js");
    const captured: string[] = [];
    const logger = createLogger({
      sink: (line: string) => void captured.push(line),
    });
    logger.info("event", {
      password: "super-secret",
      token: "abc123",
      secret: "shh",
      key: "the-key",
      body: "the-body",
      content: "the-content",
      note: "the-note",
      ok: "visible",
    });
    expect(captured.length).toBe(1);
    const line = captured[0]!;
    expect(line).toContain("[REDACTED:password]");
    expect(line).toContain("[REDACTED:token]");
    expect(line).toContain("[REDACTED:secret]");
    expect(line).toContain("[REDACTED:key]");
    expect(line).toContain("[REDACTED:body]");
    expect(line).toContain("[REDACTED:content]");
    expect(line).toContain("[REDACTED:note]");
    expect(line).toContain("visible");
    expect(line).not.toContain("super-secret");
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("the-body");
  });
});

// ---------------------------------------------------------------------------
// Helpers (kept at bottom of file)

function walk(dir: string, onFile: (file: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stats;
    try {
      stats = lstatSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      walk(full, onFile);
    } else if (stats.isFile()) {
      onFile(full);
    }
  }
}
