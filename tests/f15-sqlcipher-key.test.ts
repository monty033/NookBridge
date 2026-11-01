import { readFileSync, readdirSync } from "node:fs";
import { URL } from "node:url";

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { validateSqlcipherKey } from "../src/storage/sqlcipher-key.js";

/** A `.replace` that deletes quote or backslash from a key instead of refusing it. */
const STRIPPING_COPY = /\.replace\(\s*\/\["\\\\\]\/g?\s*,\s*""\s*\)/;

// Evaluate the actual declarations with inert dependencies: no native module,
// filesystem operation, credential read, or database is needed for these probes.
function loadProbe(file: string, name: string, dependencies: Record<string, unknown>) {
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = source.statements.filter(
    (statement) =>
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === name,
  );
  const code = ts.transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function("exports", ...Object.keys(dependencies), `${code}\nreturn ${name};`)(
    {},
    ...Object.values(dependencies),
  );
}

function probes() {
  const pragma = vi.fn((_sql: string) => [{ integrity_check: "ok" }]);
  const open = vi.fn();
  class Database {
    name = "PLACEHOLDER_DATABASE";
    constructor() {
      open();
    }
    pragma = pragma;
    close() {}
  }
  const dependencies = {
    Database,
    validateSqlcipherKey,
    enforcePrivateFile: () => {},
    lstatSync: () => ({ isFile: () => true }),
  };
  const Storage = loadProbe("storage/sqlite-storage.ts", "SqliteStorage", dependencies);
  const inspect = loadProbe("storage/sqlite-storage.ts", "inspectEncryptedSqlite", dependencies);
  const classify = loadProbe("operator/recover-bundle.ts", "classifyMemberForReinit", dependencies);
  return {
    pragma,
    open,
    storage: (key: string) =>
      new Storage({ dbPath: "PLACEHOLDER_DATABASE", key, withExtensions: false }),
    inspect: (key: string) => inspect({ dbPath: "PLACEHOLDER_DATABASE", key }),
    classify: (key: string) => classify("PLACEHOLDER_DATABASE", key),
  };
}

describe("F15 — SQLCipher key refusal", () => {
  for (const key of ['PLACEHOLDER"SUFFIX', "PLACEHOLDER\\SUFFIX", '"\\']) {
    it("rejects unsupported characters without exposing the supplied value", () => {
      let error: unknown;
      try {
        validateSqlcipherKey(key);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("SQLCipher key contains unsupported characters");
      expect((error as Error).message).not.toContain(key);
      expect((error as Error).message).not.toContain("PLACEHOLDER");
      expect((error as Error).message).not.toContain("SUFFIX");
      expect(error).not.toHaveProperty("cause");
    });

    it("refuses every storage/recovery path before any open or pragma", () => {
      const probe = probes();
      expect(() => probe.storage(key)).toThrow("SQLCipher key contains unsupported characters");
      expect(probe.inspect(key)).toEqual({ status: "unreadable" });
      expect(probe.classify(key)).toBe("unreadable");
      expect(probe.open).not.toHaveBeenCalled();
      expect(probe.pragma).not.toHaveBeenCalled();
    });
  }

  for (const key of ["PLACEHOLDER_NORMAL_KEY", "", "   "]) {
    it("preserves supported keys and the exact pragma text", () => {
      expect(validateSqlcipherKey(key)).toBe(key);
      const probe = probes();
      probe.storage(key);
      expect(probe.pragma.mock.calls).toEqual([["cipher='sqlcipher'"], [`key="${key}"`]]);
      probe.pragma.mockClear();
      expect(probe.inspect(key)).toEqual({ status: "healthy" });
      expect(probe.pragma.mock.calls).toEqual([
        ["cipher='sqlcipher'"],
        [`key="${key}"`],
        ["integrity_check(100)"],
      ]);
      probe.pragma.mockClear();
      expect(probe.classify(key)).toBe("healthy");
      expect(probe.pragma.mock.calls).toEqual([
        ["cipher='sqlcipher'"],
        [`key="${key}"`],
        ["integrity_check(100)"],
      ]);
    });
  }

  it("leaves no stripping copy behind anywhere in src", () => {
    const offenders = readdirSync(new URL("../src", import.meta.url), {
      recursive: true,
      encoding: "utf8",
    })
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) =>
        STRIPPING_COPY.test(readFileSync(new URL(`../src/${entry}`, import.meta.url), "utf8")),
      );
    expect(offenders).toEqual([]);
  });
});
