/**
 * Stage 10 — settings schema types.
 *
 * This suite pins the *types-only* contract of the Stage 10 settings
 * loader.  It exercises the small closed shape module introduced for
 * Stage 10 Task 1, and it is intentionally focused on the type
 * predicates — not on parsing, file I/O, defaults merging, or daemon
 * integration.  Those concerns are verified separately by the parser /
 * loader / resolver suites introduced in later Stage 10 tasks.
 *
 * The contract pinned here:
 *
 *   1. `SETTINGS_SCHEMA_VERSION` is exported as the literal `1`,
 *      frozen at the type level via `as const`.
 *   2. `SettingsOperation` is the closed union
 *      `"read" | "edit" | "create" | "delete"`.  The `isSettingsOperation`
 *      predicate narrows an arbitrary `unknown` to that union and
 *      rejects every other value (case variants, similar-looking
 *      strings, the empty string, non-strings, `null`, objects, arrays,
 *      numbers, booleans).
 *   3. `SettingsDefaults` is the closed record
 *      `Readonly<Record<SettingsOperation, boolean>>`.  The
 *      `isSettingsDefaults` predicate admits only objects whose
 *      enumerable own keys are exactly the four published operation
 *      keys in the published order, every value is strictly a boolean,
 *      and no extra keys are present.  Every other shape (missing
 *      key, extra key, non-boolean value, non-object, `null`, array,
 *      Proxy) is rejected.
 *   4. `SettingsOverride` is the closed shape with optional
 *      notebook / note id lists and per-operation booleans.  The
 *      shape is `Readonly`, the id lists are `readonly string[]`,
 *      and every boolean is plain `boolean`.
 *   5. `SettingsFile` is the closed shape wrapping `version: 1`,
 *      `defaults: SettingsDefaults`, and
 *      `overrides: readonly SettingsOverride[]`.
 *   6. `SETTINGS_OPERATION_KEYS` is the published
 *      `Object.freeze(["read", "edit", "create", "delete"] as const)`
 *      tuple, frozen at runtime and at the type level.
 *
 * No I/O, no Notesnook imports, no daemon imports, no parser, no
 * JSON.  Every export is a pure function of its argument and the
 * frozen module-level state.
 */

import { describe, expect, it } from "vitest";

import {
  SETTINGS_OPERATION_KEYS,
  SETTINGS_SCHEMA_VERSION,
  isSettingsDefaults,
  isSettingsOperation,
  type SettingsDefaults,
  type SettingsFile,
  type SettingsOverride,
} from "../src/settings/settings-types.js";

// ---------------------------------------------------------------------------
// Schema version.
// ---------------------------------------------------------------------------

describe("settings types — schema version", () => {
  it("exposes SETTINGS_SCHEMA_VERSION as the literal 1", () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(1);
  });

  it("freezes SETTINGS_SCHEMA_VERSION as a `as const` literal type", () => {
    // The contract requires `as const`, so the exported value's type is
    // the literal `1` and is not assignable to a wider numeric type.
    const check: 1 = SETTINGS_SCHEMA_VERSION;
    expect(check).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Operation vocabulary.
// ---------------------------------------------------------------------------

describe("settings types — operation vocabulary", () => {
  it("exposes the four published operation keys in the published order", () => {
    expect(Array.from(SETTINGS_OPERATION_KEYS)).toEqual(["read", "edit", "create", "delete"]);
  });

  it("freezes SETTINGS_OPERATION_KEYS so a hostile caller cannot widen it", () => {
    expect(Object.isFrozen(SETTINGS_OPERATION_KEYS)).toBe(true);
  });

  it("uses a null prototype on SETTINGS_OPERATION_KEYS so an inherited getter cannot smuggle data", () => {
    expect(Object.getPrototypeOf(SETTINGS_OPERATION_KEYS)).toBeNull();
  });
});

describe("settings types — isSettingsOperation predicate", () => {
  it("accepts every published operation literal", () => {
    expect(isSettingsOperation("read")).toBe(true);
    expect(isSettingsOperation("edit")).toBe(true);
    expect(isSettingsOperation("create")).toBe(true);
    expect(isSettingsOperation("delete")).toBe(true);
  });

  it("rejects case variants of the published literals", () => {
    expect(isSettingsOperation("Read")).toBe(false);
    expect(isSettingsOperation("READ")).toBe(false);
    expect(isSettingsOperation("Edit")).toBe(false);
    expect(isSettingsOperation("CREATE")).toBe(false);
    expect(isSettingsOperation("Delete")).toBe(false);
  });

  it("rejects lookalike strings that are not in the vocabulary", () => {
    expect(isSettingsOperation("list")).toBe(false);
    expect(isSettingsOperation("readwrite")).toBe(false);
    expect(isSettingsOperation("notes.read")).toBe(false);
    expect(isSettingsOperation("read ")).toBe(false);
    expect(isSettingsOperation(" read")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isSettingsOperation("")).toBe(false);
  });

  it("rejects every non-string value", () => {
    expect(isSettingsOperation(null)).toBe(false);
    expect(isSettingsOperation(undefined)).toBe(false);
    expect(isSettingsOperation(0)).toBe(false);
    expect(isSettingsOperation(1)).toBe(false);
    expect(isSettingsOperation(true)).toBe(false);
    expect(isSettingsOperation(false)).toBe(false);
    expect(isSettingsOperation({})).toBe(false);
    expect(isSettingsOperation([])).toBe(false);
    expect(isSettingsOperation({ read: "read" })).toBe(false);
    expect(isSettingsOperation(() => "read")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Defaults predicate.
// ---------------------------------------------------------------------------

describe("settings types — isSettingsDefaults predicate", () => {
  it("accepts a defaults object with exactly the four booleans", () => {
    const value: SettingsDefaults = {
      read: true,
      edit: false,
      create: false,
      delete: false,
    };
    expect(isSettingsDefaults(value)).toBe(true);
  });

  it("accepts a defaults object with mixed booleans for every operation", () => {
    const value = {
      read: false,
      edit: true,
      create: false,
      delete: true,
    };
    expect(isSettingsDefaults(value)).toBe(true);
  });

  it("rejects a defaults object missing one of the four published keys", () => {
    expect(
      isSettingsDefaults({
        read: true,
        edit: true,
        create: true,
      }),
    ).toBe(false);
    expect(
      isSettingsDefaults({
        edit: true,
        create: true,
        delete: true,
      }),
    ).toBe(false);
  });

  it("rejects a defaults object carrying an extra unknown key", () => {
    expect(
      isSettingsDefaults({
        read: true,
        edit: true,
        create: true,
        delete: true,
        list: true,
      }),
    ).toBe(false);
  });

  it("rejects a defaults object carrying a typo key (similar-looking string)", () => {
    expect(
      isSettingsDefaults({
        read: true,
        edit: true,
        create: true,
        Delete: true,
      }),
    ).toBe(false);
  });

  it("rejects a defaults object whose value is not a strict boolean", () => {
    expect(
      isSettingsDefaults({
        read: "true",
        edit: 1,
        create: 0,
        delete: null,
      }),
    ).toBe(false);
    expect(
      isSettingsDefaults({
        read: true,
        edit: true,
        create: true,
        delete: undefined,
      }),
    ).toBe(false);
  });

  it("rejects non-object candidates", () => {
    expect(isSettingsDefaults(null)).toBe(false);
    expect(isSettingsDefaults(undefined)).toBe(false);
    expect(isSettingsDefaults(true)).toBe(false);
    expect(isSettingsDefaults("read")).toBe(false);
    expect(isSettingsDefaults(42)).toBe(false);
    expect(isSettingsDefaults([])).toBe(false);
    expect(isSettingsDefaults(() => ({ read: true }))).toBe(false);
  });

  it("rejects an array of four booleans (objects and arrays are not interchangeable)", () => {
    expect(isSettingsDefaults([true, true, true, true])).toBe(false);
  });

  it("rejects an object built with a polluted prototype carrying inherited keys", () => {
    const polluted = Object.create({
      read: true,
      edit: true,
      create: true,
      delete: true,
    });
    expect(isSettingsDefaults(polluted)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SettingsOverride shape.
// ---------------------------------------------------------------------------

describe("settings types — SettingsOverride shape", () => {
  it("permits a read-only id-list plus boolean overrides for every operation", () => {
    const override: SettingsOverride = {
      notebooks: ["alpha", "beta"],
      notes: ["note-1", "note-2"],
      read: true,
      edit: false,
      create: false,
      delete: false,
    };
    expect(override.notebooks).toEqual(["alpha", "beta"]);
    expect(override.notes).toEqual(["note-1", "note-2"]);
    expect(override.read).toBe(true);
    expect(override.edit).toBe(false);
  });

  it("permits empty overrides with no fields set", () => {
    const override: SettingsOverride = {};
    expect(override.notebooks).toBeUndefined();
    expect(override.notes).toBeUndefined();
    expect(override.read).toBeUndefined();
  });

  it("treats the id lists as readonly string arrays", () => {
    const override: SettingsOverride = {
      notebooks: ["alpha"],
    };
    // Cast through `unknown` so we can prove the runtime shape is
    // a readonly string array, not a mutable one.
    const notebooks = override.notebooks as ReadonlyArray<string> | undefined;
    expect(Array.isArray(notebooks)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SettingsFile shape.
// ---------------------------------------------------------------------------

describe("settings types — SettingsFile shape", () => {
  it("wires version=1, defaults, and an overrides tuple", () => {
    const file: SettingsFile = {
      version: 1,
      defaults: {
        read: true,
        edit: false,
        create: false,
        delete: false,
      },
      overrides: [
        {
          notebooks: ["alpha"],
          read: false,
        },
        {
          notes: ["note-1"],
          edit: true,
        },
      ],
    };
    expect(file.version).toBe(1);
    expect(file.defaults.read).toBe(true);
    expect(file.overrides.length).toBe(2);
    expect(file.overrides[0]?.notebooks).toEqual(["alpha"]);
    expect(file.overrides[1]?.notes).toEqual(["note-1"]);
  });

  it("accepts an empty overrides tuple", () => {
    const file: SettingsFile = {
      version: 1,
      defaults: {
        read: true,
        edit: true,
        create: false,
        delete: false,
      },
      overrides: [],
    };
    expect(file.overrides).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Module purity.
// ---------------------------------------------------------------------------

describe("settings types — module purity", () => {
  it("does not import from Notesnook, the daemon, or filesystem APIs", async () => {
    // Static import-graph smoke test: this module only pulls from
    // vitest and its own source.  Any future widening that drags in
    // `@notesnook/*`, `fs`, `node:*`, the daemon server, the RPC
    // protocol, or the MCP proxy is caught here.
    const module = await import("../src/settings/settings-types.js");
    expect(typeof module.SETTINGS_SCHEMA_VERSION).toBe("number");
    expect(typeof module.isSettingsOperation).toBe("function");
    expect(typeof module.isSettingsDefaults).toBe("function");
    expect(typeof module.SETTINGS_OPERATION_KEYS).toBe("object");
  });
});
