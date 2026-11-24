/**
 * Per-principal operator access: the family table, startup validation, and the
 * compiled policy.
 *
 * Every validation test puts a canary in the offending input and asserts both
 * the closed code and that the canary never reaches the error message or the
 * serialised error.
 */

import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadServiceConfig } from "../src/config/service-config.js";
import {
  OPERATOR_ACCESS_CONFIG_ERROR_CODES,
  OPERATOR_ACCESS_FALLBACK_CODE,
  OPERATOR_ACCESS_SYSTEM_ERROR_CODES,
  OPERATOR_BASE_GROUP,
  OPERATOR_FAMILIES,
  OPERATOR_METHOD_FAMILY,
  createDefaultOperatorAccessPolicy,
  createImplicitOperatorAccessPolicy,
  createOperatorAccessPolicy,
  createSystemPrincipalDirectory,
  describeOperatorAccessFailure,
  isOperatorAccessError,
  operatorMethodFamily,
  parseOperatorAccessConfig,
  resolveOperatorAccess,
  type OperatorAccessErrorCode,
  type OperatorFamily,
  type PrincipalDirectory,
} from "../src/service/operator-capabilities.js";
import {
  OPERATOR_DISCOVERY_METHODS,
  OPERATOR_METHODS,
  OPERATOR_TRANSPORT_METHODS,
  type OperatorMethod,
} from "../src/service/operator-methods.js";
import type { OperatorPeer } from "../src/service/operator-server.js";
import {
  DEFAULT_OPERATOR_SOCKET_MODE,
  validateSocketMode,
} from "../src/service/operator-socket-server.js";

const CANARY = "CANARY-7f3a91";

// ---------------------------------------------------------------------------
// 1. Exhaustiveness.
// ---------------------------------------------------------------------------

// Compile-time: the table must stay total over the vocabulary.  Loosening its
// type to a Partial or an index signature makes this assignment fail to compile.
const _tableIsTotal: Record<OperatorMethod, OperatorFamily> = OPERATOR_METHOD_FAMILY;
void _tableIsTotal;

// Compile-time: a literal that omits a method is not a valid table.  This is the
// mechanism that makes an unclassified method a build error.
// @ts-expect-error - "notes.browse" is the only key; the rest are missing.
const _incompleteTable: Record<OperatorMethod, OperatorFamily> = { "notes.browse": "discover" };
void _incompleteTable;

describe("operator method families", () => {
  it("classifies every operator method in exactly one family", () => {
    const vocabulary = [...OPERATOR_METHODS, ...OPERATOR_DISCOVERY_METHODS];
    expect([...OPERATOR_TRANSPORT_METHODS].sort()).toEqual([...vocabulary].sort());
    for (const method of OPERATOR_TRANSPORT_METHODS) {
      const family = operatorMethodFamily(method);
      expect(family, `unclassified method`).toBeDefined();
      expect(OPERATOR_FAMILIES).toContain(family);
      // A key holds one value, so "exactly one" is the key being present once.
      expect(Object.keys(OPERATOR_METHOD_FAMILY).filter((key) => key === method)).toHaveLength(1);
    }
  });

  it("has no entry for a method outside the vocabulary", () => {
    expect(Object.keys(OPERATOR_METHOD_FAMILY).sort()).toEqual(
      [...OPERATOR_TRANSPORT_METHODS].sort(),
    );
  });

  it("detects a method removed from the table", () => {
    // The shape of the check above, run against a table with one method removed:
    // it must report that method as unclassified.
    const { "notes.apply-edit": _removed, ...without } = OPERATOR_METHOD_FAMILY;
    const unclassified = OPERATOR_TRANSPORT_METHODS.filter(
      (method) => !Object.hasOwn(without, method),
    );
    expect(unclassified).toEqual(["notes.apply-edit"]);
  });

  it("pins the classification the design agreed", () => {
    const byFamily = (family: OperatorFamily): string[] =>
      OPERATOR_TRANSPORT_METHODS.filter(
        (method) => OPERATOR_METHOD_FAMILY[method] === family,
      ).sort();
    expect(byFamily("discover")).toEqual(
      [
        "notes.browse",
        "notes.search-operator",
        "notes.operation-status",
        "notes.operation-list",
      ].sort(),
    );
    expect(byFamily("read")).toEqual(
      ["notes.get-view", "notes.edit-preimage", "notes.inspect-conflict"].sort(),
    );
    expect(byFamily("write")).toEqual(
      ["notes.create", "notes.apply-edit", "notes.apply-undo"].sort(),
    );
    expect(byFamily("conflict")).toEqual(
      ["notes.resolve-conflict", "notes.abandon-resolve"].sort(),
    );
    expect(byFamily("admin")).toEqual(
      ["notes.approve-upload", "notes.path_diagnostic", "notes.edit-census"].sort(),
    );
  });

  it("answers undefined for anything that is not an operator method", () => {
    for (const value of ["constructor", "__proto__", "notes.nope", "", 7, null, undefined]) {
      expect(operatorMethodFamily(value)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Structural validation: one test per condition.
// ---------------------------------------------------------------------------

const ok = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  principals: [{ group: OPERATOR_BASE_GROUP, families: ["discover"] }],
  ...extra,
});
const withEntry = (entry: unknown) => ({ version: 1, principals: [entry] });

/** Every code a validation test has actually provoked; checked at the end of the file. */
const exercised = new Set<string>();

/** Assert the refusal code, and that no canary reaches the error's text. */
function expectRefusal(run: () => unknown, code: OperatorAccessErrorCode): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(isOperatorAccessError(thrown), "expected an OperatorAccessError").toBe(true);
  const error = thrown as { code: string; message: string };
  expect(error.code).toBe(code);
  exercised.add(error.code);
  const own = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown));
  const everything = `${error.message} ${own}`;
  expect(everything).not.toContain(CANARY);
  expect(everything).not.toContain(CANARY.toLowerCase());
}

describe("operatorAccess structural validation", () => {
  it("accepts the documented example", () => {
    const parsed = parseOperatorAccessConfig({
      version: 1,
      principals: [
        {
          group: "nookbridge-operators",
          families: ["discover", "read", "write", "conflict", "admin"],
        },
        { user: "hermes", families: ["discover"] },
      ],
    });
    expect(parsed.principals).toHaveLength(2);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("refuses a block that is not an object", () => {
    expectRefusal(() => parseOperatorAccessConfig(CANARY), "operator_access_invalid_block");
    expectRefusal(() => parseOperatorAccessConfig([CANARY]), "operator_access_invalid_block");
    expectRefusal(() => parseOperatorAccessConfig(null), "operator_access_invalid_block");
  });

  it("refuses an unknown top-level key", () => {
    expectRefusal(
      () => parseOperatorAccessConfig(ok({ [CANARY]: true })),
      "operator_access_unknown_key",
    );
  });

  it("refuses an unknown key inside an entry", () => {
    expectRefusal(
      () =>
        parseOperatorAccessConfig(
          withEntry({ group: "g", families: ["discover"], [CANARY]: "deny" }),
        ),
      "operator_access_unknown_key",
    );
  });

  it("refuses a version other than 1", () => {
    for (const version of [2, 0, "1", CANARY, undefined]) {
      expectRefusal(
        () => parseOperatorAccessConfig({ ...ok(), version }),
        "operator_access_version",
      );
    }
  });

  it("refuses principals that is not an array", () => {
    expectRefusal(
      () => parseOperatorAccessConfig({ version: 1, principals: CANARY }),
      "operator_access_principals_type",
    );
    expectRefusal(
      () => parseOperatorAccessConfig({ version: 1, principals: { [CANARY]: 1 } }),
      "operator_access_principals_type",
    );
  });

  it("refuses an empty principals list", () => {
    expectRefusal(
      () => parseOperatorAccessConfig({ version: 1, principals: [] }),
      "operator_access_principals_empty",
    );
  });

  it("refuses an entry that is not an object", () => {
    expectRefusal(
      () => parseOperatorAccessConfig(withEntry(CANARY)),
      "operator_access_principal_type",
    );
    expectRefusal(
      () => parseOperatorAccessConfig(withEntry(null)),
      "operator_access_principal_type",
    );
  });

  it("refuses an entry naming both a user and a group", () => {
    expectRefusal(
      () =>
        parseOperatorAccessConfig(withEntry({ user: CANARY, group: CANARY, families: ["read"] })),
      "operator_access_principal_both",
    );
  });

  it("refuses an entry naming neither a user nor a group", () => {
    expectRefusal(
      () => parseOperatorAccessConfig(withEntry({ families: ["read"] })),
      "operator_access_principal_neither",
    );
  });

  it("refuses a name that is not a safe token", () => {
    for (const name of [`${CANARY}/../x`, `bad ${CANARY}`, "", ".", "..", 7, `${CANARY}\n`]) {
      expectRefusal(
        () => parseOperatorAccessConfig(withEntry({ user: name, families: ["read"] })),
        "operator_access_name_unsafe",
      );
      expectRefusal(
        () => parseOperatorAccessConfig(withEntry({ group: name, families: ["read"] })),
        "operator_access_name_unsafe",
      );
    }
    expectRefusal(
      () => parseOperatorAccessConfig(withEntry({ user: "a".repeat(65), families: ["read"] })),
      "operator_access_name_unsafe",
    );
  });

  it("refuses a principal that appears twice", () => {
    expectRefusal(
      () =>
        parseOperatorAccessConfig({
          version: 1,
          principals: [
            { group: "canary-dup", families: ["read"] },
            { group: "canary-dup", families: ["discover"] },
          ],
        }),
      "operator_access_principal_duplicate",
    );
    expectRefusal(
      () =>
        parseOperatorAccessConfig({
          version: 1,
          principals: [
            { user: CANARY.toLowerCase(), families: ["read"] },
            { user: CANARY.toLowerCase(), families: ["read"] },
          ],
        }),
      "operator_access_principal_duplicate",
    );
  });

  it("treats a user and a group of the same name as distinct principals", () => {
    const parsed = parseOperatorAccessConfig({
      version: 1,
      principals: [
        { user: "ops", families: ["read"] },
        { group: "ops", families: ["read"] },
      ],
    });
    expect(parsed.principals).toHaveLength(2);
  });

  it("refuses families that is not an array", () => {
    expectRefusal(
      () => parseOperatorAccessConfig(withEntry({ group: "g", families: CANARY })),
      "operator_access_families_type",
    );
    expectRefusal(
      () => parseOperatorAccessConfig(withEntry({ group: "g" })),
      "operator_access_families_type",
    );
  });

  it("refuses an empty families list", () => {
    expectRefusal(
      () => parseOperatorAccessConfig(withEntry({ group: "g", families: [] })),
      "operator_access_families_empty",
    );
  });

  it("refuses an unknown family", () => {
    for (const family of [CANARY, "Read", "all", "", 3]) {
      expectRefusal(
        () => parseOperatorAccessConfig(withEntry({ group: "g", families: ["read", family] })),
        "operator_access_family_unknown",
      );
    }
  });

  it("refuses a repeated family", () => {
    expectRefusal(
      () =>
        parseOperatorAccessConfig(withEntry({ group: "g", families: ["read", "write", "read"] })),
      "operator_access_family_duplicate",
    );
  });

  it("refuses admin for any principal but the base group", () => {
    expectRefusal(
      () => parseOperatorAccessConfig(withEntry({ group: "canary-g", families: ["admin"] })),
      "operator_access_admin_not_base",
    );
    expectRefusal(
      () => parseOperatorAccessConfig(withEntry({ user: "canary-u", families: ["read", "admin"] })),
      "operator_access_admin_not_base",
    );
    // A user that happens to share the base group's name is not the base group.
    expectRefusal(
      () =>
        parseOperatorAccessConfig(withEntry({ user: OPERATOR_BASE_GROUP, families: ["admin"] })),
      "operator_access_admin_not_base",
    );
  });

  it("grants admin to the base group", () => {
    expect(() =>
      parseOperatorAccessConfig(withEntry({ group: OPERATOR_BASE_GROUP, families: ["admin"] })),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The same refusals through the service-config loader.
// ---------------------------------------------------------------------------

describe("operatorAccess through loadServiceConfig", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "nookbridge-operator-access-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const BASE = {
    stateDir: "/var/lib/nookbridge",
    socketPath: "/run/nookbridge/nookbridge.sock",
    socketGroup: "nookbridge-clients",
    backend: "systemd-credential",
    credentialName: "nookbridge-db-key",
    readPolicy: ["notes.search", "notes.status", "notes.list_notebooks", "notes.get"],
  };
  // Hermetic root-owned stat, as in the stage-5 service-config suite.
  const seam = {
    stat: (path: string) => {
      const real = lstatSync(path);
      return real.isDirectory()
        ? { uid: 0, gid: 0, mode: 0o040755, dev: real.dev, ino: real.ino }
        : { uid: 0, gid: 0, mode: real.mode, dev: real.dev, ino: real.ino };
    },
  };

  function load(name: string, payload: unknown) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
    return loadServiceConfig(file, seam);
  }

  it("is absent by default", () => {
    const result = load("absent", BASE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.operatorAccess).toBeUndefined();
  });

  it("carries a valid block through", () => {
    const result = load("valid", { ...BASE, operatorAccess: ok() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.operatorAccess?.principals).toHaveLength(1);
  });

  it("refuses with the block's own closed code and never echoes the value", () => {
    const result = load("bad", {
      ...BASE,
      operatorAccess: withEntry({ group: "g", families: [CANARY] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("operator_access_family_unknown");
      expect(result.error.message).not.toContain(CANARY);
    }
  });

  it("refuses a non-object block", () => {
    const result = load("null-block", { ...BASE, operatorAccess: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("operator_access_invalid_block");
  });
});

// ---------------------------------------------------------------------------
// System validation.
// ---------------------------------------------------------------------------

const SOCKET_GROUP = "nookbridge-clients";
const SERVICE_UID = 990;

const USERS: Record<string, { uid: number; groups: string[] }> = {
  hermes: { uid: 1001, groups: ["hermes", SOCKET_GROUP] },
  nookop: { uid: 1002, groups: ["nookop", SOCKET_GROUP, OPERATOR_BASE_GROUP] },
  "canary-outsider": { uid: 1004, groups: ["canary-outsider"] },
  "canary-root": { uid: 0, groups: ["root", SOCKET_GROUP] },
  "canary-service": { uid: SERVICE_UID, groups: ["nookbridge", SOCKET_GROUP] },
};
const GROUPS: Record<string, { gid: number; members: string[] }> = {
  [SOCKET_GROUP]: { gid: 500, members: ["hermes", "nookop", "canary-root", "canary-service"] },
  [OPERATOR_BASE_GROUP]: { gid: 501, members: ["nookop"] },
  "canary-shared": { gid: 601, members: ["hermes"] },
  "canary-lonely": { gid: 602, members: ["canary-outsider"] },
  "canary-rootgroup": { gid: 0, members: [] },
};
const directory: PrincipalDirectory = {
  lookupUser: async (name) => USERS[name],
  lookupGroup: async (name) => GROUPS[name],
};

async function resolve(
  principals: unknown[],
  overrides: Partial<Parameters<typeof resolveOperatorAccess>[0]> = {},
) {
  return resolveOperatorAccess({
    config: parseOperatorAccessConfig({ version: 1, principals }),
    socketGroup: SOCKET_GROUP,
    socketMode: 0o660,
    serviceUid: SERVICE_UID,
    directory,
    ...overrides,
  });
}

async function expectSystemRefusal(
  run: () => Promise<unknown>,
  code: OperatorAccessErrorCode,
  entryIndex = 0,
): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(isOperatorAccessError(thrown), "expected an OperatorAccessError").toBe(true);
  const error = thrown as { code: string; message: string; entryIndex?: number };
  expect(error.code).toBe(code);
  // Every system refusal names the offending entry by position, and only that.
  expect(error.entryIndex).toBe(entryIndex);
  exercised.add(error.code);
  const own = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown));
  const everything = `${error.message} ${own}`;
  for (const secret of [CANARY, "canary-", "1004", String(SERVICE_UID)]) {
    expect(everything).not.toContain(secret);
  }
}

describe("operatorAccess system validation", () => {
  it("accepts principals that resolve and can reach the socket", async () => {
    await expect(
      resolve([
        {
          group: OPERATOR_BASE_GROUP,
          families: ["discover", "read", "write", "conflict", "admin"],
        },
        { user: "hermes", families: ["discover"] },
        { group: SOCKET_GROUP, families: ["discover"] },
        { group: "canary-shared", families: ["read"] },
      ]),
    ).resolves.toBeDefined();
  });

  it("refuses a user that does not resolve", async () => {
    await expectSystemRefusal(
      () => resolve([{ user: "canary-ghost", families: ["read"] }]),
      "operator_access_unresolved_principal",
    );
  });

  it("refuses a group that does not resolve", async () => {
    await expectSystemRefusal(
      () => resolve([{ group: "canary-ghost", families: ["read"] }]),
      "operator_access_unresolved_principal",
    );
  });

  it("treats a lookup that throws as unresolved, without echoing its cause", async () => {
    const throwing: PrincipalDirectory = {
      lookupUser: async () => {
        throw new Error(`${CANARY} /etc/passwd`);
      },
      lookupGroup: async () => {
        throw new Error(`${CANARY} /etc/group`);
      },
    };
    await expectSystemRefusal(
      () => resolve([{ user: "hermes", families: ["read"] }], { directory: throwing }),
      "operator_access_unresolved_principal",
    );
    await expectSystemRefusal(
      () => resolve([{ group: "canary-shared", families: ["read"] }], { directory: throwing }),
      "operator_access_unresolved_principal",
    );
  });

  it("refuses a user whose uid is 0", async () => {
    await expectSystemRefusal(
      () => resolve([{ user: "canary-root", families: ["read"] }]),
      "operator_access_privileged_principal",
    );
  });

  it("refuses the daemon's own service user", async () => {
    await expectSystemRefusal(
      () => resolve([{ user: "canary-service", families: ["read"] }]),
      "operator_access_privileged_principal",
    );
  });

  it("accepts that same user once it is no longer the service uid", async () => {
    // Negative control: the refusal above is attributable to the service uid.
    await expect(
      resolve([{ user: "canary-service", families: ["read"] }], { serviceUid: 12345 }),
    ).resolves.toBeDefined();
  });

  it("refuses a group whose gid is 0", async () => {
    await expectSystemRefusal(
      () => resolve([{ group: "canary-rootgroup", families: ["read"] }]),
      "operator_access_privileged_principal",
    );
  });

  it("refuses a grant to a user outside the socket group", async () => {
    await expectSystemRefusal(
      () => resolve([{ user: "canary-outsider", families: ["read"] }]),
      "operator_access_unreachable_principal",
    );
  });

  it("refuses a grant to a group no socket-group member belongs to", async () => {
    await expectSystemRefusal(
      () => resolve([{ group: "canary-lonely", families: ["read"] }]),
      "operator_access_unreachable_principal",
    );
  });

  it("refuses a grant the socket mode would not admit", async () => {
    await expectSystemRefusal(
      () => resolve([{ user: "hermes", families: ["read"] }], { socketMode: 0o600 }),
      "operator_access_unreachable_principal",
    );
    // Negative control: the same grant is accepted at the real mode.
    await expect(
      resolve([{ user: "hermes", families: ["read"] }], { socketMode: 0o770 }),
    ).resolves.toBeDefined();
  });

  it("stops at the first refused principal", async () => {
    await expectSystemRefusal(
      () =>
        resolve([
          { user: "hermes", families: ["read"] },
          { user: "canary-outsider", families: ["read"] },
        ]),
      "operator_access_unreachable_principal",
      1,
    );
  });

  it("reports the index of an unreachable group entry", async () => {
    await expectSystemRefusal(
      () =>
        resolve([
          { group: OPERATOR_BASE_GROUP, families: ["read"] },
          { user: "hermes", families: ["read"] },
          { group: "canary-lonely", families: ["read"] },
        ]),
      "operator_access_unreachable_principal",
      2,
    );
  });

  it("gives a structural refusal no entry index", () => {
    const thrown = (() => {
      try {
        parseOperatorAccessConfig({ version: 1, principals: [{ group: "g" }] });
      } catch (error) {
        return error as { entryIndex?: number };
      }
      return undefined;
    })();
    expect(thrown).toBeDefined();
    expect(thrown?.entryIndex).toBeUndefined();
  });
});

describe("describeOperatorAccessFailure", () => {
  it("keeps the code and index of an error from another module instance", () => {
    // Same shape, different class: what a duplicated module would throw.
    const lookalike = Object.assign(new Error("x"), {
      code: "operator_access_unreachable_principal",
      entryIndex: 3,
    });
    expect(describeOperatorAccessFailure(lookalike)).toEqual({
      code: "operator_access_unreachable_principal",
      entryIndex: 3,
    });
  });

  it("omits the index when the error carries none", () => {
    expect(describeOperatorAccessFailure({ code: "operator_access_unresolved_principal" })).toEqual(
      { code: "operator_access_unresolved_principal" },
    );
  });

  it("falls back to the distinct code for anything outside the closed vocabulary", () => {
    for (const value of [
      new Error(CANARY),
      { code: CANARY, entryIndex: 1 },
      { code: 42 },
      null,
      undefined,
      CANARY,
    ]) {
      const described = describeOperatorAccessFailure(value);
      expect(described).toEqual({ code: OPERATOR_ACCESS_FALLBACK_CODE });
      expect(JSON.stringify(described)).not.toContain(CANARY);
    }
    expect(OPERATOR_ACCESS_FALLBACK_CODE).toBe("operator_access_failed");
    const all: readonly string[] = [
      ...OPERATOR_ACCESS_CONFIG_ERROR_CODES,
      ...OPERATOR_ACCESS_SYSTEM_ERROR_CODES,
    ];
    expect(all).not.toContain(OPERATOR_ACCESS_FALLBACK_CODE);
  });

  it("ignores an index that is not a small non-negative integer", () => {
    for (const entryIndex of [-1, 1.5, Number.NaN, "2", Number.MAX_SAFE_INTEGER + 2]) {
      expect(
        describeOperatorAccessFailure({ code: "operator_access_family_unknown", entryIndex }),
      ).toEqual({ code: "operator_access_family_unknown" });
    }
  });
});

describe("operator socket mode", () => {
  it("shares one default and one validator with the socket server", () => {
    expect(DEFAULT_OPERATOR_SOCKET_MODE).toBe(0o660);
    expect(validateSocketMode(DEFAULT_OPERATOR_SOCKET_MODE)).toBe(0o660);
    expect(validateSocketMode(0o770)).toBe(0o770);
    for (const mode of [0o600, 0o666, 0o777, 0o640]) {
      expect(() => validateSocketMode(mode)).toThrow();
    }
  });
});

describe("system principal directory", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nookbridge-operator-dir-"));
    writeFileSync(
      join(dir, "passwd"),
      [
        "# comment",
        "root:x:0:0::/root:/bin/sh",
        "hermes:x:1001:1001::/home/hermes:/bin/sh",
        "malformed",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "group"),
      ["root:x:0:", "hermes:x:1001:", "nookbridge-clients:x:500:hermes", "empty:x:700:"].join("\n"),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const files = () => ({ passwd: join(dir, "passwd"), group: join(dir, "group") });

  it("resolves a user with its primary and supplementary groups", async () => {
    const found = await createSystemPrincipalDirectory(files()).lookupUser("hermes");
    expect(found?.uid).toBe(1001);
    expect([...(found?.groups ?? [])].sort()).toEqual(["hermes", "nookbridge-clients"]);
  });

  it("resolves a group with its members, primary-group members included", async () => {
    const found = await createSystemPrincipalDirectory(files()).lookupGroup("hermes");
    expect(found).toEqual({ gid: 1001, members: ["hermes"] });
    const clients = await createSystemPrincipalDirectory(files()).lookupGroup("nookbridge-clients");
    expect(clients).toEqual({ gid: 500, members: ["hermes"] });
  });

  it("answers undefined for an unknown name and rejects a missing file", async () => {
    const directory = createSystemPrincipalDirectory(files());
    await expect(directory.lookupUser("nobody-here")).resolves.toBeUndefined();
    await expect(directory.lookupGroup("nobody-here")).resolves.toBeUndefined();
    const missing = createSystemPrincipalDirectory({
      passwd: join(dir, "x"),
      group: join(dir, "y"),
    });
    await expect(missing.lookupUser("hermes")).rejects.toBeDefined();
  });

  it("reads each file once per instance, however many lookups follow", async () => {
    const passwd = join(dir, "passwd-snapshot");
    const group = join(dir, "group-snapshot");
    writeFileSync(passwd, "hermes:x:1001:1001::/home/hermes:/bin/sh\n");
    writeFileSync(group, "hermes:x:1001:\nteam:x:800:hermes\n");
    const snapshot = createSystemPrincipalDirectory({ passwd, group });
    await expect(snapshot.lookupUser("hermes")).resolves.toBeDefined();
    // The files change after the first lookup; this instance does not see it...
    writeFileSync(
      passwd,
      "hermes:x:1001:1001::/home/hermes:/bin/sh\nlate:x:1500:1500::/:/bin/sh\n",
    );
    writeFileSync(group, "hermes:x:1001:\nteam:x:800:hermes\nlate:x:1500:\n");
    await expect(snapshot.lookupUser("late")).resolves.toBeUndefined();
    await expect(snapshot.lookupGroup("late")).resolves.toBeUndefined();
    // ...and the members of a group still resolve from the cached records.
    await expect(snapshot.lookupGroup("team")).resolves.toEqual({
      gid: 800,
      members: ["hermes"],
    });
    // A new instance reads the current files (control: the snapshot is per instance).
    const fresh = createSystemPrincipalDirectory({ passwd, group });
    await expect(fresh.lookupUser("late")).resolves.toMatchObject({ uid: 1500 });
  });
});

// ---------------------------------------------------------------------------
// The compiled policy.
// ---------------------------------------------------------------------------

const peer = (uid: number, groups: string[]): OperatorPeer => ({ uid, gid: 1, groups });
/** A gid no `peer(...)` above carries, so a base entry matches by name there. */
const BASE_GID = 5000;

describe("operator access policy", () => {
  it("defaults to the base group holding every family", () => {
    const policy = createDefaultOperatorAccessPolicy();
    for (const family of OPERATOR_FAMILIES) {
      expect(policy.evaluate(peer(1, [OPERATOR_BASE_GROUP]), family)).toEqual({
        granted: true,
        principalIndex: 0,
        viaBaseGroup: true,
      });
      expect(policy.evaluate(peer(1, [SOCKET_GROUP]), family).granted).toBe(false);
      expect(policy.evaluate(peer(1, []), family).granted).toBe(false);
    }
  });

  it("denies by default: a peer matching no entry holds nothing", () => {
    const policy = createOperatorAccessPolicy([
      { subject: { kind: "user", uid: 1001 }, families: ["discover"] },
    ]);
    expect(policy.evaluate(peer(1001, []), "read").granted).toBe(false);
    expect(policy.evaluate(peer(2002, [OPERATOR_BASE_GROUP]), "discover").granted).toBe(false);
  });

  it("matches a user by uid and a group by name", () => {
    const policy = createOperatorAccessPolicy([
      { subject: { kind: "user", uid: 1001 }, families: ["discover"] },
      { subject: { kind: "group", name: "team", gid: 7001 }, families: ["read"] },
    ]);
    expect(policy.evaluate(peer(1001, []), "discover")).toMatchObject({
      granted: true,
      principalIndex: 0,
      viaBaseGroup: false,
    });
    expect(policy.evaluate(peer(5, ["team"]), "read")).toMatchObject({
      granted: true,
      principalIndex: 1,
    });
    expect(policy.evaluate(peer(5, ["team"]), "discover").granted).toBe(false);
  });

  it("grants the union of every entry the peer matches, with no deny entries", () => {
    const policy = createOperatorAccessPolicy([
      { subject: { kind: "group", name: "a", gid: 7002 }, families: ["discover"] },
      { subject: { kind: "user", uid: 7 }, families: ["read"] },
      { subject: { kind: "group", name: "b", gid: 7003 }, families: ["discover", "write"] },
    ]);
    const both = peer(7, ["a", "b"]);
    for (const family of ["discover", "read", "write"] as const) {
      expect(policy.evaluate(both, family).granted).toBe(true);
    }
    expect(policy.evaluate(both, "conflict").granted).toBe(false);
    // The first entry that grants the family is the one recorded.
    expect(policy.evaluate(both, "discover").principalIndex).toBe(0);
    expect(policy.evaluate(peer(7, ["b"]), "discover").principalIndex).toBe(2);
  });

  it("reports base-group provenance only when the base entry grants the family", () => {
    const policy = createOperatorAccessPolicy([
      {
        subject: { kind: "group", name: OPERATOR_BASE_GROUP, gid: BASE_GID },
        families: ["read"],
      },
      { subject: { kind: "user", uid: 7 }, families: ["read", "write"] },
    ]);
    const member = peer(7, [OPERATOR_BASE_GROUP]);
    expect(policy.evaluate(member, "read").viaBaseGroup).toBe(true);
    // Write is granted to the peer, but by the user entry, not the base group.
    expect(policy.evaluate(member, "write")).toMatchObject({ granted: true, viaBaseGroup: false });
  });

  describe("primary-group match", () => {
    const policy = createOperatorAccessPolicy([
      {
        subject: { kind: "group", name: OPERATOR_BASE_GROUP, gid: BASE_GID },
        families: ["read", "admin"],
      },
    ]);

    it("grants a peer whose gid is the group's though its group list omits it", () => {
      // The peer helper's group list does not name the primary group.
      const primary: OperatorPeer = { uid: 40, gid: BASE_GID, groups: [SOCKET_GROUP] };
      expect(policy.evaluate(primary, "read")).toEqual({
        granted: true,
        principalIndex: 0,
        viaBaseGroup: true,
      });
      expect(policy.evaluate(primary, "admin").granted).toBe(true);
    });

    it("does not grant a peer with neither the group name nor the gid (control)", () => {
      const other: OperatorPeer = { uid: 40, gid: BASE_GID + 1, groups: [SOCKET_GROUP] };
      expect(policy.evaluate(other, "read").granted).toBe(false);
    });

    it("carries the resolved gid from the system database into the policy", async () => {
      const resolved = await resolve([{ group: OPERATOR_BASE_GROUP, families: ["read"] }]);
      const gid = GROUPS[OPERATOR_BASE_GROUP]?.gid ?? -2;
      expect(resolved.evaluate({ uid: 40, gid, groups: [] }, "read")).toMatchObject({
        granted: true,
        viaBaseGroup: true,
      });
      expect(resolved.evaluate({ uid: 40, gid: gid + 1, groups: [] }, "read").granted).toBe(false);
    });

    it("leaves the implicit default matching by name alone", () => {
      const implicit = createDefaultOperatorAccessPolicy();
      // -1 is the unresolved-gid sentinel; no real peer carries it, but the
      // default must not grant on any gid at all.
      expect(implicit.evaluate({ uid: 40, gid: BASE_GID, groups: [] }, "read").granted).toBe(false);
    });

    it("resolves the base gid for the implicit policy so a primary-group operator matches", async () => {
      const implicit = await createImplicitOperatorAccessPolicy({ directory });
      const baseGid = GROUPS[OPERATOR_BASE_GROUP]?.gid ?? -2;
      expect(implicit.evaluate({ uid: 40, gid: baseGid, groups: [SOCKET_GROUP] }, "read")).toEqual({
        granted: true,
        principalIndex: 0,
        viaBaseGroup: true,
      });
    });

    it("falls back to name matching when the base group cannot be resolved", async () => {
      const implicit = await createImplicitOperatorAccessPolicy({
        directory: {
          ...directory,
          lookupGroup: async (): Promise<undefined> => undefined,
        },
      });
      expect(implicit.evaluate({ uid: 40, gid: BASE_GID, groups: [] }, "read").granted).toBe(false);
      expect(
        implicit.evaluate({ uid: 40, gid: 1, groups: [OPERATOR_BASE_GROUP] }, "read"),
      ).toMatchObject({ granted: true });
    });
  });
});

// Runs last: files execute their tests in order.
describe("operatorAccess error vocabulary", () => {
  it("gives every closed code a distinct condition that a test above provoked", () => {
    const all = [...OPERATOR_ACCESS_CONFIG_ERROR_CODES, ...OPERATOR_ACCESS_SYSTEM_ERROR_CODES];
    expect(new Set(all).size).toBe(all.length);
    expect([...exercised].sort()).toEqual([...all].sort());
  });
});
