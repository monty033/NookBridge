/**
 * Tests for the narrow `nookbridge-runtime-check` entrypoint.
 *
 * The runtime check is the *production* companion to the Stage 0
 * `tests/native-runtime.test.ts` disposable harness: it loads the same
 * `better-sqlite3-multiple-ciphers` + `sqlite-better-trigram` +
 * `sqlite-regex` + `sqlite3-fts5-html` extension stack against an
 * in-memory encrypted database and runs a representative trigram+regex
 * query, then prints only a fixed categorical success/failure line.
 *
 * Hard rules under test:
 *
 *   - Output is strictly categorical.  No paths, no extension names,
 *     no version numbers, no query strings, no error messages, no
 *     database contents.
 *   - The runtime check never opens, reads, writes, imports, or
 *     references any host filesystem path, configuration file,
 *     credentials file, daemon state directory, Notesnook vault,
 *     or live network socket.  In particular:
 *       * No `process.env` / `os.tmpdir()` reads.
 *       * No `fs` module imports.
 *       * No Notesnook core / live factory imports.
 *       * No `net` / `http` / `https` / `dgram` imports.
 *   - Exit code is `0` for the categorical OK and `1` for the
 *     categorical failure.
 *   - The runtime check is the *only* code path in the entrypoint.
 *     The test exercises the `runRuntimeCheck` seam directly so the
 *     same categorical contract is asserted independent of argv
 *     parsing.
 */

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { EOL } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RUNTIME_CHECK_FAILURE_LINE,
  RUNTIME_CHECK_OK_LINE,
  runRuntimeCheck,
} from "../src/runtime-check.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("nookbridge-runtime-check output contract", () => {
  it("emits the exact OK line and exits 0 on a clean extension load", async () => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const exitCode = await runRuntimeCheck({
      writeOut: (text: string) => stdout.push(Buffer.from(text, "utf8")),
      writeErr: (text: string) => stderr.push(Buffer.from(text, "utf8")),
    });

    const out = Buffer.concat(stdout).toString("utf8");
    const err = Buffer.concat(stderr).toString("utf8");

    expect(exitCode).toBe(0);
    expect(out).toBe(`${RUNTIME_CHECK_OK_LINE}${EOL}`);
    expect(err).toBe("");
  });

  it("selects SQLCipher before probing the in-memory database", async () => {
    const pragmas: string[] = [];
    const db = {
      exec: () => undefined,
      pragma: (source: string) => {
        pragmas.push(source);
      },
      loadExtension: () => undefined,
      prepare: () => ({
        run: () => undefined,
        all: () => [],
      }),
      close: () => undefined,
    };
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const exitCode = await runRuntimeCheck({
      writeOut: (text: string) => stdout.push(Buffer.from(text, "utf8")),
      writeErr: (text: string) => stderr.push(Buffer.from(text, "utf8")),
      loadExtensions: () => ({
        openDatabase: () => db,
        trigramPath: () => "trigram",
        regexPath: () => "regex",
        fts5HtmlPath: () => "fts5-html",
      }),
      runRepresentativeQuery: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(pragmas).toContain("cipher='sqlcipher'");
    expect(Buffer.concat(stdout).toString("utf8")).toBe(`${RUNTIME_CHECK_OK_LINE}${EOL}`);
    expect(Buffer.concat(stderr).toString("utf8")).toBe("");
  });

  it("emits the exact failure line and exits 1 when the extension stack is incomplete", async () => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const exitCode = await runRuntimeCheck({
      writeOut: (text: string) => stdout.push(Buffer.from(text, "utf8")),
      writeErr: (text: string) => stderr.push(Buffer.from(text, "utf8")),
      // Replace the trigram loader with a deliberately broken stub to
      // exercise the failure branch without touching the host filesystem
      // or any real extension path.  The runtime check must still
      // produce the fixed categorical failure line.
      loadExtensions: () => {
        throw new Error("forced extension failure");
      },
    });

    const out = Buffer.concat(stdout).toString("utf8");
    const err = Buffer.concat(stderr).toString("utf8");

    expect(exitCode).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(`${RUNTIME_CHECK_FAILURE_LINE}${EOL}`);
  });

  it("emits the categorical failure line when the representative query throws", async () => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const exitCode = await runRuntimeCheck({
      writeOut: (text: string) => stdout.push(Buffer.from(text, "utf8")),
      writeErr: (text: string) => stderr.push(Buffer.from(text, "utf8")),
      runRepresentativeQuery: () => {
        throw new Error("forced query failure");
      },
    });

    const out = Buffer.concat(stdout).toString("utf8");
    const err = Buffer.concat(stderr).toString("utf8");

    expect(exitCode).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(`${RUNTIME_CHECK_FAILURE_LINE}${EOL}`);
  });

  it("prints only the OK line and never includes the underlying error message", async () => {
    const canary = "this-must-never-leak-into-output";
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    await runRuntimeCheck({
      writeOut: (text: string) => stdout.push(Buffer.from(text, "utf8")),
      writeErr: (text: string) => stderr.push(Buffer.from(text, "utf8")),
      loadExtensions: () => {
        throw new Error(canary);
      },
    });

    const combined = `${Buffer.concat(stdout).toString("utf8")}${Buffer.concat(stderr).toString(
      "utf8",
    )}`;
    expect(combined).not.toContain(canary);
  });

  it("treats the OK and failure lines as distinct categorical tokens", () => {
    expect(RUNTIME_CHECK_OK_LINE).not.toBe(RUNTIME_CHECK_FAILURE_LINE);
    // Neither line carries path, extension, version, query, error, or
    // credentials text.  Whitelist a tiny closed alphabet so future
    // edits cannot smuggle in upstream diagnostics.
    expect(RUNTIME_CHECK_OK_LINE).toMatch(/^[a-z0-9 _-]+$/i);
    expect(RUNTIME_CHECK_FAILURE_LINE).toMatch(/^[a-z0-9 _-]+$/i);
    expect(RUNTIME_CHECK_OK_LINE).not.toMatch(/\/\//);
    expect(RUNTIME_CHECK_FAILURE_LINE).not.toMatch(/\/\//);
    expect(RUNTIME_CHECK_OK_LINE).not.toMatch(/[/\\]/);
    expect(RUNTIME_CHECK_FAILURE_LINE).not.toMatch(/[/\\]/);
  });
});

describe("nookbridge-runtime-check boundary enforcement", () => {
  it("source never imports fs, net, http, https, dgram, child_process, or Notesnook", () => {
    const source = readFileSync(resolve(repositoryRoot, "src/runtime-check.ts"), "utf8");

    // No filesystem access; the runtime check operates only on an
    // in-memory encrypted database, so any fs reference is a contract
    // violation.
    expect(source).not.toMatch(/from\s+["']node:fs["']/);
    expect(source).not.toMatch(/from\s+["']node:fs\/promises["']/);
    expect(source).not.toMatch(/from\s+["']fs["']/);

    // No network access of any kind.
    expect(source).not.toMatch(/from\s+["']node:net["']/);
    expect(source).not.toMatch(/from\s+["']node:http["']/);
    expect(source).not.toMatch(/from\s+["']node:https["']/);
    expect(source).not.toMatch(/from\s+["']node:dgram["']/);
    expect(source).not.toMatch(/from\s+["']node:fetch["']/);

    // No subprocess spawning.
    expect(source).not.toMatch(/from\s+["']node:child_process["']/);

    // No Notesnook / vault / live factory imports — the runtime check
    // is intentionally narrow and must not pull in stateful layers.
    expect(source).not.toMatch(/@notesnook/);
    expect(source).not.toMatch(/notesnook-core/);
    expect(source).not.toMatch(/notesnook-live-factory/);
    expect(source).not.toMatch(/notesnook-sync-proof/);

    // No environment lookups — the runtime check must operate the same
    // way regardless of host env.
    expect(source).not.toMatch(/process\.env/);

    // No tmpdir or os lookups — those are filesystem-aware by nature.
    expect(source).not.toMatch(/os\./);
    expect(source).not.toMatch(/from\s+["']node:os["']/);
  });

  it("source never inlines a credential, token, password, key, or note payload", () => {
    const source = readFileSync(resolve(repositoryRoot, "src/runtime-check.ts"), "utf8");

    const canaries = [
      "test-password",
      "test-token",
      "test-secret",
      "encryption-key",
      "note-body",
      "note-content",
      "note-title",
    ];
    for (const canary of canaries) {
      expect(source.toLowerCase()).not.toContain(canary);
    }
  });
});
