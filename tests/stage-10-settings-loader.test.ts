/**
 * Stage 10 — fail-closed settings loader.
 *
 * The loader takes an already-parsed JSON value of type `unknown` and
 * returns either a deeply frozen `SettingsFile` or throws a categorical
 * `SettingsLoadError`.  It does no I/O, performs no JSON parsing, and
 * depends on nothing outside the closed settings seam (schema types,
 * this loader, and the published glob module's pattern validation
 * rules, which we replicate verbatim here so the loader has no
 * runtime dependency on the glob module).
 *
 * The contract pinned in this suite:
 *
 *   1. The input must be a non-null, non-array object.  Every other
 *      shape (`null`, primitive, array) is rejected with a
 *      `SettingsLoadError` whose `code` is exactly
 *      `"settings_invalid"`.
 *   2. The `version` field must equal `SETTINGS_SCHEMA_VERSION` (1)
 *      via `===`.  Missing, wrong-version, or non-numeric versions
 *      are rejected.
 *   3. The `defaults` field must satisfy `isSettingsDefaults`.
 *   4. The `overrides` field must be a real array; each element must
 *      be an object, must not carry both `notebooks` and `notes`,
 *      must carry at least one operation boolean, every operation
 *      boolean must be strictly `true` / `false`, and every id-list
 *      entry must be a non-empty string with no empty segments
 *      (`//`), no control characters, and no non-ASCII characters.
 *   5. The returned `SettingsFile` is deeply frozen: the top-level
 *      object, the `defaults` record, each override object, and each
 *      id-list array are all `Object.isFrozen(...) === true`.
 *   6. The categorical error does not echo any user input.  Its
 *      `message` is a fixed string, `code` is the literal
 *      `"settings_invalid"`, and the error has no `cause` chain.
 *
 * No I/O, no Notesnook imports, no daemon imports.  Every assertion
 * runs against a pure function of its argument.
 */

import { describe, expect, it } from "vitest";

import { SETTINGS_SCHEMA_VERSION } from "../src/settings/settings-types.js";
import { SettingsLoadError, loadSettings } from "../src/settings/settings-loader.js";
import type { SettingsFile } from "../src/settings/settings-types.js";

// ---------------------------------------------------------------------------
// Canonical / round-trip.
// ---------------------------------------------------------------------------

describe("settings loader — canonical schema", () => {
  it("accepts a canonical file and returns a frozen SettingsFile", () => {
    const input = {
      version: 1,
      defaults: {
        read: true,
        edit: false,
        create: false,
        delete: false,
      },
      overrides: [
        {
          notebooks: ["work/**"],
          read: true,
        },
      ],
    };

    const loaded = loadSettings(input);
    expect(loaded).toEqual(input);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.defaults)).toBe(true);
    expect(Object.isFrozen(loaded.overrides)).toBe(true);
    expect(Object.isFrozen(loaded.overrides[0])).toBe(true);
    expect(Object.isFrozen(loaded.overrides[0]!.notebooks)).toBe(true);
  });

  it("accepts an empty overrides array", () => {
    const input = {
      version: 1,
      defaults: {
        read: false,
        edit: false,
        create: false,
        delete: false,
      },
      overrides: [],
    };
    const loaded = loadSettings(input);
    expect(loaded.overrides).toEqual([]);
    expect(Object.isFrozen(loaded.overrides)).toBe(true);
  });

  it("rejects a non-object input (primitive, null, array)", () => {
    const expected = new SettingsLoadError();
    expect(() => loadSettings(null)).toThrow(expected);
    expect(() => loadSettings(undefined)).toThrow(expected);
    expect(() => loadSettings(42)).toThrow(expected);
    expect(() => loadSettings("string")).toThrow(expected);
    expect(() => loadSettings(true)).toThrow(expected);
    expect(() => loadSettings([])).toThrow(expected);
  });
});

// ---------------------------------------------------------------------------
// Version checks.
// ---------------------------------------------------------------------------

describe("settings loader — version field", () => {
  const validDefaults = {
    read: true,
    edit: false,
    create: false,
    delete: false,
  } as const;

  it("rejects a missing version field", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        defaults: { ...validDefaults },
        overrides: [],
      }),
    ).toThrow(expected);
  });

  it("rejects version 0", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 0,
        defaults: { ...validDefaults },
        overrides: [],
      }),
    ).toThrow(expected);
  });

  it("rejects version 2", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 2,
        defaults: { ...validDefaults },
        overrides: [],
      }),
    ).toThrow(expected);
  });

  it('rejects the string "1" even though it would coerce equal', () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: "1",
        defaults: { ...validDefaults },
        overrides: [],
      }),
    ).toThrow(expected);
  });

  it("uses SETTINGS_SCHEMA_VERSION as the source of truth", () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Defaults field.
// ---------------------------------------------------------------------------

describe("settings loader — defaults field", () => {
  it("rejects missing defaults", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        overrides: [],
      }),
    ).toThrow(expected);
  });

  it("rejects defaults whose value is not a strict boolean", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: {
          read: 1,
          edit: false,
          create: false,
          delete: false,
        },
        overrides: [],
      }),
    ).toThrow(expected);
  });

  it("rejects defaults with an extra key", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: {
          read: true,
          edit: true,
          create: true,
          delete: true,
          share: true,
        },
        overrides: [],
      }),
    ).toThrow(expected);
  });

  it("rejects non-object defaults", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: null,
        overrides: [],
      }),
    ).toThrow(expected);
  });
});

// ---------------------------------------------------------------------------
// Overrides field shape.
// ---------------------------------------------------------------------------

describe("settings loader — overrides field shape", () => {
  const validDefaults = {
    read: true,
    edit: false,
    create: false,
    delete: false,
  } as const;

  it("rejects a non-array overrides field", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: "nope",
      }),
    ).toThrow(expected);
  });

  it("rejects a missing overrides field", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
      }),
    ).toThrow(expected);
  });

  it("rejects an override that is not an object", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: ["nope"],
      }),
    ).toThrow(expected);
  });

  it("rejects an override that sets both notebooks and notes", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: [
          {
            notebooks: ["a"],
            notes: ["b"],
            read: true,
          },
        ],
      }),
    ).toThrow(expected);
  });

  it("rejects an override that sets no operation booleans", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: [
          {
            notebooks: ["a"],
          },
        ],
      }),
    ).toThrow(expected);
  });

  it("rejects an override whose operation boolean is not strict true/false", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: [
          {
            notebooks: ["a"],
            read: 1,
          },
        ],
      }),
    ).toThrow(expected);
  });

  it("rejects an override with an unknown key", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: [
          {
            notebooks: ["a"],
            read: true,
            banana: true,
          },
        ],
      }),
    ).toThrow(expected);
  });
});

// ---------------------------------------------------------------------------
// Id-list entry validation.
// ---------------------------------------------------------------------------

describe("settings loader — id-list entries", () => {
  const validDefaults = {
    read: true,
    edit: false,
    create: false,
    delete: false,
  } as const;

  it("rejects notebooks entries that are not strings", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: [
          {
            notebooks: [42],
            read: true,
          },
        ],
      }),
    ).toThrow(expected);
  });

  it("rejects notes entries that are not strings", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: [
          {
            notes: [null],
            read: true,
          },
        ],
      }),
    ).toThrow(expected);
  });

  it("rejects empty-string notebooks entries", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: [
          {
            notebooks: [""],
            read: true,
          },
        ],
      }),
    ).toThrow(expected);
  });

  it("rejects empty-string notes entries", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: [
          {
            notes: [""],
            read: true,
          },
        ],
      }),
    ).toThrow(expected);
  });

  it('rejects notebooks entries with empty segments ("//")', () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: [
          {
            notebooks: ["a//b"],
            read: true,
          },
        ],
      }),
    ).toThrow(expected);
  });

  it('rejects notes entries with empty segments ("//")', () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: [
          {
            notes: ["a//b"],
            read: true,
          },
        ],
      }),
    ).toThrow(expected);
  });

  it("rejects notebooks entries containing control characters", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: [
          {
            notebooks: ["a\u0000b"],
            read: true,
          },
        ],
      }),
    ).toThrow(expected);
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: [
          {
            notebooks: ["a\u001fb"],
            read: true,
          },
        ],
      }),
    ).toThrow(expected);
  });

  it("rejects notes entries containing control characters", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: [
          {
            notes: ["a\u007fb"],
            read: true,
          },
        ],
      }),
    ).toThrow(expected);
  });

  it("rejects notebooks entries containing non-ASCII characters", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: [
          {
            notebooks: ["café"],
            read: true,
          },
        ],
      }),
    ).toThrow(expected);
  });

  it("rejects notes entries containing non-ASCII characters", () => {
    const expected = new SettingsLoadError();
    expect(() =>
      loadSettings({
        version: 1,
        defaults: { ...validDefaults },
        overrides: [
          {
            notes: ["日本語"],
            read: true,
          },
        ],
      }),
    ).toThrow(expected);
  });

  it("accepts a glob-style notebook id and freezes it", () => {
    const loaded = loadSettings({
      version: 1,
      defaults: { ...validDefaults },
      overrides: [
        {
          notebooks: ["Notes/*.md", "a/b/c"],
          read: true,
        },
        {
          notes: ["single-note"],
          edit: true,
        },
      ],
    });
    expect(loaded.overrides[0]?.notebooks).toEqual(["Notes/*.md", "a/b/c"]);
    expect(loaded.overrides[1]?.notes).toEqual(["single-note"]);
    expect(Object.isFrozen(loaded.overrides[0]?.notebooks)).toBe(true);
    expect(Object.isFrozen(loaded.overrides[1]?.notes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Categorical error contract.
// ---------------------------------------------------------------------------

describe("SettingsLoadError", () => {
  it("is an Error subclass with the fixed categorical code", () => {
    const error = new SettingsLoadError();
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("settings_invalid");
    expect(typeof error.message).toBe("string");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("does not chain a cause", () => {
    const error = new SettingsLoadError();
    expect(error.cause).toBeUndefined();
  });

  it("does not echo any user input in its message", () => {
    // Use a sentinel that is *guaranteed* to be rejected by the
    // loader so the test exercises the failure path: a notebooks
    // entry containing an empty segment (`//`) is rejected at
    // load time.
    const sentinel = "this/string//must/never/leak";
    let caught: unknown;
    try {
      loadSettings({
        version: 1,
        defaults: {
          read: true,
          edit: false,
          create: false,
          delete: false,
        },
        overrides: [
          {
            notebooks: [sentinel],
            read: true,
          },
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SettingsLoadError);
    const message = (caught as SettingsLoadError).message;
    expect(message.includes(sentinel)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Returned shape immutability.
// ---------------------------------------------------------------------------

describe("settings loader — frozen returned file", () => {
  it("freezes the top-level object, defaults, overrides array, and each override", () => {
    const loaded = loadSettings({
      version: 1,
      defaults: {
        read: true,
        edit: false,
        create: false,
        delete: false,
      },
      overrides: [
        {
          notebooks: ["a"],
          read: true,
        },
        {
          notes: ["b"],
          edit: true,
        },
      ],
    });
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.defaults)).toBe(true);
    expect(Object.isFrozen(loaded.overrides)).toBe(true);
    for (const override of loaded.overrides) {
      expect(Object.isFrozen(override)).toBe(true);
      if (override.notebooks) {
        expect(Object.isFrozen(override.notebooks)).toBe(true);
      }
      if (override.notes) {
        expect(Object.isFrozen(override.notes)).toBe(true);
      }
    }
  });

  it("rejects mutation of the returned file in strict mode (typed as SettingsFile)", () => {
    const loaded: SettingsFile = loadSettings({
      version: 1,
      defaults: {
        read: true,
        edit: false,
        create: false,
        delete: false,
      },
      overrides: [],
    });
    // The runtime check is what we pin here; the type system is a
    // separate (defence-in-depth) concern.
    expect(Object.isFrozen(loaded)).toBe(true);
  });
});
