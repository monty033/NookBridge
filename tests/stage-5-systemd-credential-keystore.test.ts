/**
 * Stage 5 Task 2 — systemd `LoadCredential=` SecureKeyStore backend.
 *
 * This suite is written first (RED), exercises the planned public contract,
 * and is paired with `src/keystore/systemd-credential-keystore.ts`. The
 * backend is the production-safe key source identified in the Stage 5
 * service-boundary decision record: systemd `LoadCredential=` delivers a
 * service-private file under `$CREDENTIALS_DIRECTORY`, the daemon reads
 * it once at construction, caches the bytes verbatim, and never logs,
 * writes, mutates, or otherwise touches the filesystem afterwards.
 *
 * Tests deliberately avoid live systemd, live credentials, the project
 * `var/` directory, real keys, or the actual public credential label.
 * Everything lives in disposable temp directories populated with
 * harmless generated test strings.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Precise test seams for the production safe-reader calls.
 *
 * The source opens a file descriptor, then calls `fstatSync(fd)` and
 * `readSync(fd, ...)`.  These wrappers delegate to the real implementations
 * by default; individual bounded-read tests override one call to model a
 * stale opened-fd size or a short read without touching anything outside a
 * disposable temp directory.
 */
import type * as NodeFs from "node:fs";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof NodeFs>("node:fs");
  return {
    ...actual,
    fstatSync: vi.fn(actual.fstatSync),
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
  };
});

import * as fsMocked from "node:fs";

import { createSystemdCredentialKeyStore } from "../src/keystore/systemd-credential-keystore.js";
import type { SecureKeyStore } from "../src/keystore/keystore.js";

/**
 * Harmless generated test key string. Never a real key — a fixed test
 * constant so assertions are deterministic.
 */
const HARMLESS_TEST_KEY = "test-stage5-harmless-fixture-key-do-not-use";

/**
 * Public credential label the deployment will use. The factory must
 * accept this label verbatim and never expose a caller-controlled
 * full credential path.
 */
const PUBLIC_CREDENTIAL_LABEL = "nookbridge-db-key" as const;

/**
 * Public bounded max credential size. Chosen to be large enough for
 * any plausible base64 or hex key the deployment would inject (a
 * 256-byte key would be unusually large), small enough that a leaked
 * oversized source is rejected before it can allocate gigabytes.
 *
 * Value name: SYSTEMD_CREDENTIAL_MAX_BYTES — see the implementation
 * for the exact constant.
 */
const SYSTEMD_CREDENTIAL_MAX_BYTES = 1024;

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "nookbridge-stage5-cred-"));
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
});

/**
 * Build a fresh disposable credential directory and return it together
 * with helpers that capture a snapshot of the directory for later
 * mutation-proof assertions.
 */
function makeCredDir(label: string): {
  credentialsDirectory: string;
  /** A baseline snapshot of directory entries + per-file metadata. */
  snapshot(): {
    entries: readonly string[];
    files: ReadonlyMap<string, { size: number; mode: number; type: string }>;
  };
} {
  const credentialsDirectory: string =
    mkdirSync(join(workspaceRoot, `${label}-${randomBytes(4).toString("hex")}`), {
      recursive: true,
      mode: 0o700,
    }) ?? join(workspaceRoot, `${label}-${randomBytes(4).toString("hex")}`);
  const snapshot = (): {
    entries: readonly string[];
    files: ReadonlyMap<string, { size: number; mode: number; type: string }>;
  } => {
    const entries = readdirSync(credentialsDirectory);
    const files = new Map<string, { size: number; mode: number; type: string }>();
    for (const entry of entries) {
      const full = join(credentialsDirectory, entry);
      const st = lstatSync(full);
      files.set(entry, {
        size: st.size,
        mode: st.mode & 0o7777,
        type: entryTypeName(st),
      });
    }
    return { entries: [...entries].sort(), files };
  };
  return { credentialsDirectory, snapshot };
}

function entryTypeName(st: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}): string {
  if (st.isFile()) return "file";
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "directory";
  return "other";
}

describe("Stage 5 systemd-credential SecureKeyStore", () => {
  describe("public factory surface", () => {
    it("exposes the production-safe backend id with a literal productionSafe: true", () => {
      const dir = makeCredDir("factory-shape");
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), HARMLESS_TEST_KEY, {
        mode: 0o600,
      });
      const store = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });

      expect(store.backend).toBe("systemd-credential");
      // The discriminated contract: ONLY the systemd-credential backend
      // may carry literal productionSafe: true.  This assertion also
      // pins the runtime value, not just the static type.
      expect(store.productionSafe).toBe(true);

      // No extra method names leak onto the store.
      expect(Object.keys(store).sort()).toEqual(["backend", "getDatabaseKey", "productionSafe"]);
    });

    it("exports the factory and option type from the public entry point", async () => {
      const index = await import("../src/index.js");
      expect(typeof index.createSystemdCredentialKeyStore).toBe("function");
      // The factory is callable from the public surface without any
      // private filesystem path being exposed.
      const dir = makeCredDir("index-export");
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), HARMLESS_TEST_KEY, {
        mode: 0o600,
      });
      const store = index.createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });
      expect(store.backend).toBe("systemd-credential");
      expect(store.productionSafe).toBe(true);
      expect(store.getDatabaseKey()).toBe(HARMLESS_TEST_KEY);
    });
  });

  describe("credential name validation", () => {
    it("rejects names that contain path separators", () => {
      const dir = makeCredDir("separator-name");
      const result = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
        credentialName: `subdir/${PUBLIC_CREDENTIAL_LABEL}`,
      });
      expect(result.backend).toBe("systemd-credential");
      expect(result.productionSafe).toBe(true);
      expect(result.getDatabaseKey()).toBeUndefined();
    });

    it("rejects names that contain parent-directory traversal", () => {
      const dir = makeCredDir("traversal-name");
      const result = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
        credentialName: `../${PUBLIC_CREDENTIAL_LABEL}`,
      });
      expect(result.getDatabaseKey()).toBeUndefined();
    });

    it("rejects absolute names", () => {
      const dir = makeCredDir("absolute-name");
      const result = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
        credentialName: `/etc/${PUBLIC_CREDENTIAL_LABEL}`,
      });
      expect(result.getDatabaseKey()).toBeUndefined();
    });

    it("rejects empty or whitespace-only names", () => {
      const dir = makeCredDir("empty-name");
      const result = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
        credentialName: "   ",
      });
      expect(result.getDatabaseKey()).toBeUndefined();
    });

    it("accepts a configurable name that is a plain credential filename", () => {
      const dir = makeCredDir("custom-name");
      const custom = "alternate-db-key-1";
      writeFileSync(join(dir.credentialsDirectory, custom), HARMLESS_TEST_KEY, { mode: 0o600 });
      const store = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
        credentialName: custom,
      });
      expect(store.backend).toBe("systemd-credential");
      expect(store.productionSafe).toBe(true);
      expect(store.getDatabaseKey()).toBe(HARMLESS_TEST_KEY);
    });

    it("never accepts a caller-controlled full credential path", () => {
      // Even if the caller asks the factory to use a specific path,
      // the factory must compose dir + validated name itself; passing
      // a full path through credentialName is rejected.
      const dir = makeCredDir("full-path");
      const outside = makeCredDir("full-path-outside");
      writeFileSync(
        join(outside.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL),
        "should-not-be-read",
        { mode: 0o600 },
      );
      const result = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
        // contains a separator → rejected by the validator above.
        credentialName: `${outside.credentialsDirectory}/${PUBLIC_CREDENTIAL_LABEL}`,
      });
      expect(result.getDatabaseKey()).toBeUndefined();
    });
  });

  describe("credential source refusal", () => {
    it("returns undefined when the credential file is missing", () => {
      const dir = makeCredDir("missing");
      const store = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });
      expect(store.backend).toBe("systemd-credential");
      expect(store.productionSafe).toBe(true);
      expect(store.getDatabaseKey()).toBeUndefined();
    });

    it("returns undefined when the credential file is empty", () => {
      const dir = makeCredDir("empty");
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), "", { mode: 0o600 });
      const store = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });
      expect(store.getDatabaseKey()).toBeUndefined();
    });

    it("returns undefined when the credential file is whitespace-only", () => {
      const dir = makeCredDir("whitespace");
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), "   \n\t  ", {
        mode: 0o600,
      });
      const store = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });
      expect(store.getDatabaseKey()).toBeUndefined();
    });

    it("returns undefined when the credential file exceeds the bounded max size", () => {
      const dir = makeCredDir("oversized");
      const oversized = "x".repeat(SYSTEMD_CREDENTIAL_MAX_BYTES + 1);
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), oversized, {
        mode: 0o600,
      });
      const store = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });
      expect(store.getDatabaseKey()).toBeUndefined();
    });

    it("treats a directory at the credential path as non-regular and rejects it", () => {
      const dir = makeCredDir("directory-source");
      mkdirSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), {
        mode: 0o700,
      });
      const store = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });
      expect(store.getDatabaseKey()).toBeUndefined();
    });

    it("treats a symlink at the credential path as non-regular and rejects it", () => {
      const dir = makeCredDir("symlink-source");
      const target = join(dir.credentialsDirectory, "target.bin");
      writeFileSync(target, "target-bytes", { mode: 0o600 });
      symlinkSync(target, join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL));
      const store = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });
      expect(store.getDatabaseKey()).toBeUndefined();
    });

    it("does not throw raw filesystem or parser errors for malformed inputs", () => {
      const dir = makeCredDir("malformed");
      // No setup at all — caller cannot reach raw error paths because
      // the factory must convert every refusal to undefined.
      expect(() =>
        createSystemdCredentialKeyStore({
          credentialsDirectory: dir.credentialsDirectory,
        }),
      ).not.toThrow();
    });
  });

  describe("successful cached read", () => {
    it("reads the credential once at construction and returns the cached bytes", () => {
      const dir = makeCredDir("happy-path");
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), HARMLESS_TEST_KEY, {
        mode: 0o600,
      });

      const store = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });
      // First call — the factory reads once here.
      expect(store.getDatabaseKey()).toBe(HARMLESS_TEST_KEY);
      // Second call — must NOT re-open the file.
      expect(store.getDatabaseKey()).toBe(HARMLESS_TEST_KEY);
      // Third call — same.
      expect(store.getDatabaseKey()).toBe(HARMLESS_TEST_KEY);
    });

    it("trims a trailing newline that systemd credentials commonly carry", () => {
      const dir = makeCredDir("trailing-newline");
      writeFileSync(
        join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL),
        `${HARMLESS_TEST_KEY}\n`,
        { mode: 0o600 },
      );
      const store = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });
      expect(store.getDatabaseKey()).toBe(HARMLESS_TEST_KEY);
    });

    it("never logs the key material to any sink the caller provides", () => {
      // The factory takes no logger argument and never returns a logger
      // seam; the only way the daemon can capture key bytes is through
      // an out-of-band sink such as console.* / process.stdout /
      // process.stderr.  Assert by snapshotting those sinks, invoking
      // the factory, and confirming neither the canary key nor the
      // source path appear in any captured output.
      const dir = makeCredDir("no-log");
      const canary = `log-canary-${randomBytes(8).toString("hex")}`;
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), canary, {
        mode: 0o600,
      });

      const captured: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      const originalErr = process.stderr.write.bind(process.stderr);
      const capture = (chunk: string | Uint8Array, ..._args: unknown[]): boolean => {
        captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      };
      process.stdout.write = capture as unknown as typeof process.stdout.write;
      process.stderr.write = capture as unknown as typeof process.stderr.write;

      try {
        const store = createSystemdCredentialKeyStore({
          credentialsDirectory: dir.credentialsDirectory,
        });
        const got = store.getDatabaseKey();
        expect(got).toBe(canary);
      } finally {
        process.stdout.write = originalWrite;
        process.stderr.write = originalErr;
      }

      const combined = captured.join("");
      expect(combined.includes(canary)).toBe(false);
      // The source path must not appear in any captured line.
      expect(combined.includes(dir.credentialsDirectory)).toBe(false);
    });
  });

  describe("no creation / no mutation", () => {
    it("never creates, writes, copies, chmods, or otherwise mutates the credential directory", () => {
      const dir = makeCredDir("no-mutation");
      // Pre-seed a credential so the happy path is exercised.
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), HARMLESS_TEST_KEY, {
        mode: 0o600,
      });

      const before = dir.snapshot();

      // Construct + read multiple times.
      const store = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });
      expect(store.getDatabaseKey()).toBe(HARMLESS_TEST_KEY);
      expect(store.getDatabaseKey()).toBe(HARMLESS_TEST_KEY);
      expect(store.getDatabaseKey()).toBeDefined();

      const after = dir.snapshot();

      // 1. Directory entries are unchanged.
      expect(after.entries).toEqual(before.entries);
      // 2. Per-file metadata (size, mode, type) is unchanged.
      expect(after.files.size).toBe(before.files.size);
      for (const [name, meta] of before.files) {
        expect(after.files.get(name)).toEqual(meta);
      }
    });

    it("never mutates the filesystem when the credential is missing", () => {
      const dir = makeCredDir("no-mutation-missing");
      const before = dir.snapshot();

      const store = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });
      expect(store.getDatabaseKey()).toBeUndefined();

      const after = dir.snapshot();
      expect(after.entries).toEqual(before.entries);
    });

    it("never creates the public credential file as a side effect of construction", () => {
      const dir = makeCredDir("no-create");

      const before = dir.snapshot();
      const _store: SecureKeyStore = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });

      const after = dir.snapshot();
      expect(after.entries).toEqual(before.entries);
      // The public label must NOT appear.
      expect(after.entries).not.toContain(PUBLIC_CREDENTIAL_LABEL);
    });
  });

  describe("type-level production-safe discrimination", () => {
    it("only the systemd-credential variant may carry productionSafe: true (type-level)", () => {
      // This block is a compile-time-only test.  It does not run any
      // filesystem work; it pins the discriminated contract through
      // assignment compatibility checks that the typechecker enforces.
      const dev: SecureKeyStore = {
        backend: "development-file",
        productionSafe: false,
        getDatabaseKey: () => undefined,
      };
      const sysd: SecureKeyStore = {
        backend: "systemd-credential",
        productionSafe: true,
        getDatabaseKey: () => undefined,
      };
      const none: SecureKeyStore = {
        backend: "none",
        productionSafe: false,
        getDatabaseKey: () => undefined,
      };

      // Switch on the discriminated backend tag and assert the
      // productionSafe value per variant at runtime.
      const tagOf = (s: SecureKeyStore): boolean => {
        switch (s.backend) {
          case "development-file":
            return s.productionSafe === false;
          case "systemd-credential":
            return s.productionSafe === true;
          case "none":
            return s.productionSafe === false;
        }
      };
      expect(tagOf(dev)).toBe(true);
      expect(tagOf(sysd)).toBe(true);
      expect(tagOf(none)).toBe(true);
    });
  });

  /**
   * Fix #4 — hardened runtime options validation.
   *
   * The factory MUST never throw, MUST always return a production-safe
   * `systemd-credential` store, and MUST surface a categorical
   * `undefined` from `getDatabaseKey()` for every malformed input the
   * caller can possibly hand in.  The contract is exhaustive: any
   * untrusted shape must be normalized into the same safe refusal path
   * as a missing credential file.  Reading untrusted option properties
   * is wrapped in a single categorical try/catch so a hostile getter,
   * a revoked proxy, or a `Symbol.toPrimitive` trap cannot leak a raw
   * `TypeError` to the daemon's startup path.
   */
  describe("hardened runtime options validation", () => {
    it("returns a production-safe store with undefined key when options is undefined", () => {
      // Cast around the type so the runtime surface is exercised.
      const result = createSystemdCredentialKeyStore(
        undefined as unknown as Parameters<typeof createSystemdCredentialKeyStore>[0],
      );
      expect(result.backend).toBe("systemd-credential");
      expect(result.productionSafe).toBe(true);
      expect(result.getDatabaseKey()).toBeUndefined();
    });

    it("returns a production-safe store with undefined key when options is null", () => {
      const result = createSystemdCredentialKeyStore(
        null as unknown as Parameters<typeof createSystemdCredentialKeyStore>[0],
      );
      expect(result.backend).toBe("systemd-credential");
      expect(result.productionSafe).toBe(true);
      expect(result.getDatabaseKey()).toBeUndefined();
    });

    it("returns a production-safe store with undefined key when options is a non-object primitive", () => {
      // Booleans, numbers, bigints, strings are not valid option bags.
      for (const primitive of [true, false, 0, 1, "", "nookbridge"]) {
        const result = createSystemdCredentialKeyStore(
          primitive as unknown as Parameters<typeof createSystemdCredentialKeyStore>[0],
        );
        expect(result.backend).toBe("systemd-credential");
        expect(result.productionSafe).toBe(true);
        expect(result.getDatabaseKey()).toBeUndefined();
      }
    });

    it("returns a production-safe store with undefined key when credentialsDirectory is missing", () => {
      const result = createSystemdCredentialKeyStore(
        {} as unknown as Parameters<typeof createSystemdCredentialKeyStore>[0],
      );
      expect(result.backend).toBe("systemd-credential");
      expect(result.productionSafe).toBe(true);
      expect(result.getDatabaseKey()).toBeUndefined();
    });

    it("returns a production-safe store with undefined key when credentialsDirectory is not a string", () => {
      const dir = makeCredDir("opts-cd-bad-type");
      for (const bad of [
        42,
        true,
        false,
        null,
        undefined,
        ["x"],
        { toString: () => dir.credentialsDirectory },
        Symbol("nope"),
      ]) {
        const result = createSystemdCredentialKeyStore({
          credentialsDirectory: bad as unknown as string,
        });
        expect(result.backend).toBe("systemd-credential");
        expect(result.productionSafe).toBe(true);
        expect(result.getDatabaseKey()).toBeUndefined();
      }
    });

    it("returns a production-safe store with undefined key when credentialName is not a string", () => {
      const dir = makeCredDir("opts-name-bad-type");
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), HARMLESS_TEST_KEY, {
        mode: 0o600,
      });
      for (const bad of [42, true, false, null, {}, []]) {
        const result = createSystemdCredentialKeyStore({
          credentialsDirectory: dir.credentialsDirectory,
          credentialName: bad as unknown as string,
        });
        expect(result.backend).toBe("systemd-credential");
        expect(result.productionSafe).toBe(true);
        expect(result.getDatabaseKey()).toBeUndefined();
      }
    });

    it("does not throw when options exposes a getter that throws on access", () => {
      const hostile: Record<string, unknown> = {};
      Object.defineProperty(hostile, "credentialsDirectory", {
        enumerable: true,
        get: () => {
          throw new Error("hostile getter tripped");
        },
      });
      let result: ReturnType<typeof createSystemdCredentialKeyStore> | undefined;
      expect(() => {
        result = createSystemdCredentialKeyStore(
          hostile as unknown as Parameters<typeof createSystemdCredentialKeyStore>[0],
        );
      }).not.toThrow();
      expect(result?.backend).toBe("systemd-credential");
      expect(result?.productionSafe).toBe(true);
      expect(result?.getDatabaseKey()).toBeUndefined();
    });

    it("never throws for any malformed-options shape", () => {
      const dir = makeCredDir("opts-no-throw");
      // Exhaustive sweep: every option shape the contract commits to
      // accepting must complete without surfacing a raw TypeError.
      const variants: ReadonlyArray<unknown> = [
        undefined,
        null,
        0,
        1,
        true,
        false,
        "",
        "nookbridge",
        {},
        { credentialsDirectory: dir.credentialsDirectory },
        { credentialsDirectory: dir.credentialsDirectory, credentialName: 42 },
        { credentialsDirectory: 42 },
        { credentialsDirectory: null },
        { credentialsDirectory: {} },
        {
          credentialsDirectory: dir.credentialsDirectory,
          credentialName: {
            toString: () => {
              throw new Error("toString trap");
            },
          },
        },
      ];
      for (const variant of variants) {
        expect(() =>
          createSystemdCredentialKeyStore(
            variant as unknown as Parameters<typeof createSystemdCredentialKeyStore>[0],
          ),
        ).not.toThrow();
      }
    });
  });

  describe("credentialsDirectory validation", () => {
    it("rejects empty and relative directories before attempting to open a credential", () => {
      const openSpy = vi.mocked(fsMocked.openSync);
      for (const credentialsDirectory of ["", "relative", "../relative"]) {
        openSpy.mockClear();
        const result = createSystemdCredentialKeyStore({
          credentialsDirectory,
        });
        expect(result.getDatabaseKey()).toBeUndefined();
        expect(openSpy).not.toHaveBeenCalled();
      }
    });

    it("reads a stateful credentialsDirectory getter exactly once and uses its captured value", () => {
      const dir = makeCredDir("stateful-directory");
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), HARMLESS_TEST_KEY, {
        mode: 0o600,
      });
      let reads = 0;
      const options = {
        get credentialsDirectory(): string {
          reads += 1;
          return reads === 1 ? dir.credentialsDirectory : "relative-after-first-read";
        },
      };

      const result = createSystemdCredentialKeyStore(options);

      expect(reads).toBe(1);
      expect(result.getDatabaseKey()).toBe(HARMLESS_TEST_KEY);
    });

    it("rejects a NUL credentialName before attempting to open a credential", () => {
      const dir = makeCredDir("nul-name");
      const openSpy = vi.mocked(fsMocked.openSync);
      openSpy.mockClear();

      const result = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
        credentialName: `credential\0name`,
      });

      expect(result.getDatabaseKey()).toBeUndefined();
      expect(openSpy).not.toHaveBeenCalled();
    });
  });

  /**
   * Fix #3 — safe reader bounded-read contract.
   *
   * The hardened reader MUST:
   *
   *   1. open the credential path with `O_RDONLY | O_NOFOLLOW` (Linux);
   *   2. fstat the OPEN fd — `lstatSync` is not consulted;
   *   3. reject non-regular, missing, or oversized sources;
   *   4. allocate no more than `SYSTEMD_CREDENTIAL_MAX_BYTES` for the
   *      read buffer;
   *   5. reject any read whose byte count differs from the opened fd's
   *      `fstatSync` size, including short reads and growth within the bound;
   *   6. retain the one-byte EOF probe for an exact-MAX read;
   *   7. close the fd in `finally`;
   *   8. never throw.
   */
  describe("safe reader bounded-read contract", () => {
    function withFakedFstatSize(fakeSize: number, body: () => void): void {
      const fstatSpy = vi.mocked(fsMocked.fstatSync);
      const realFstat = fstatSpy.getMockImplementation();
      if (!realFstat) throw new Error("fstatSync test seam is not configured");

      fstatSpy.mockImplementationOnce((fd) => {
        const real = realFstat(fd);
        const fake = Object.create(real) as fsMocked.Stats;
        Object.defineProperty(fake, "size", { value: fakeSize });
        return fake;
      });
      body();
    }

    function withShortRead(body: () => void): void {
      type PositionalReadSync = (
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null,
      ) => number;
      const readSpy = fsMocked.readSync as unknown as {
        getMockImplementation: () => PositionalReadSync | undefined;
        mockImplementationOnce: (implementation: PositionalReadSync) => void;
      };
      const realRead = readSpy.getMockImplementation();
      if (!realRead) throw new Error("readSync test seam is not configured");

      readSpy.mockImplementationOnce((fd, buffer, offset, length, position) => {
        const bytesRead = realRead(fd, buffer, offset, length, position);
        return bytesRead - 1;
      });
      body();
    }

    it("rejects a short read even when the opened fd originally fstats larger", () => {
      const dir = makeCredDir("short-read");
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), HARMLESS_TEST_KEY, {
        mode: 0o600,
      });

      withShortRead(() => {
        const result = createSystemdCredentialKeyStore({
          credentialsDirectory: dir.credentialsDirectory,
        });
        expect(result.getDatabaseKey()).toBeUndefined();
      });
    });

    it("rejects growth within the bound when opened-fd fstat reports the stale size", () => {
      const dir = makeCredDir("toctou-grow-within-bound");
      const grown = "x".repeat(64);
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), grown, {
        mode: 0o600,
      });

      withFakedFstatSize(1, () => {
        const result = createSystemdCredentialKeyStore({
          credentialsDirectory: dir.credentialsDirectory,
        });
        expect(result.getDatabaseKey()).toBeUndefined();

        const fstatSpy = vi.mocked(fsMocked.fstatSync);
        expect(fstatSpy).toHaveBeenCalledWith(expect.any(Number));
      });
    });

    it("still returns the trimmed content for a legitimate same-size credential (post-fix regression guard)", () => {
      // This guards against an over-eager fix that rejects every
      // file.  When stat and read agree the reader must continue
      // to return the trimmed credential.
      const dir = makeCredDir("happy-same-size");
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), HARMLESS_TEST_KEY, {
        mode: 0o600,
      });
      const result = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });
      expect(result.backend).toBe("systemd-credential");
      expect(result.productionSafe).toBe(true);
      expect(result.getDatabaseKey()).toBe(HARMLESS_TEST_KEY);
    });

    it("returns undefined promptly for a FIFO and requests Linux O_NONBLOCK before fstat", () => {
      const dir = makeCredDir("fifo-source");
      const fifoPath = join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL);
      execFileSync("mkfifo", [fifoPath]);

      const openSpy = vi.mocked(fsMocked.openSync);
      const realOpen = openSpy.getMockImplementation();
      if (!realOpen) throw new Error("openSync test seam is not configured");
      let requestedFlags: number | undefined;
      openSpy.mockImplementationOnce((path, flags, mode) => {
        requestedFlags = flags as number;
        // Keep the RED test disposable: if the implementation under test
        // omits O_NONBLOCK, add it only in this seam so the FIFO cannot
        // block the Vitest process while the assertion records the bug.
        return realOpen(path, (flags as number) | constants.O_NONBLOCK, mode);
      });

      const startedAt = Date.now();
      const result = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });
      const elapsed = Date.now() - startedAt;

      expect(result.getDatabaseKey()).toBeUndefined();
      expect(elapsed).toBeLessThan(500);
      expect(requestedFlags).toBeDefined();
      expect(requestedFlags! & constants.O_NONBLOCK).not.toBe(0);
      expect(requestedFlags! & constants.O_NOFOLLOW).not.toBe(0);
    });

    it("accepts an exact-MAX regular source only after the EOF probe", () => {
      const dir = makeCredDir("exact-max");
      const exactMax = Buffer.alloc(SYSTEMD_CREDENTIAL_MAX_BYTES, 0x78);
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), exactMax, {
        mode: 0o600,
      });
      const readSpy = vi.mocked(fsMocked.readSync);
      readSpy.mockClear();

      const result = createSystemdCredentialKeyStore({
        credentialsDirectory: dir.credentialsDirectory,
      });

      expect(result.getDatabaseKey()).toBe("x".repeat(SYSTEMD_CREDENTIAL_MAX_BYTES));
      const readCalls = readSpy.mock.calls as unknown as Array<
        [number, Buffer, number, number, number | null]
      >;
      expect(readSpy).toHaveBeenCalledTimes(2);
      expect(readCalls[1]?.[3]).toBe(1);
      expect(readCalls[1]?.[4]).toBe(SYSTEMD_CREDENTIAL_MAX_BYTES);
    });

    it("rejects MAX+1 when stale fstat reports MAX after the second read at offset MAX", () => {
      const dir = makeCredDir("stale-max-plus-one");
      const maxPlusOne = Buffer.alloc(SYSTEMD_CREDENTIAL_MAX_BYTES + 1, 0x78);
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), maxPlusOne, {
        mode: 0o600,
      });
      const readSpy = vi.mocked(fsMocked.readSync);
      readSpy.mockClear();

      withFakedFstatSize(SYSTEMD_CREDENTIAL_MAX_BYTES, () => {
        const result = createSystemdCredentialKeyStore({
          credentialsDirectory: dir.credentialsDirectory,
        });

        expect(result.getDatabaseKey()).toBeUndefined();
      });

      const readCalls = readSpy.mock.calls as unknown as Array<
        [number, Buffer, number, number, number | null]
      >;
      expect(readSpy).toHaveBeenCalledTimes(2);
      expect(readCalls[1]?.[3]).toBe(1);
      expect(readCalls[1]?.[4]).toBe(SYSTEMD_CREDENTIAL_MAX_BYTES);
    });

    it("rejects an oversized credential source at the fd-fstat gate without throwing", () => {
      // When stat and read agree that the file is oversized, the
      // factory must still refuse categorically.  This pins that
      // refusal branch without exposing the underlying filesystem error.
      const dir = makeCredDir("oversized-no-throw");
      const oversized = "x".repeat(SYSTEMD_CREDENTIAL_MAX_BYTES + 1);
      writeFileSync(join(dir.credentialsDirectory, PUBLIC_CREDENTIAL_LABEL), oversized, {
        mode: 0o600,
      });
      let result: ReturnType<typeof createSystemdCredentialKeyStore> | undefined;
      expect(() => {
        result = createSystemdCredentialKeyStore({
          credentialsDirectory: dir.credentialsDirectory,
        });
      }).not.toThrow();
      expect(result?.getDatabaseKey()).toBeUndefined();
    });
  });
});
