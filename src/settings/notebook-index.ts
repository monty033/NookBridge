/**
 * Stage 10 Task 4 — pure notebook titlePath index builder.
 *
 * The builder takes a flat list of notebook records (id, title,
 * optional parentId) and returns a read-only `NotebookIndex` that
 * resolves an id to its slash-separated titlePath and resolves a
 * (case-folded) titlePath back to its id.  The module is pure:
 * no I/O, no Notesnook imports, no daemon imports, no global
 * state.
 *
 * Validation rules
 * ----------------
 *
 *   - `id` must be a non-empty string matching the strict-id rule
 *     the rest of the codebase uses for note ids
 *     (`^[A-Za-z0-9_-]+$`) and at most 256 bytes.  Anything else
 *     (non-string, empty, control char, non-ASCII, oversize)
 *     throws `NotebookIndexError` with `code: "notebook_invalid_id"`.
 *   - `title` must be a non-empty string whose code points are
 *     all in the printable ASCII range `[0x20, 0x7e]`.  This is
 *     the same rule the settings-loader enforces on glob pattern
 *     strings.  Anything else throws `NotebookIndexError` with
 *     `code: "notebook_invalid_title"`.
 *   - Duplicate ids are rejected with
 *     `code: "notebook_duplicate_id"`.  Two records with different
 *     ids whose resolved titlePaths collide (after case folding)
 *     are rejected with `code: "notebook_duplicate_path"`.
 *   - A `parentId` that refers to a missing id is treated as a
 *     root (the orphan becomes its own root) and a single warning
 *     is emitted via the injected logger.  The build does NOT
 *     throw.
 *   - A cycle in the parent chain (including a self-edge
 *     `A.parentId = A`) throws `NotebookIndexError` with
 *     `code: "notebook_cycle"`.  The build is atomic — a cycle
 *     never produces a partial index.
 *
 * Categorical error
 * -----------------
 *
 * `NotebookIndexError` is an `Error` subclass that carries a
 * fixed `code` literal from the published vocabulary
 * (`"notebook_cycle"`, `"notebook_duplicate_id"`,
 * `"notebook_duplicate_path"`, `"notebook_invalid_id"`,
 * `"notebook_invalid_title"`) and a fixed `message`.  The
 * message never echoes any user input (no id, no title, no path)
 * so a caller that forwards the error to a log / RPC cannot
 * accidentally exfiltrate attacker-controlled bytes through the
 * diagnostic.
 *
 * Immutability
 * ------------
 *
 * The returned `NotebookIndex` is itself frozen and the two
 * internal maps (id -> titlePath, lower-cased titlePath -> id)
 * are frozen before the builder returns.  A caller cannot widen
 * the contract after construction.
 */

// ---------------------------------------------------------------------------
// Public vocabulary.
// ---------------------------------------------------------------------------

/**
 * The published set of error codes the builder throws.  Any future
 * widening (a new failure mode) requires an explicit Stage 10
 * amendment.
 */
export type NotebookIndexErrorCode =
  | "notebook_cycle"
  | "notebook_duplicate_id"
  | "notebook_duplicate_path"
  | "notebook_invalid_id"
  | "notebook_invalid_title";

/**
 * Input shape the builder accepts.  Every field is `readonly`;
 * the caller may safely pass frozen records.
 */
export type NotebookRecord = {
  readonly id: string;
  readonly title: string;
  readonly parentId?: string;
};

/**
 * The read-only accessor surface returned by `buildNotebookIndex`.
 *
 *   - `resolvePath(id)` returns the slash-joined titlePath for the
 *     record whose id matches, or `undefined` if the id is not
 *     present in the index.
 *   - `resolveId(path)` is a case-insensitive lookup against the
 *     resolved titlePaths; returns the id, or `undefined` if no
 *     record resolves to the supplied path.
 *   - `size()` reports the number of records the index contains.
 */
export type NotebookIndex = Readonly<{
  readonly resolvePath: (id: string) => string | undefined;
  readonly resolveId: (path: string) => string | undefined;
  readonly size: () => number;
}>;

// ---------------------------------------------------------------------------
// Categorical error.
// ---------------------------------------------------------------------------

/**
 * The single, fixed error class the builder throws.  `code` is one
 * of the published `NotebookIndexErrorCode` literals; `message` is
 * a fixed string; `cause` is intentionally not set so the
 * diagnostic surface is fully deterministic and does not echo
 * user input.
 */
export class NotebookIndexError extends Error {
  public readonly code: NotebookIndexErrorCode;

  public constructor(code: NotebookIndexErrorCode) {
    // The message is intentionally a fixed, generic phrasing so a
    // caller cannot recover any user input (id, title, path)
    // from the diagnostic.  The `code` is the only signal the
    // caller needs.
    super("notebook index failed validation");
    this.code = code;
    // Pin the prototype to defend against a hostile caller
    // widening the contract after construction.  The instance is
    // intentionally NOT frozen for the same reason the
    // SettingsLoadError is not frozen: V8 installs internal
    // properties on first capture.
    Object.setPrototypeOf(this, NotebookIndexError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/**
 * The published strict-id rule the rest of the codebase uses for
 * note ids.  `^[A-Za-z0-9_-]+$` and at most 256 bytes.  Replicated
 * here (rather than imported) because the index module sits below
 * every other settings module and must not pick up a runtime
 * dependency on the loader or the glob module.
 */
const STRICT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_ID_BYTES = 256;

/**
 * The published title rule: code points in the printable ASCII
 * range `[0x20, 0x7e]`.  Same rule the settings-loader enforces
 * on glob pattern strings.
 */
const isValidTitle = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return false;
    if (codePoint < 0x20 || codePoint > 0x7e) return false;
  }
  return true;
};

/**
 * Validate an id.  Returns `true` only for a non-empty ASCII
 * identifier (matching the strict-id rule) of at most 256 bytes.
 * The byte-length cap is enforced on the raw string length; every
 * id character is itself a single-byte ASCII so string length
 * and byte length agree here.  A non-string `value` returns
 * `false` so callers can use the predicate for runtime narrowing.
 */
const isValidId = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value.length > MAX_ID_BYTES) return false;
  return STRICT_ID_PATTERN.test(value);
};

/**
 * ASCII case-fold.  Every character we accept into a title or an
 * id is printable ASCII, so a plain `toLowerCase()` is the
 * correct fold here and we do not need a Unicode-aware
 * case-mapping.  The fold produces a single string the same
 * length as the input.
 */
const asciiFold = (value: string): string => value.toLowerCase();

// ---------------------------------------------------------------------------
// Builder.
// ---------------------------------------------------------------------------

/**
 * Build a read-only `NotebookIndex` over a flat list of
 * `NotebookRecord`s.
 *
 * The algorithm:
 *
 *   1. Validate every record's `id` and `title`.  Any failure
 *      throws `NotebookIndexError` with the categorical code;
 *      the builder never partially builds.
 *   2. Reject duplicate ids (`notebook_duplicate_id`).
 *   3. Build a `recordById` map and an `idByFoldedPath` map.
 *      For every record, walk the parent chain to its root and
 *      assemble the slash-joined titlePath, detecting cycles
 *      with a per-walk visited set.  A `parentId` that refers to
 *      a missing id demotes the record to a root and emits a
 *      single warning via the injected logger; the build does
 *      NOT throw.
 *   4. As paths are resolved, register them in the
 *      `idByFoldedPath` map.  Any collision (case-folded) throws
 *      `notebook_duplicate_path`.
 *   5. Freeze both internal maps, freeze the returned
 *      `NotebookIndex`, and return.
 *
 * The optional `logger` is a small object with a single `warn`
 * method.  The builder invokes `logger.warn` exactly once per
 * orphan record whose `parentId` does not exist in the input;
 * it never invokes the logger on any other code path.
 */
export const buildNotebookIndex = (
  records: readonly NotebookRecord[],
  logger?: { warn(message: string): void },
): NotebookIndex => {
  // -------------------------------------------------------------------
  // Step 1 — validate every record.
  // -------------------------------------------------------------------

  const validated: NotebookRecord[] = [];
  for (const record of records) {
    if (!isValidId(record.id)) {
      throw new NotebookIndexError("notebook_invalid_id");
    }
    if (!isValidTitle(record.title)) {
      throw new NotebookIndexError("notebook_invalid_title");
    }
    validated.push(record);
  }

  // -------------------------------------------------------------------
  // Step 2 — reject duplicate ids.
  // -------------------------------------------------------------------

  const recordById = new Map<string, NotebookRecord>();
  for (const record of validated) {
    if (recordById.has(record.id)) {
      throw new NotebookIndexError("notebook_duplicate_id");
    }
    recordById.set(record.id, record);
  }

  // -------------------------------------------------------------------
  // Step 3 — resolve every record's titlePath, detecting cycles
  // and orphans.
  // -------------------------------------------------------------------

  const pathById = new Map<string, string>();
  const idByFoldedPath = new Map<string, string>();

  /**
   * Resolve a record's titlePath by walking its parent chain.
   *
   * The walk uses a per-call `visiting` set so a cycle (including
   * a self-edge `A.parentId = A`) is detected the moment we
   * revisit a node already on the current path.  When the walk
   * crosses a `parentId` that is not present in the input list,
   * the orphan demotes itself to a root, a warning is emitted,
   * and the walk continues from there.
   *
   * The walk is memoised by id via `pathById` so a record that
   * appears as a parent to multiple children is resolved once.
   * Memoisation cannot short-circuit a cycle in the current
   * walk because the per-call `visiting` set guards against
   * revisiting an ancestor that is currently on the stack;
   * however, a previously-resolved id whose own path is stable
   * can be reused safely.
   */
  const resolvePath = (record: NotebookRecord): string => {
    // `segments` accumulates titles in leaf-to-root order as we
    // walk the parent chain.  When the walk ends (root reached)
    // we reverse to produce the canonical root-to-leaf path.
    const segments: string[] = [];
    const visiting = new Set<string>();
    let cursor: NotebookRecord | undefined = record;
    while (cursor !== undefined) {
      if (visiting.has(cursor.id)) {
        throw new NotebookIndexError("notebook_cycle");
      }
      visiting.add(cursor.id);

      // If we have already resolved this record on a prior walk
      // (it is an ancestor of multiple children), reuse its
      // cached titlePath.  We check the cache BEFORE pushing
      // `cursor.title` so the cached path is not duplicated.
      // Our gathered `segments` are in leaf-up order; reverse
      // them to a root-down prefix and concatenate after the
      // cached path.
      const cached = pathById.get(cursor.id);
      if (cached !== undefined) {
        if (segments.length === 0) {
          return cached;
        }
        const head = segments.slice().reverse().join("/");
        return `${cached}/${head}`;
      }

      segments.push(cursor.title);

      const parentId = cursor.parentId;
      if (parentId === undefined) {
        cursor = undefined;
      } else {
        const parent = recordById.get(parentId);
        if (parent === undefined) {
          // Missing parent: demote to root.  Emit a single
          // warning per orphan, then stop walking.  This branch
          // is intentionally NOT a throw — a missing parent
          // must not poison the index, it just makes the
          // orphan its own root.
          if (logger !== undefined) {
            logger.warn("notebook parent missing; treating orphan as root");
          }
          cursor = undefined;
        } else {
          cursor = parent;
        }
      }
    }

    // `segments` is in leaf-to-root order; reverse for the
    // canonical root-to-leaf titlePath.
    return segments.slice().reverse().join("/");
  };

  for (const record of validated) {
    const path = resolvePath(record);
    pathById.set(record.id, path);

    // -----------------------------------------------------------------
    // Step 4 — reject duplicate resolved paths (case-folded).
    // -----------------------------------------------------------------

    const folded = asciiFold(path);
    if (idByFoldedPath.has(folded)) {
      throw new NotebookIndexError("notebook_duplicate_path");
    }
    idByFoldedPath.set(folded, record.id);
  }

  // -------------------------------------------------------------------
  // Step 5 — freeze the internal maps and return the accessor.
  // -------------------------------------------------------------------

  Object.freeze(pathById);
  Object.freeze(idByFoldedPath);

  const resolvePathAccessor = (id: string): string | undefined => pathById.get(id);
  const resolveIdAccessor = (path: string): string | undefined => {
    if (typeof path !== "string") return undefined;
    return idByFoldedPath.get(asciiFold(path));
  };
  const sizeAccessor = (): number => pathById.size;

  Object.setPrototypeOf(resolvePathAccessor, null);
  Object.setPrototypeOf(resolveIdAccessor, null);
  Object.setPrototypeOf(sizeAccessor, null);
  Object.freeze(resolvePathAccessor);
  Object.freeze(resolveIdAccessor);
  Object.freeze(sizeAccessor);

  const index: NotebookIndex = Object.freeze({
    resolvePath: resolvePathAccessor,
    resolveId: resolveIdAccessor,
    size: sizeAccessor,
  });

  return index;
};
