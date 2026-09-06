/** Stage 9 §13.11 — read-only bounded state-tree runtime. */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";

import { lockFileExists } from "../config/lock.js";
import { normaliseStateDir } from "../config/state-dir.js";
import {
  isTreeCursor,
  isTreeHandle,
  type TreeCommandRuntime,
  type TreeEntry,
  type TreeListOptions,
  type TreeResult,
  TREE_LIST_MAX_LIMIT,
} from "./tree-cli.js";

const QUARANTINE_DIR = ".recovery-quarantine";
const QUARANTINE_ID = /^[a-f0-9]{8}-[a-z0-9]{12,13}$/;
const MAX_SCAN_ENTRIES = 256;
const HASH_DOMAIN = "nookbridge-tree-v1";

type StatLike = { isDirectory(): boolean; isSymbolicLink(): boolean; mode: number; uid: number };

export function createTreeRuntime(): TreeCommandRuntime {
  return { list: listTree };
}

async function listTree(options: TreeListOptions): Promise<TreeResult> {
  const root = validateRoot(options.stateDir);
  if (root.kind !== "ok") return root.result;
  if (lockFileExists(root.path)) return { kind: "locked" };
  if (options.handle === undefined)
    return page(
      [entry("state-root", stateHandle(), root.stat, countQuarantine(root.path))],
      options,
    );
  if (!isTreeHandle(options.handle)) return { kind: "invalid-input" };
  const prefix = options.handle.slice(0, options.handle.indexOf("_"));
  if (prefix === "st") {
    return options.handle === stateHandle()
      ? listStateChildren(root.path, options)
      : { kind: "invalid-input" };
  }
  if (prefix === "qrn") {
    return options.handle === quarantineHandle()
      ? listQuarantineChildren(root.path, options)
      : { kind: "invalid-input" };
  }
  if (prefix === "qre") return resolveQuarantineEntry(root.path, options);
  return { kind: "invalid-input" };
}

function validateRoot(
  input: string,
):
  | { kind: "ok"; path: string; stat: StatLike }
  | { kind: "missing" | "denied" | "locked" | "error"; result: TreeResult } {
  if (typeof input !== "string" || input.length === 0 || input.split(/[\\/]/u).includes(".."))
    return { kind: "denied", result: { kind: "denied" } };
  let path: string;
  try {
    path = normaliseStateDir(input);
  } catch {
    return { kind: "denied", result: { kind: "denied" } };
  }
  let stat: StatLike;
  try {
    stat = lstatSync(path);
  } catch (error: unknown) {
    const code =
      error instanceof Error && "code" in error
        ? (error as Error & { code?: string }).code
        : undefined;
    return {
      kind: code === "ENOENT" ? "missing" : "error",
      result: { kind: code === "ENOENT" ? "missing" : "error", exitCode: 3 },
    };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    return { kind: "denied", result: { kind: "denied" } };
  return { kind: "ok", path, stat };
}

function listStateChildren(root: string, options: TreeListOptions): TreeResult {
  const names = safeReadNames(root);
  if (names.kind !== "ok") return names.result;
  const entries: TreeEntry[] = [];
  for (const name of names.names) {
    const path = safeJoin(root, name);
    if (path === undefined) return { kind: "denied" };
    const stat = safeLstat(path);
    if (stat === undefined) continue;
    if (name === QUARANTINE_DIR && stat.isDirectory() && !stat.isSymbolicLink()) {
      entries.push(entry("quarantine-root", quarantineHandle(), stat, countQuarantine(path)));
    } else {
      entries.push(protectedEntry(stat));
    }
  }
  return page(entries, options);
}

function listQuarantineChildren(root: string, options: TreeListOptions): TreeResult {
  const quarantine = safeJoin(root, QUARANTINE_DIR);
  if (quarantine === undefined) return { kind: "denied" };
  const qstat = safeLstat(quarantine);
  if (qstat === undefined) return { kind: "missing" };
  if (qstat.isSymbolicLink() || !qstat.isDirectory()) return { kind: "denied" };
  const names = safeReadNames(quarantine);
  if (names.kind !== "ok") return names.result;
  const entries: TreeEntry[] = [];
  for (const name of names.names) {
    const path = safeJoin(quarantine, name);
    if (path === undefined) return { kind: "denied" };
    const stat = safeLstat(path);
    if (stat === undefined) continue;
    if (QUARANTINE_ID.test(name) && stat.isDirectory() && !stat.isSymbolicLink()) {
      entries.push(entry("quarantine-entry", quarantineEntryHandle(name), stat, "unknown"));
    } else {
      entries.push(protectedEntry(stat));
    }
  }
  return page(entries, options);
}

function resolveQuarantineEntry(root: string, options: TreeListOptions): TreeResult {
  const quarantine = safeJoin(root, QUARANTINE_DIR);
  if (quarantine === undefined) return { kind: "denied" };
  const qstat = safeLstat(quarantine);
  if (qstat === undefined) return { kind: "missing" };
  if (qstat.isSymbolicLink() || !qstat.isDirectory()) return { kind: "denied" };
  const names = safeReadNames(quarantine);
  if (names.kind !== "ok") return names.result;
  const wanted = options.handle;
  if (wanted === undefined) return { kind: "invalid-input" };
  for (const name of names.names) {
    if (!QUARANTINE_ID.test(name) || quarantineEntryHandle(name) !== wanted) continue;
    const path = safeJoin(quarantine, name);
    const stat = path === undefined ? undefined : safeLstat(path);
    if (stat === undefined) return { kind: "missing" };
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { kind: "denied" };
    return { kind: "empty" };
  }
  return { kind: "missing" };
}

function page(entries: readonly TreeEntry[], options: TreeListOptions): TreeResult {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > TREE_LIST_MAX_LIMIT
  )
    return { kind: "invalid-input" };
  const sorted = [...entries];
  if (options.cursor !== undefined && !isTreeCursor(options.cursor))
    return { kind: "invalid-input" };
  let start = 0;
  if (options.cursor !== undefined) {
    const index = Array.from({ length: sorted.length + 1 }, (_, value) => value).find(
      (index) => cursorForIndex(index) === options.cursor,
    );
    if (index === undefined) return { kind: "invalid-input" };
    start = index;
  }
  const visible = sorted.slice(start, start + options.limit);
  if (visible.length === 0) return { kind: "empty" };
  const next =
    start + visible.length < sorted.length ? cursorForIndex(start + visible.length) : null;
  return { kind: "page", entries: visible, next };
}

function entry(
  kind: Exclude<TreeEntry["kind"], "protected">,
  handle: string,
  stat: StatLike,
  childCount: number | "unknown",
): TreeEntry {
  return {
    handle,
    kind,
    label: kind,
    mode: stat.isDirectory() ? "directory" : "file",
    owner: owner(stat),
    sizeClass: "bounded",
    childCount,
  };
}
function protectedEntry(stat: StatLike): TreeEntry {
  return {
    handle: null,
    kind: "protected",
    label: "protected",
    mode: stat.isDirectory() ? "directory" : "file",
    owner: owner(stat),
    sizeClass: "unknown",
    childCount: "n/a",
  };
}
function owner(stat: StatLike): "owner" | "other" {
  try {
    return typeof process.getuid === "function" && stat.uid === process.getuid()
      ? "owner"
      : "other";
  } catch {
    return "other";
  }
}
function stateHandle(): string {
  return `st_${digest("state-root")}`;
}
function quarantineHandle(): string {
  return `qrn_${digest("quarantine-root")}`;
}
function quarantineEntryHandle(name: string): string {
  return `qre_${digest(`quarantine-entry:${name}`)}`;
}
function cursorForIndex(index: number): string {
  return `crs_${digest(`cursor-index:${index}`)}`;
}
function digest(value: string): string {
  return createHash("sha256").update(`${HASH_DOMAIN}\0${value}`).digest("hex").slice(0, 32);
}

function countQuarantine(path: string): number {
  const names = safeReadNames(path);
  if (names.kind !== "ok") return 0;
  let count = 0;
  for (const name of names.names) {
    if (!QUARANTINE_ID.test(name)) continue;
    const stat = safeLstat(safeJoin(path, name));
    if (stat?.isDirectory() && !stat.isSymbolicLink()) count += 1;
    if (count >= TREE_LIST_MAX_LIMIT) return TREE_LIST_MAX_LIMIT;
  }
  return count;
}
function safeReadNames(
  path: string,
): { kind: "ok"; names: string[] } | { kind: "result"; result: TreeResult } {
  try {
    const names = readdirSync(path);
    if (names.length > MAX_SCAN_ENTRIES)
      return { kind: "result", result: { kind: "error", exitCode: 3 } };
    return { kind: "ok", names: names.sort() };
  } catch {
    return { kind: "result", result: { kind: "error", exitCode: 3 } };
  }
}
function safeLstat(path: string | undefined): StatLike | undefined {
  if (path === undefined) return undefined;
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
function safeJoin(root: string, name: string): string | undefined {
  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".."
  )
    return undefined;
  const path = join(root, name);
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))
    ? path
    : undefined;
}
