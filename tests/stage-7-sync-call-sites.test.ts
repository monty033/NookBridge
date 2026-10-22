/**
 * Stage 7a-1 — lock today's upstream sync call sites.
 *
 * Locks the d09c8f2 call graph. DR-S7a may amend this allowlist; changing it
 * requires review.
 *
 * This file is a snapshot of the call graph at d09c8f2, not the final upload
 * policy. DR-S7a items 3–5 (intent ledger, dirty-set probe,
 * `unapproved_pending`, and upload approval) are deliberately not encoded
 * here. The allowlists below pin the call sites that exist today so a new
 * `syncer.start`, a new `{type: "full" | "send"}` literal, or a new
 * `requestSync()` caller cannot land silently in a timer, a write hook, or
 * startup reconciliation.
 *
 * The scanner is AST-based on purpose: comments and docstrings that mention
 * `syncer.start({type:"full"})` or `requestSync()` must neither create false
 * findings nor hide real ones.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { NotesnookReadOnlyDatabase } from "../src/core/notesnook-readonly-adapter.js";
import {
  flattenLiveDatabaseToReadOnly,
  isNotesnookReadOnlyProjectionError,
} from "../src/core/notesnook-readonly-projection.js";
import type { NotesnookReadOnlyProjectionSource } from "../src/core/notesnook-readonly-projection.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(repositoryRoot, "src");

/** A closed finding: the file it belongs to and the locked value it names. */
export interface SyncCallSiteFinding {
  readonly file: string;
  readonly value: "syncer" | "full" | "send" | "force" | "requestSync";
}

/** The closed finding set returned for one file's source text. */
export interface SyncCallSiteFindings {
  readonly syncerAccess: readonly SyncCallSiteFinding[];
  readonly syncTypeLiteral: readonly SyncCallSiteFinding[];
  readonly forceProperty: readonly SyncCallSiteFinding[];
  readonly requestSyncCall: readonly SyncCallSiteFinding[];
}

/**
 * d09c8f2 syncer-slot references, by repository-relative file and count.
 *
 * The slot is read through `Reflect.get`, `readSlot`, and `readSyncer`, so
 * the scan counts the identifier and property-name literal forms as well as
 * `.syncer` / `["syncer"]`. This is what makes the lock cover
 * `Reflect.get(db, "syncer")` and `syncer.start` alike.
 */
const SYNCER_ACCESS_ALLOWLIST = {
  "src/core/notesnook-core-adapter.ts": 1,
  "src/core/notesnook-live-factory.ts": 1,
  "src/core/notesnook-live-remote-sync.ts": 7,
  "src/core/notesnook-readonly-projection.ts": 5,
} as const;

/**
 * d09c8f2 `{type: "full" | "send"}` object-literal properties.
 *
 * The only literal is the explicit write-side executor. The read-only
 * projection only forwards `"fetch"`.
 */
const SYNC_TYPE_LITERAL_ALLOWLIST = {
  "src/core/notesnook-live-remote-sync.ts": 1,
} as const;

/**
 * d09c8f2 `force` object-literal properties passed to a `sync` / `start` call.
 *
 * This is the read-only adapter's unreachable spread at
 * `notesnook-readonly-adapter.ts:330`: `sync()` already rejects any defined
 * `force` at the top of the method, so the spread can never run. It is
 * pinned here as dead code and recorded as a DR-S7a cleanup candidate; it is
 * not permission for a new `force` path.
 */
const FORCE_PROPERTY_ALLOWLIST = {
  "src/core/notesnook-readonly-adapter.ts": 1,
} as const;

/**
 * d09c8f2 explicit `requestSync()` / `.requestSync()` calls, by file and count.
 *
 * `src/mcp/socket-client.ts:257` is a plain method declaration with no
 * `requestSync` invocation in its body, so it is not counted. The
 * `src/core/notesnook-write-composition.ts:1287` relay is an
 * `async requestSync()` declaration whose body invokes the captured
 * coordinator method through `Reflect.apply(state.requestSync, ...)` at
 * `:1296`; the indirect invocation is counted as the explicit call site.
 */
const REQUEST_SYNC_CALL_ALLOWLIST = {
  "src/core/notesnook-live-factory.ts": 1,
  "src/core/notesnook-live-remote-sync.ts": 1,
  "src/core/notesnook-write-admin.ts": 1,
  "src/core/notesnook-write-composition.ts": 1,
  "src/mcp/nook-mcp-server.ts": 1,
  "src/service/service-runtime.ts": 1,
} as const;

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
      return argument.text;
    }
  }
  return undefined;
}

function isInsideSyncOrStartArgument(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (ts.isCallExpression(current)) {
      const name = calleeName(current.expression);
      if (name === "sync" || name === "start") {
        const isArgument = current.arguments.some(
          (argument) => argument.pos <= node.pos && node.end <= argument.end,
        );
        if (isArgument) return true;
      }
    }
    current = current.parent;
    if (current !== undefined && ts.isFunctionLike(current)) return false;
  }
  return false;
}

function isRequestSyncReference(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === "requestSync";
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === "requestSync";
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
      return argument.text === "requestSync";
    }
  }
  return false;
}

/**
 * Match a direct `requestSync()` / `.requestSync()` call and the explicit
 * `Reflect.apply(state.requestSync, ...)` relay. Bare method declarations are
 * not calls and are not matched.
 */
function isRequestSyncCall(node: ts.CallExpression): boolean {
  if (isRequestSyncReference(node.expression)) return true;
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Reflect" &&
    node.expression.name.text === "apply"
  ) {
    const [target] = node.arguments;
    return target !== undefined && isRequestSyncReference(target);
  }
  return false;
}

/**
 * Parse one file and return the closed sync-call-site findings for it.
 *
 * `syncerAccess` counts every syntactic reference to the `syncer` slot:
 * identifiers named `syncer` (including `syncer.start` and declarations) and
 * the exact property-name string `"syncer"` (including `["syncer"]`,
 * `Reflect.get(db, "syncer")`, and `readSlot(db, "syncer")`).
 * `syncTypeLiteral` only matches an object-literal `type` property whose value
 * is the string literal `"full"` or `"send"`. `forceProperty` matches an
 * object-literal `force` property anywhere inside an argument to a call named
 * `sync` or `start`. `requestSyncCall` matches a direct call whose callee is
 * `requestSync` or `.requestSync`, plus the explicit
 * `Reflect.apply(x.requestSync, ...)` relay; method declarations are not
 * calls.
 */
export function scanSyncCallSites(fileName: string, text: string): SyncCallSiteFindings {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const findings: {
    syncerAccess: SyncCallSiteFinding[];
    syncTypeLiteral: SyncCallSiteFinding[];
    forceProperty: SyncCallSiteFinding[];
    requestSyncCall: SyncCallSiteFinding[];
  } = {
    syncerAccess: [],
    syncTypeLiteral: [],
    forceProperty: [],
    requestSyncCall: [],
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "syncer") {
      findings.syncerAccess.push({ file: fileName, value: "syncer" });
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === "syncer"
    ) {
      findings.syncerAccess.push({ file: fileName, value: "syncer" });
    }

    if (
      ts.isPropertyAssignment(node) &&
      ts.isObjectLiteralExpression(node.parent) &&
      propertyNameText(node.name) === "type"
    ) {
      const value = node.initializer;
      if (ts.isStringLiteral(value) && (value.text === "full" || value.text === "send")) {
        findings.syncTypeLiteral.push({ file: fileName, value: value.text });
      }
    }

    if (
      ts.isPropertyAssignment(node) &&
      ts.isObjectLiteralExpression(node.parent) &&
      propertyNameText(node.name) === "force" &&
      isInsideSyncOrStartArgument(node)
    ) {
      findings.forceProperty.push({ file: fileName, value: "force" });
    }

    if (ts.isCallExpression(node) && isRequestSyncCall(node)) {
      findings.requestSyncCall.push({ file: fileName, value: "requestSync" });
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return findings;
}

function listSourceFiles(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(path, files);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function toRepositoryPath(filePath: string): string {
  return relative(repositoryRoot, filePath).split(sep).join("/");
}

function scanSourceTree(): SyncCallSiteFindings {
  const findings: {
    syncerAccess: SyncCallSiteFinding[];
    syncTypeLiteral: SyncCallSiteFinding[];
    forceProperty: SyncCallSiteFinding[];
    requestSyncCall: SyncCallSiteFinding[];
  } = {
    syncerAccess: [],
    syncTypeLiteral: [],
    forceProperty: [],
    requestSyncCall: [],
  };

  for (const filePath of listSourceFiles(sourceRoot).sort()) {
    const scanned = scanSyncCallSites(toRepositoryPath(filePath), readFileSync(filePath, "utf8"));
    findings.syncerAccess.push(...scanned.syncerAccess);
    findings.syncTypeLiteral.push(...scanned.syncTypeLiteral);
    findings.forceProperty.push(...scanned.forceProperty);
    findings.requestSyncCall.push(...scanned.requestSyncCall);
  }

  return findings;
}

function countByFile(findings: readonly SyncCallSiteFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.file] = (counts[finding.file] ?? 0) + 1;
  }
  return counts;
}

function createProjectionFixture(): {
  database: NotesnookReadOnlyProjectionSource;
  startCalls: unknown[];
} {
  const startCalls: unknown[] = [];
  const database = {
    syncer: {
      start: async (options: unknown): Promise<boolean> => {
        startCalls.push(options);
        return true;
      },
    },
    notebooks: {
      all: { ids: async (): Promise<string[]> => [] },
      notebook: async (): Promise<undefined> => undefined,
    },
    notes: {
      all: { ids: async (): Promise<string[]> => [] },
      note: async (): Promise<undefined> => undefined,
    },
    lookup: {
      notes: async () => ({ ids: async (): Promise<string[]> => [] }),
      notebooks: async () => ({ ids: async (): Promise<string[]> => [] }),
    },
    lastSynced: async (): Promise<number> => 0,
    hasUnsyncedChanges: async (): Promise<boolean> => false,
  };
  return {
    database: database as unknown as NotesnookReadOnlyProjectionSource,
    startCalls,
  };
}

function requestProjectionSync(
  projection: NotesnookReadOnlyDatabase,
  options: unknown,
): Promise<boolean> {
  const sync = projection.sync as (value: unknown) => Promise<boolean>;
  return sync(options);
}

describe("Stage 7a-1 sync call-site lock", () => {
  const findings = scanSourceTree();

  it("pins the only full/send object-literal sync type", () => {
    expect(findings.syncTypeLiteral).toEqual([
      { file: "src/core/notesnook-live-remote-sync.ts", value: "full" },
    ]);
    expect(findings.syncTypeLiteral.filter((finding) => finding.value === "send")).toEqual([]);
    expect(countByFile(findings.syncTypeLiteral)).toEqual(SYNC_TYPE_LITERAL_ALLOWLIST);
  });

  it("pins every syncer-slot reference by file and count", () => {
    expect(countByFile(findings.syncerAccess)).toEqual(SYNCER_ACCESS_ALLOWLIST);
    expect(Object.keys(countByFile(findings.syncerAccess)).sort()).toEqual(
      Object.keys(SYNCER_ACCESS_ALLOWLIST).sort(),
    );
  });

  it("pins every explicit requestSync call and excludes method definitions", () => {
    const counts = countByFile(findings.requestSyncCall);

    expect(counts).toEqual(REQUEST_SYNC_CALL_ALLOWLIST);
    expect(counts).toMatchObject({ "src/core/notesnook-write-composition.ts": 1 });
    expect(counts).not.toHaveProperty("src/mcp/socket-client.ts");
  });

  it("pins the only force property, flagging the dead read-only spread", () => {
    expect(findings.forceProperty).toEqual([
      { file: "src/core/notesnook-readonly-adapter.ts", value: "force" },
    ]);
    expect(countByFile(findings.forceProperty)).toEqual(FORCE_PROPERTY_ALLOWLIST);
  });

  it("reports an inline send request as one syncer access and one type literal", () => {
    const scanned = scanSyncCallSites(
      "src/core/sync-call-fixture.ts",
      'syncer.start({ type: "send" });',
    );

    expect(scanned.syncerAccess).toEqual([
      { file: "src/core/sync-call-fixture.ts", value: "syncer" },
    ]);
    expect(scanned.syncTypeLiteral).toEqual([
      { file: "src/core/sync-call-fixture.ts", value: "send" },
    ]);
  });

  it("ignores comments and docstrings that mention sync calls", () => {
    const scanned = scanSyncCallSites(
      "src/core/sync-comment-fixture.ts",
      `// syncer.start({type:"full"})
/**
 * A timer may call requestSync() from a docstring.
 */
export const documentationOnly = true;`,
    );

    expect(scanned.syncerAccess).toEqual([]);
    expect(scanned.syncTypeLiteral).toEqual([]);
    expect(scanned.forceProperty).toEqual([]);
    expect(scanned.requestSyncCall).toEqual([]);
  });

  it("reports a new requestSync timer outside the allowlist", () => {
    const fixtureFile = "src/core/new-sync-timer.ts";
    const scanned = scanSyncCallSites(fixtureFile, "timer(() => coordinator.requestSync());");

    expect(scanned.requestSyncCall).toEqual([{ file: fixtureFile, value: "requestSync" }]);
    expect(Object.keys(REQUEST_SYNC_CALL_ALLOWLIST)).not.toContain(fixtureFile);
  });

  it("rejects full, send, force, and extra keys before upstream start", async () => {
    const rejected = [
      { type: "full" },
      { type: "send" },
      { type: "fetch", force: true },
      { type: "fetch", extra: 1 },
    ];

    for (const options of rejected) {
      const { database, startCalls } = createProjectionFixture();
      const projection = flattenLiveDatabaseToReadOnly(database);

      await expect(requestProjectionSync(projection, options)).rejects.toSatisfy(
        isNotesnookReadOnlyProjectionError,
      );
      expect(startCalls).toHaveLength(0);
    }
  });

  it("forwards exactly one fetch request with only an own type key", async () => {
    const { database, startCalls } = createProjectionFixture();
    const projection = flattenLiveDatabaseToReadOnly(database);

    await expect(projection.sync({ type: "fetch" })).resolves.toBe(true);

    expect(startCalls).toHaveLength(1);
    const argument = startCalls[0];
    expect(argument).toBeTypeOf("object");
    expect(Reflect.ownKeys(argument as object)).toEqual(["type"]);
    expect(argument).toMatchObject({ type: "fetch" });
  });
});
