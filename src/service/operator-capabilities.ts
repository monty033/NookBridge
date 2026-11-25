/**
 * Per-principal operator access.
 *
 * The operator socket used to be all-or-nothing: one Unix group
 * (`nookbridge-operators`) decided every method, reads included.  This module
 * adds an optional, deny-by-default `operatorAccess` block that maps principals
 * (a group name or a user name) to capability families, and the compiled policy
 * the authorizer consults before it resolves any target.
 *
 * Three parts:
 *
 *   1. The closed method -> family table.  It is a `Record` over the whole
 *      operator vocabulary, so a method added to `operator-methods.ts` without
 *      a family fails the build.
 *   2. Structural validation of the config block.  Pure and synchronous; it is
 *      the part `loadServiceConfig` runs, so `nookd --check-config` stays
 *      independent of the host's user database.
 *   3. System validation.  Resolves every principal through the user/group
 *      database and refuses grants that are privileged or could never be used.
 *      It runs once at daemon startup and yields the compiled policy.
 *
 * Every refusal is a closed code.  No message ever carries the offending value,
 * a principal name, a uid or a path.
 */

import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import type { OperatorMethod } from "./operator-methods.js";
import type { OperatorPeer } from "./operator-server.js";

// ---------------------------------------------------------------------------
// Families.
// ---------------------------------------------------------------------------

export const OPERATOR_FAMILIES = Object.freeze([
  "discover",
  "read",
  "write",
  "conflict",
  "admin",
] as const);

export type OperatorFamily = (typeof OPERATOR_FAMILIES)[number];

/** The base operator group.  The only principal that may hold `admin`. */
export const OPERATOR_BASE_GROUP = "nookbridge-operators";

const METHOD_FAMILY = {
  "notes.browse": "discover",
  "notes.search-operator": "discover",
  "notes.operation-status": "discover",
  "notes.operation-list": "discover",
  "notes.get-view": "read",
  "notes.edit-preimage": "read",
  "notes.inspect-conflict": "read",
  "notes.create": "write",
  "notes.apply-edit": "write",
  "notes.apply-undo": "write",
  "notes.resolve-conflict": "conflict",
  "notes.abandon-resolve": "conflict",
  "notes.approve-upload": "admin",
  "notes.path_diagnostic": "admin",
  "notes.edit-census": "admin",
} satisfies Record<OperatorMethod, OperatorFamily>;

/**
 * The family of every operator method.  `satisfies Record<OperatorMethod, ...>`
 * makes the table exhaustive in both directions at compile time: a method
 * without a family and a family entry for a method that does not exist are both
 * build errors.
 */
export const OPERATOR_METHOD_FAMILY: Readonly<Record<OperatorMethod, OperatorFamily>> =
  Object.freeze(METHOD_FAMILY);

/** The family of `method`, or `undefined` for anything outside the vocabulary. */
export function operatorMethodFamily(method: unknown): OperatorFamily | undefined {
  if (typeof method !== "string") return undefined;
  if (!Object.hasOwn(OPERATOR_METHOD_FAMILY, method)) return undefined;
  return OPERATOR_METHOD_FAMILY[method as OperatorMethod];
}

function isOperatorFamily(value: unknown): value is OperatorFamily {
  return typeof value === "string" && (OPERATOR_FAMILIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Closed error vocabularies.
// ---------------------------------------------------------------------------

/** Conditions found by reading the config block alone. */
export const OPERATOR_ACCESS_CONFIG_ERROR_CODES = Object.freeze([
  "operator_access_invalid_block",
  "operator_access_unknown_key",
  "operator_access_version",
  "operator_access_principals_type",
  "operator_access_principals_empty",
  "operator_access_principal_type",
  "operator_access_principal_both",
  "operator_access_principal_neither",
  "operator_access_name_unsafe",
  "operator_access_principal_duplicate",
  "operator_access_families_type",
  "operator_access_families_empty",
  "operator_access_family_unknown",
  "operator_access_family_duplicate",
  "operator_access_admin_not_base",
] as const);

/** Conditions found by consulting the system user/group database. */
export const OPERATOR_ACCESS_SYSTEM_ERROR_CODES = Object.freeze([
  "operator_access_unresolved_principal",
  "operator_access_privileged_principal",
  "operator_access_unreachable_principal",
] as const);

export type OperatorAccessConfigErrorCode = (typeof OPERATOR_ACCESS_CONFIG_ERROR_CODES)[number];
export type OperatorAccessSystemErrorCode = (typeof OPERATOR_ACCESS_SYSTEM_ERROR_CODES)[number];
export type OperatorAccessErrorCode = OperatorAccessConfigErrorCode | OperatorAccessSystemErrorCode;

/**
 * Whether the code is one the block parser can raise on its own.  The system
 * codes need the user/group database and are raised at daemon startup, so a
 * config load that sees one has a bug: it narrows to the structural codes here
 * rather than widening the config error vocabulary.
 */
export function isOperatorAccessConfigErrorCode(
  code: OperatorAccessErrorCode,
): code is OperatorAccessConfigErrorCode {
  return (OPERATOR_ACCESS_CONFIG_ERROR_CODES as ReadonlyArray<string>).includes(code);
}

const OPERATOR_ACCESS_ERROR_MESSAGES: Readonly<Record<OperatorAccessErrorCode, string>> =
  Object.freeze({
    operator_access_invalid_block: "operatorAccess must be an object",
    operator_access_unknown_key: "operatorAccess contains an unknown key",
    operator_access_version: "operatorAccess version is not supported",
    operator_access_principals_type: "operatorAccess principals must be an array",
    operator_access_principals_empty: "operatorAccess principals must not be empty",
    operator_access_principal_type: "operatorAccess principal must be an object",
    operator_access_principal_both: "operatorAccess principal names both a user and a group",
    operator_access_principal_neither: "operatorAccess principal names neither a user nor a group",
    operator_access_name_unsafe: "operatorAccess principal name is not a safe token",
    operator_access_principal_duplicate: "operatorAccess principal appears more than once",
    operator_access_families_type: "operatorAccess families must be an array",
    operator_access_families_empty: "operatorAccess families must not be empty",
    operator_access_family_unknown: "operatorAccess families contains an unknown family",
    operator_access_family_duplicate: "operatorAccess families repeats a family",
    operator_access_admin_not_base: "operatorAccess grants admin to a non-base principal",
    operator_access_unresolved_principal: "operatorAccess principal does not resolve",
    operator_access_privileged_principal: "operatorAccess principal is privileged",
    operator_access_unreachable_principal: "operatorAccess principal cannot reach the socket",
  });

/**
 * Categorical operator-access refusal.  Carries only the closed code and a fixed
 * message; never the principal, uid, path or any config value.
 */
export class OperatorAccessError extends Error {
  readonly code: OperatorAccessErrorCode;
  /**
   * Position of the offending entry in the configured `principals` list.  Set by
   * the system checks only; an index is not a principal name or a config value.
   */
  readonly entryIndex?: number;
  constructor(code: OperatorAccessErrorCode, entryIndex?: number) {
    super(OPERATOR_ACCESS_ERROR_MESSAGES[code]);
    this.name = "OperatorAccessError";
    this.code = code;
    if (entryIndex !== undefined) this.entryIndex = entryIndex;
    Object.defineProperty(this, "cause", { configurable: true, value: undefined });
    Object.freeze(this);
  }
}

export function isOperatorAccessError(value: unknown): value is OperatorAccessError {
  return value instanceof OperatorAccessError;
}

/**
 * Logged when startup resolution fails with something that is not an
 * {@link OperatorAccessError}.  Never thrown by the validators themselves.
 */
export const OPERATOR_ACCESS_FALLBACK_CODE = "operator_access_failed";

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  ...OPERATOR_ACCESS_CONFIG_ERROR_CODES,
  ...OPERATOR_ACCESS_SYSTEM_ERROR_CODES,
]);

/**
 * The loggable facts of a startup failure: a closed code and, for the system
 * checks, the offending entry's index.  The code is recognised by shape rather
 * than `instanceof`, which a duplicated module instance would miss, and only a
 * member of the closed vocabulary is ever returned, so nothing else an error
 * carries can reach a log.
 */
export function describeOperatorAccessFailure(error: unknown): {
  readonly code: string;
  readonly entryIndex?: number;
} {
  const record: Record<string, unknown> =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code = record.code;
  if (typeof code !== "string" || !KNOWN_ERROR_CODES.has(code)) {
    return { code: OPERATOR_ACCESS_FALLBACK_CODE };
  }
  const index = record.entryIndex;
  return Number.isSafeInteger(index) && (index as number) >= 0
    ? { code, entryIndex: index as number }
    : { code };
}

// ---------------------------------------------------------------------------
// Config shape and structural validation.
// ---------------------------------------------------------------------------

export type OperatorAccessPrincipal =
  | { readonly group: string; readonly families: ReadonlyArray<OperatorFamily> }
  | { readonly user: string; readonly families: ReadonlyArray<OperatorFamily> };

export interface OperatorAccessConfig {
  readonly version: 1;
  readonly principals: ReadonlyArray<OperatorAccessPrincipal>;
}

/** Same grammar as the service-config group token: a POSIX portable name. */
export function isSafePrincipalToken(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 64 || name === "." || name === "..") return false;
  return /^[A-Za-z0-9_.+-]+$/.test(name);
}

/**
 * Validate the `operatorAccess` block and return a frozen copy.  Throws an
 * {@link OperatorAccessError}; never echoes a value.
 */
export function parseOperatorAccessConfig(value: unknown): OperatorAccessConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OperatorAccessError("operator_access_invalid_block");
  }
  const block = value as Record<string, unknown>;
  for (const key of Object.keys(block)) {
    if (key !== "version" && key !== "principals") {
      throw new OperatorAccessError("operator_access_unknown_key");
    }
  }
  if (block.version !== 1) throw new OperatorAccessError("operator_access_version");
  const rawPrincipals = block.principals;
  if (!Array.isArray(rawPrincipals)) {
    throw new OperatorAccessError("operator_access_principals_type");
  }
  if (rawPrincipals.length === 0) throw new OperatorAccessError("operator_access_principals_empty");

  const principals: OperatorAccessPrincipal[] = [];
  const seen = new Set<string>();
  const entries: unknown[] = Array.from(rawPrincipals);
  for (const raw of entries) {
    const principal = parsePrincipal(raw);
    const identity = "group" in principal ? `group:${principal.group}` : `user:${principal.user}`;
    if (seen.has(identity)) throw new OperatorAccessError("operator_access_principal_duplicate");
    seen.add(identity);
    principals.push(principal);
  }
  return Object.freeze({ version: 1, principals: Object.freeze(principals) });
}

function parsePrincipal(raw: unknown): OperatorAccessPrincipal {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OperatorAccessError("operator_access_principal_type");
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (key !== "user" && key !== "group" && key !== "families") {
      throw new OperatorAccessError("operator_access_unknown_key");
    }
  }
  const hasUser = Object.hasOwn(entry, "user");
  const hasGroup = Object.hasOwn(entry, "group");
  if (hasUser && hasGroup) throw new OperatorAccessError("operator_access_principal_both");
  if (!hasUser && !hasGroup) throw new OperatorAccessError("operator_access_principal_neither");
  const name = hasUser ? entry.user : entry.group;
  if (!isSafePrincipalToken(name)) throw new OperatorAccessError("operator_access_name_unsafe");

  const families = parseFamilies(entry.families);
  if (families.includes("admin") && !(hasGroup && name === OPERATOR_BASE_GROUP)) {
    throw new OperatorAccessError("operator_access_admin_not_base");
  }
  return Object.freeze(hasUser ? { user: name, families } : { group: name, families });
}

function parseFamilies(raw: unknown): ReadonlyArray<OperatorFamily> {
  if (!Array.isArray(raw)) throw new OperatorAccessError("operator_access_families_type");
  if (raw.length === 0) throw new OperatorAccessError("operator_access_families_empty");
  const families: OperatorFamily[] = [];
  for (const candidate of Array.from(raw) as unknown[]) {
    if (!isOperatorFamily(candidate)) {
      throw new OperatorAccessError("operator_access_family_unknown");
    }
    if (families.includes(candidate)) {
      throw new OperatorAccessError("operator_access_family_duplicate");
    }
    families.push(candidate);
  }
  return Object.freeze(families);
}

// ---------------------------------------------------------------------------
// Compiled policy.
// ---------------------------------------------------------------------------

/**
 * A principal after resolution: a group by name and gid, a user by uid.  A group
 * matches a peer by supplementary group name or by effective gid: the peer helper's
 * group list does not carry the name of the primary group, but the peer's gid is
 * kernel-attested.
 */
export type OperatorAccessSubject =
  | { readonly kind: "group"; readonly name: string; readonly gid: number }
  | { readonly kind: "user"; readonly uid: number };

/**
 * The gid recorded for a group that was never resolved (the implicit default
 * policy).  No peer has this gid, so such an entry matches by name alone, exactly
 * as the pre-`operatorAccess` check did.
 */
const UNRESOLVED_GID = -1;

export interface OperatorAccessEntry {
  readonly subject: OperatorAccessSubject;
  readonly families: ReadonlyArray<OperatorFamily>;
}

/**
 * The outcome of the principal gate.  `principalIndex` is the config position of
 * the first entry that grants the family; `viaBaseGroup` is true when the base
 * operator group's entry is among the entries that grant it.
 */
export interface OperatorAccessGrant {
  readonly granted: boolean;
  readonly principalIndex: number | undefined;
  readonly viaBaseGroup: boolean;
}

export interface OperatorAccessPolicy {
  readonly evaluate: (peer: OperatorPeer, family: OperatorFamily) => OperatorAccessGrant;
}

/** One audit record per principal-gate decision.  No ids, handles, titles or paths. */
export interface OperatorAccessAuditRecord {
  readonly principalIndex: number | null;
  readonly family: OperatorFamily | null;
}

const NOT_GRANTED: OperatorAccessGrant = Object.freeze({
  granted: false,
  principalIndex: undefined,
  viaBaseGroup: false,
});

/**
 * Compile resolved entries into the policy.  A peer's rights are the union of
 * every entry its uid or groups match; there are no deny entries.
 */
export function createOperatorAccessPolicy(
  entries: ReadonlyArray<OperatorAccessEntry>,
): OperatorAccessPolicy {
  const compiled = entries.map((entry, index) => ({
    index,
    subject: entry.subject,
    families: new Set<OperatorFamily>(entry.families),
    isBase: entry.subject.kind === "group" && entry.subject.name === OPERATOR_BASE_GROUP,
  }));
  const evaluate = (peer: OperatorPeer, family: OperatorFamily): OperatorAccessGrant => {
    let principalIndex: number | undefined;
    let viaBaseGroup = false;
    for (const entry of compiled) {
      if (!entry.families.has(family)) continue;
      const matches =
        entry.subject.kind === "group"
          ? peer.groups.includes(entry.subject.name) || peer.gid === entry.subject.gid
          : peer.uid === entry.subject.uid;
      if (!matches) continue;
      if (principalIndex === undefined) principalIndex = entry.index;
      if (entry.isBase) viaBaseGroup = true;
    }
    if (principalIndex === undefined) return NOT_GRANTED;
    return Object.freeze({ granted: true, principalIndex, viaBaseGroup });
  };
  return Object.freeze({ evaluate });
}

/**
 * The policy in force when `operatorAccess` is absent: one implicit principal,
 * the base operator group, holding every family.  This is today's behaviour.
 */
export function createDefaultOperatorAccessPolicy(): OperatorAccessPolicy {
  return createOperatorAccessPolicy([
    {
      subject: { kind: "group", name: OPERATOR_BASE_GROUP, gid: UNRESOLVED_GID },
      families: OPERATOR_FAMILIES,
    },
  ]);
}

/**
 * The implicit policy used when the config carries no `operatorAccess` block.
 *
 * It is the default above, except that the base group's gid is resolved when
 * the system database can supply it.  Without that, an operator account whose
 * effective group is `nookbridge-operators` would be admitted by name matching
 * alone and never match, leaving the whole operator surface refused with no
 * error - the same dead-surface failure an explicit block refuses to start on.
 * A lookup that fails falls back to name matching, which is the pre-change
 * behaviour.
 */
export async function createImplicitOperatorAccessPolicy(input: {
  readonly directory: PrincipalDirectory;
}): Promise<OperatorAccessPolicy> {
  let gid = UNRESOLVED_GID;
  try {
    const group = await input.directory.lookupGroup(OPERATOR_BASE_GROUP);
    if (group !== undefined) gid = group.gid;
  } catch {
    // A directory that cannot answer leaves name matching, as before.
  }
  return createOperatorAccessPolicy([
    {
      subject: { kind: "group", name: OPERATOR_BASE_GROUP, gid },
      families: OPERATOR_FAMILIES,
    },
  ]);
}

// ---------------------------------------------------------------------------
// System validation.
// ---------------------------------------------------------------------------

export interface PrincipalDirectoryUser {
  readonly uid: number;
  /** Names of every group the user belongs to, primary group included. */
  readonly groups: ReadonlyArray<string>;
}

export interface PrincipalDirectoryGroup {
  readonly gid: number;
  /** Names of every user in the group, primary-group members included. */
  readonly members: ReadonlyArray<string>;
}

/** The system user/group lookup.  Injectable so tests need no real accounts. */
export interface PrincipalDirectory {
  readonly lookupUser: (name: string) => Promise<PrincipalDirectoryUser | undefined>;
  readonly lookupGroup: (name: string) => Promise<PrincipalDirectoryGroup | undefined>;
}

export interface ResolveOperatorAccessInput {
  readonly config: OperatorAccessConfig;
  /**
   * The configured `socketGroup`, taken to be the group that owns the operator
   * socket.  That is an assumption, not something checked here: the socket is
   * created by the daemon and inherits its egid, and the packaged unit sets that
   * group to `socketGroup`.  A deployment that runs the daemon under another
   * primary group would make this reachability check disagree with the socket.
   */
  readonly socketGroup: string;
  /** The operator socket's mode; the group needs read and write on it. */
  readonly socketMode: number;
  /** The daemon's own uid.  A principal that resolves to it is refused. */
  readonly serviceUid: number | undefined;
  readonly directory: PrincipalDirectory;
}

/**
 * Resolve every principal through the system database and compile the policy.
 *
 * Refuses a principal that does not resolve, is root or the daemon's own
 * service user, or holds a grant that could never be used because the socket
 * would not admit it.  Throws an {@link OperatorAccessError}.
 */
export async function resolveOperatorAccess(
  input: ResolveOperatorAccessInput,
): Promise<OperatorAccessPolicy> {
  const socketAdmitsGroup = (input.socketMode & 0o060) === 0o060;
  const entries: OperatorAccessEntry[] = [];
  const principals = input.config.principals;
  for (let index = 0; index < principals.length; index += 1) {
    const principal = principals[index];
    if (principal === undefined) continue;
    if ("group" in principal) {
      const group = await lookup(() => input.directory.lookupGroup(principal.group));
      if (group === undefined) {
        throw new OperatorAccessError("operator_access_unresolved_principal", index);
      }
      if (group.gid === 0) {
        throw new OperatorAccessError("operator_access_privileged_principal", index);
      }
      const reachable =
        socketAdmitsGroup &&
        (principal.group === input.socketGroup ||
          (await anyMemberInGroup(input.directory, group.members, input.socketGroup)));
      if (!reachable) throw new OperatorAccessError("operator_access_unreachable_principal", index);
      entries.push({
        subject: { kind: "group", name: principal.group, gid: group.gid },
        families: principal.families,
      });
      continue;
    }
    const user = await lookup(() => input.directory.lookupUser(principal.user));
    if (user === undefined) {
      throw new OperatorAccessError("operator_access_unresolved_principal", index);
    }
    if (user.uid === 0 || user.uid === input.serviceUid) {
      throw new OperatorAccessError("operator_access_privileged_principal", index);
    }
    if (!socketAdmitsGroup || !user.groups.includes(input.socketGroup)) {
      throw new OperatorAccessError("operator_access_unreachable_principal", index);
    }
    entries.push({ subject: { kind: "user", uid: user.uid }, families: principal.families });
  }
  return createOperatorAccessPolicy(entries);
}

/** A directory that throws is an unresolved principal, never an escaping cause. */
async function lookup<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

async function anyMemberInGroup(
  directory: PrincipalDirectory,
  members: ReadonlyArray<string>,
  socketGroup: string,
): Promise<boolean> {
  for (const member of members) {
    const user = await lookup(() => directory.lookupUser(member));
    if (user?.groups.includes(socketGroup) === true) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Production directory: /etc/passwd and /etc/group.
// ---------------------------------------------------------------------------

const MAX_DIRECTORY_FILE_BYTES = 1024 * 1024;
const NUMERIC_FIELD = /^[0-9]+$/;

interface PasswdRecord {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
}

interface GroupRecord {
  readonly name: string;
  readonly gid: number;
  readonly members: ReadonlyArray<string>;
}

/**
 * The production directory.  It reads the local files directly: no subprocess,
 * no symlink following, a hard size cap.  Accounts that exist only through NSS
 * are unsupported, so startup fails closed for them.
 */
export function createSystemPrincipalDirectory(
  files: { readonly passwd: string; readonly group: string } = {
    passwd: "/etc/passwd",
    group: "/etc/group",
  },
): PrincipalDirectory {
  // Each file is read and parsed once per directory instance.  The directory is
  // built for a single startup validation, so a snapshot is the right lifetime;
  // a failed read is cached too, so every lookup then fails the same way.
  let passwdRecords: Promise<PasswdRecord[]> | undefined;
  let groupRecords: Promise<GroupRecord[]> | undefined;
  const readPasswd = (): Promise<PasswdRecord[]> => {
    passwdRecords ??= (async () => {
      const records: PasswdRecord[] = [];
      for (const fields of await readColonFile(files.passwd)) {
        const [name, , uidField, gidField] = fields;
        if (name === undefined || uidField === undefined || gidField === undefined) continue;
        if (!NUMERIC_FIELD.test(uidField) || !NUMERIC_FIELD.test(gidField)) continue;
        records.push({ name, uid: Number(uidField), gid: Number(gidField) });
      }
      return records;
    })();
    return passwdRecords;
  };
  const readGroups = (): Promise<GroupRecord[]> => {
    groupRecords ??= (async () => {
      const records: GroupRecord[] = [];
      for (const fields of await readColonFile(files.group)) {
        const [name, , gidField, memberField] = fields;
        if (name === undefined || gidField === undefined || !NUMERIC_FIELD.test(gidField)) continue;
        const members = (memberField ?? "").split(",").filter((member) => member.length > 0);
        records.push({ name, gid: Number(gidField), members });
      }
      return records;
    })();
    return groupRecords;
  };
  return Object.freeze({
    lookupUser: async (name: string): Promise<PrincipalDirectoryUser | undefined> => {
      const user = (await readPasswd()).find((record) => record.name === name);
      if (user === undefined) return undefined;
      const groups = (await readGroups())
        .filter((group) => group.gid === user.gid || group.members.includes(name))
        .map((group) => group.name);
      return { uid: user.uid, groups };
    },
    lookupGroup: async (name: string): Promise<PrincipalDirectoryGroup | undefined> => {
      const group = (await readGroups()).find((record) => record.name === name);
      if (group === undefined) return undefined;
      const primary = (await readPasswd())
        .filter((record) => record.gid === group.gid)
        .map((record) => record.name);
      return { gid: group.gid, members: [...new Set([...group.members, ...primary])] };
    },
  });
}

async function readColonFile(path: string): Promise<string[][]> {
  // O_NOFOLLOW makes a symlinked final component fail instead of resolving.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_DIRECTORY_FILE_BYTES) {
      throw new Error("directory file is unusable");
    }
    // Read one byte past the cap so a file that grew after the stat is rejected.
    const buffer = Buffer.alloc(MAX_DIRECTORY_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_DIRECTORY_FILE_BYTES) throw new Error("directory file is unusable");
    return buffer
      .toString("utf8", 0, total)
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split(":"));
  } finally {
    await handle.close();
  }
}
