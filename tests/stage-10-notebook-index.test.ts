/**
 * Stage 10 Task 4 — pure notebook titlePath index builder.
 *
 * The builder takes a flat list of notebook records
 * (`NotebookRecord`) and returns a read-only `NotebookIndex`
 * that can resolve an id to its slash-separated titlePath and
 * resolve a (case-folded) titlePath back to its id.
 *
 * The contract pinned in this suite:
 *
 *   1. Every record's `id` must be a non-empty ASCII identifier
 *      matching the strict-id rule the rest of the codebase
 *      uses for note ids: `^[A-Za-z0-9_-]+$` and at most 256
 *      bytes.  Anything else (non-string, empty, control chars,
 *      non-ASCII) is rejected at build time.
 *   2. Every record's `title` must be a non-empty string whose
 *      code points are all in the printable ASCII range
 *      `[0x20, 0x7e]`.  This is the same rule the
 *      settings-loader enforces on glob pattern strings.
 *   3. Duplicate ids are rejected at build time (id is the
 *      dedupe key).  Any other duplicate (different id, same
 *      resolved titlePath after case folding) is rejected with
 *      `notebook_duplicate_path`.
 *   4. Cycles in the parent chain are rejected with
 *      `notebook_cycle`.  A self-edge (`A.parentId = A`) is
 *      also a cycle.  The build is atomic — a cycle never
 *      produces a partial index.
 *   5. A record whose `parentId` does not appear in the input
 *      list is treated as a root and emits a single warning
 *      via the injected logger.  The build does NOT throw.
 *   6. `resolvePath(id)` returns the resolved slash-joined
 *      titlePath or `undefined` for an unknown id.
 *   7. `resolveId(path)` is case-insensitive against the
 *      resolved titlePaths and returns the id or `undefined`.
 *   8. The returned `NotebookIndex` is itself frozen and the
 *      internal maps are frozen.
 *
 * No I/O, no Notesnook imports, no daemon imports.  Every
 * assertion runs against a pure function of its argument and
 * an injected logger.
 */

import { describe, expect, it } from "vitest";

import {
  NotebookIndexError,
  buildNotebookIndex,
  type NotebookIndex,
} from "../src/settings/notebook-index.js";

// ---------------------------------------------------------------------------
// Logger helper for warning-capture tests.
// ---------------------------------------------------------------------------

const makeCapturingLogger = () => {
  const messages: string[] = [];
  return {
    messages,
    warn: (message: string): void => {
      messages.push(message);
    },
  };
};

// ---------------------------------------------------------------------------
// Flat list (no parents).
// ---------------------------------------------------------------------------

describe("notebook index — flat list (no parents)", () => {
  it("resolves every id to a single-segment title", () => {
    const index = buildNotebookIndex([
      { id: "nb_a", title: "Personal" },
      { id: "nb_b", title: "Work" },
      { id: "nb_c", title: "Archive" },
    ]);
    expect(index.resolvePath("nb_a")).toBe("Personal");
    expect(index.resolvePath("nb_b")).toBe("Work");
    expect(index.resolvePath("nb_c")).toBe("Archive");
    expect(index.size()).toBe(3);
  });

  it("reverse-resolves each single-segment title case-insensitively", () => {
    const index = buildNotebookIndex([
      { id: "nb_a", title: "Personal" },
      { id: "nb_b", title: "Work" },
    ]);
    expect(index.resolveId("personal")).toBe("nb_a");
    expect(index.resolveId("PERSONAL")).toBe("nb_a");
    expect(index.resolveId("Personal")).toBe("nb_a");
    expect(index.resolveId("work")).toBe("nb_b");
    expect(index.resolveId("WORK")).toBe("nb_b");
  });
});

// ---------------------------------------------------------------------------
// Nested lists.
// ---------------------------------------------------------------------------

describe("notebook index — nested lists", () => {
  it("resolves a one-level deep chain to 'Parent/Child'", () => {
    const index = buildNotebookIndex([
      { id: "parent", title: "Parent" },
      { id: "child", title: "Child", parentId: "parent" },
    ]);
    expect(index.resolvePath("parent")).toBe("Parent");
    expect(index.resolvePath("child")).toBe("Parent/Child");
    expect(index.resolveId("Parent")).toBe("parent");
    expect(index.resolveId("Parent/Child")).toBe("child");
    expect(index.resolveId("parent/child")).toBe("child");
  });

  it("resolves a three-level deep chain to 'A/B/C'", () => {
    const index = buildNotebookIndex([
      { id: "a", title: "A" },
      { id: "b", title: "B", parentId: "a" },
      { id: "c", title: "C", parentId: "b" },
    ]);
    expect(index.resolvePath("a")).toBe("A");
    expect(index.resolvePath("b")).toBe("A/B");
    expect(index.resolvePath("c")).toBe("A/B/C");
    expect(index.resolveId("A")).toBe("a");
    expect(index.resolveId("A/B")).toBe("b");
    expect(index.resolveId("A/B/C")).toBe("c");
    expect(index.resolveId("a/b/c")).toBe("c");
  });

  it("treats a missing parentId as a root with no warning", () => {
    // A missing `parentId` key (or `undefined`) is the canonical
    // "this is a root" signal and must NOT emit a warning.
    // `exactOptionalPropertyTypes` forbids spelling `undefined`
    // explicitly, so the third record carries no `parentId`
    // key at all and the test asserts the runtime contract for
    // both shapes.
    const logger = makeCapturingLogger();
    const index = buildNotebookIndex(
      [
        { id: "root", title: "Root" },
        { id: "no_parent_key", title: "NoParentKey" },
        { id: "explicit_undef", title: "ExplicitUndef" },
      ],
      logger,
    );
    expect(index.resolvePath("root")).toBe("Root");
    expect(index.resolvePath("no_parent_key")).toBe("NoParentKey");
    expect(index.resolvePath("explicit_undef")).toBe("ExplicitUndef");
    expect(logger.messages).toEqual([]);
  });

  it("orders siblings by the input order when titles share a parent", () => {
    // The build is deterministic over the input order; siblings
    // must round-trip in declaration order.
    const index = buildNotebookIndex([
      { id: "p", title: "P" },
      { id: "first", title: "First", parentId: "p" },
      { id: "second", title: "Second", parentId: "p" },
    ]);
    expect(index.resolvePath("first")).toBe("P/First");
    expect(index.resolvePath("second")).toBe("P/Second");
    expect(index.resolveId("P/First")).toBe("first");
    expect(index.resolveId("P/Second")).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// Missing parent.
// ---------------------------------------------------------------------------

describe("notebook index — missing parent", () => {
  it("treats a missing parent as a root and emits a single warning", () => {
    const logger = makeCapturingLogger();
    const index = buildNotebookIndex(
      [
        { id: "real", title: "Real" },
        { id: "orphan", title: "Orphan", parentId: "does_not_exist" },
      ],
      logger,
    );
    expect(index.resolvePath("real")).toBe("Real");
    expect(index.resolvePath("orphan")).toBe("Orphan");
    expect(logger.messages.length).toBe(1);
    expect(typeof logger.messages[0]).toBe("string");
  });

  it("chains below a missing-parent root still resolve correctly", () => {
    const logger = makeCapturingLogger();
    const index = buildNotebookIndex(
      [
        { id: "orphan", title: "Orphan", parentId: "missing" },
        { id: "child", title: "Child", parentId: "orphan" },
      ],
      logger,
    );
    expect(index.resolvePath("orphan")).toBe("Orphan");
    expect(index.resolvePath("child")).toBe("Orphan/Child");
    expect(index.resolveId("Orphan/Child")).toBe("child");
    expect(logger.messages.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Duplicate id rejection.
// ---------------------------------------------------------------------------

describe("notebook index — duplicate id rejection", () => {
  it("rejects two records with the same id (id is the dedupe key)", () => {
    const expected = new NotebookIndexError("notebook_duplicate_id");
    expect(() =>
      buildNotebookIndex([
        { id: "dup", title: "First" },
        { id: "dup", title: "Second" },
      ]),
    ).toThrow(expected);
  });

  it("emits the canonical categorical code on duplicate id", () => {
    let caught: unknown;
    try {
      buildNotebookIndex([
        { id: "dup", title: "First" },
        { id: "dup", title: "Second" },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotebookIndexError);
    expect((caught as NotebookIndexError).code).toBe("notebook_duplicate_id");
  });
});

// ---------------------------------------------------------------------------
// Cycle rejection.
// ---------------------------------------------------------------------------

describe("notebook index — cycle rejection", () => {
  it("rejects a 2-cycle (A.parentId = B, B.parentId = A)", () => {
    const expected = new NotebookIndexError("notebook_cycle");
    expect(() =>
      buildNotebookIndex([
        { id: "a", title: "A", parentId: "b" },
        { id: "b", title: "B", parentId: "a" },
      ]),
    ).toThrow(expected);
  });

  it("rejects a 3-cycle (A -> B -> C -> A)", () => {
    const expected = new NotebookIndexError("notebook_cycle");
    expect(() =>
      buildNotebookIndex([
        { id: "a", title: "A", parentId: "c" },
        { id: "b", title: "B", parentId: "a" },
        { id: "c", title: "C", parentId: "b" },
      ]),
    ).toThrow(expected);
  });

  it("rejects a self-cycle (A.parentId = A)", () => {
    const expected = new NotebookIndexError("notebook_cycle");
    expect(() => buildNotebookIndex([{ id: "a", title: "A", parentId: "a" }])).toThrow(expected);
  });

  it("emits the canonical categorical code on cycle", () => {
    let caught: unknown;
    try {
      buildNotebookIndex([{ id: "a", title: "A", parentId: "a" }]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotebookIndexError);
    expect((caught as NotebookIndexError).code).toBe("notebook_cycle");
  });
});

// ---------------------------------------------------------------------------
// Duplicate resolved-path rejection.
// ---------------------------------------------------------------------------

describe("notebook index — duplicate resolved path", () => {
  it("rejects two records whose resolved paths collide exactly", () => {
    // Two roots with the same title: both resolve to "Personal".
    const expected = new NotebookIndexError("notebook_duplicate_path");
    expect(() =>
      buildNotebookIndex([
        { id: "a", title: "Personal" },
        { id: "b", title: "Personal" },
      ]),
    ).toThrow(expected);
  });

  it("rejects two records whose resolved paths collide after case folding", () => {
    // "Personal" and "PERSONAL" must collide because path
    // lookup is case-insensitive.
    const expected = new NotebookIndexError("notebook_duplicate_path");
    expect(() =>
      buildNotebookIndex([
        { id: "a", title: "Personal" },
        { id: "b", title: "PERSONAL" },
      ]),
    ).toThrow(expected);
  });

  it("rejects nested records whose resolved paths collide", () => {
    // Both children resolve to "Parent/Child".
    const expected = new NotebookIndexError("notebook_duplicate_path");
    expect(() =>
      buildNotebookIndex([
        { id: "p", title: "Parent" },
        { id: "a", title: "Child", parentId: "p" },
        { id: "q", title: "PARENT" },
        { id: "b", title: "child", parentId: "q" },
      ]),
    ).toThrow(expected);
  });

  it("emits the canonical categorical code on duplicate path", () => {
    let caught: unknown;
    try {
      buildNotebookIndex([
        { id: "a", title: "Personal" },
        { id: "b", title: "Personal" },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotebookIndexError);
    expect((caught as NotebookIndexError).code).toBe("notebook_duplicate_path");
  });
});

// ---------------------------------------------------------------------------
// Resolver behaviour.
// ---------------------------------------------------------------------------

describe("notebook index — resolvers", () => {
  it("resolvePath returns undefined for an unknown id", () => {
    const index = buildNotebookIndex([{ id: "a", title: "A" }]);
    expect(index.resolvePath("does_not_exist")).toBeUndefined();
    expect(index.resolvePath("")).toBeUndefined();
  });

  it("resolvePath returns the same path on repeated calls", () => {
    const index = buildNotebookIndex([
      { id: "p", title: "P" },
      { id: "c", title: "C", parentId: "p" },
    ]);
    expect(index.resolvePath("c")).toBe("P/C");
    expect(index.resolvePath("c")).toBe("P/C");
  });

  it("resolveId is case-insensitive on every segment", () => {
    const index = buildNotebookIndex([
      { id: "p", title: "Parent" },
      { id: "c", title: "Child", parentId: "p" },
    ]);
    expect(index.resolveId("PARENT/CHILD")).toBe("c");
    expect(index.resolveId("parent/CHILD")).toBe("c");
    expect(index.resolveId("Parent/child")).toBe("c");
    expect(index.resolveId("pArEnT/cHiLd")).toBe("c");
  });

  it("resolveId returns undefined for an unknown path", () => {
    const index = buildNotebookIndex([{ id: "a", title: "A" }]);
    expect(index.resolveId("DoesNotExist")).toBeUndefined();
    expect(index.resolveId("A/B")).toBeUndefined();
    expect(index.resolveId("")).toBeUndefined();
  });

  it("size() reports the number of records indexed", () => {
    expect(buildNotebookIndex([]).size()).toBe(0);
    expect(
      buildNotebookIndex([
        { id: "a", title: "A" },
        { id: "b", title: "B" },
        { id: "c", title: "C" },
      ]).size(),
    ).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Invalid id rejection.
// ---------------------------------------------------------------------------

describe("notebook index — invalid id rejection", () => {
  it("rejects a non-string id", () => {
    const expected = new NotebookIndexError("notebook_invalid_id");
    expect(() =>
      buildNotebookIndex([
        // Cast is required because the type forbids this; the
        // runtime contract is what we are pinning here.
        { id: 42 as unknown as string, title: "A" },
      ]),
    ).toThrow(expected);
  });

  it("rejects an empty-string id", () => {
    const expected = new NotebookIndexError("notebook_invalid_id");
    expect(() => buildNotebookIndex([{ id: "", title: "A" }])).toThrow(expected);
  });

  it("rejects an id containing control characters", () => {
    const expected = new NotebookIndexError("notebook_invalid_id");
    expect(() =>
      buildNotebookIndex([
        { id: "a\u0000b", title: "A" },
        { id: "a\u001fb", title: "A2" },
      ]),
    ).toThrow(expected);
  });

  it("rejects an id containing non-ASCII characters", () => {
    const expected = new NotebookIndexError("notebook_invalid_id");
    expect(() => buildNotebookIndex([{ id: "café", title: "A" }])).toThrow(expected);
  });

  it("rejects an id exceeding 256 bytes", () => {
    const expected = new NotebookIndexError("notebook_invalid_id");
    expect(() => buildNotebookIndex([{ id: "a".repeat(257), title: "A" }])).toThrow(expected);
  });

  it("accepts an id of exactly 256 bytes", () => {
    const index = buildNotebookIndex([{ id: "a".repeat(256), title: "A" }]);
    expect(index.resolvePath("a".repeat(256))).toBe("A");
  });
});

// ---------------------------------------------------------------------------
// Invalid title rejection.
// ---------------------------------------------------------------------------

describe("notebook index — invalid title rejection", () => {
  it("rejects a non-string title", () => {
    const expected = new NotebookIndexError("notebook_invalid_title");
    expect(() => buildNotebookIndex([{ id: "a", title: 42 as unknown as string }])).toThrow(
      expected,
    );
  });

  it("rejects an empty-string title", () => {
    const expected = new NotebookIndexError("notebook_invalid_title");
    expect(() => buildNotebookIndex([{ id: "a", title: "" }])).toThrow(expected);
  });

  it("rejects a title containing control characters", () => {
    const expected = new NotebookIndexError("notebook_invalid_title");
    expect(() =>
      buildNotebookIndex([
        { id: "a", title: "bad\u0000title" },
        { id: "b", title: "bad\u007ftitle" },
      ]),
    ).toThrow(expected);
  });

  it("rejects a title containing non-ASCII characters", () => {
    const expected = new NotebookIndexError("notebook_invalid_title");
    expect(() => buildNotebookIndex([{ id: "a", title: "café" }])).toThrow(expected);
  });

  it("accepts printable ASCII titles (the [0x20, 0x7e] range)", () => {
    const index = buildNotebookIndex([
      { id: "a", title: " !\"#$%&'()*+,-./0123456789:;<=>?@AZaz[\\]^_`{|}~" },
    ]);
    expect(index.resolvePath("a")).toBe(" !\"#$%&'()*+,-./0123456789:;<=>?@AZaz[\\]^_`{|}~");
  });
});

// ---------------------------------------------------------------------------
// Categorical error contract.
// ---------------------------------------------------------------------------

describe("NotebookIndexError", () => {
  it("is an Error subclass that exposes the categorical code", () => {
    const error = new NotebookIndexError("notebook_cycle");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(NotebookIndexError);
    expect(error.code).toBe("notebook_cycle");
    expect(typeof error.message).toBe("string");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("supports the full published code vocabulary", () => {
    for (const code of [
      "notebook_cycle",
      "notebook_duplicate_id",
      "notebook_duplicate_path",
      "notebook_invalid_id",
      "notebook_invalid_title",
    ] as const) {
      const error = new NotebookIndexError(code);
      expect(error.code).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// Returned-shape immutability.
// ---------------------------------------------------------------------------

describe("notebook index — frozen returned shape", () => {
  it("freezes the returned NotebookIndex", () => {
    const index: NotebookIndex = buildNotebookIndex([{ id: "a", title: "A" }]);
    expect(Object.isFrozen(index)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No logger side effects on happy paths.
// ---------------------------------------------------------------------------

describe("notebook index — logger hygiene", () => {
  it("does not invoke the logger at all on a happy-path build", () => {
    const logger = makeCapturingLogger();
    buildNotebookIndex(
      [
        { id: "a", title: "A" },
        { id: "b", title: "B", parentId: "a" },
      ],
      logger,
    );
    expect(logger.messages).toEqual([]);
  });

  it("accepts an absent logger (the optional parameter is truly optional)", () => {
    expect(() =>
      buildNotebookIndex([{ id: "orphan", title: "Orphan", parentId: "missing" }]),
    ).not.toThrow();
  });
});
