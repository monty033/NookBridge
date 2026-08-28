/**
 * Stage 3 — operator-only offline proof runner for read-only native sync.
 *
 * This module is the small proof runner the §13.7 Stage 3 handoff
 * names as the "first proof": reopen authenticated state, perform a
 * read-only native sync, report a repeatable pass/fail.  The slice
 * is offline-only — no live account, no live network, no real
 * `@notesnook/core` runtime import.  Production callers wire it to
 * an already-constructed read-only adapter (itself backed by the
 * {@link flattenLiveDatabaseToReadOnly} projection when the live
 * handle is available); offline tests wire it to a deterministic
 * fake that the test owns.
 *
 * Why a dedicated proof runner instead of more CLI surface?
 *
 *   - The §13.7 Gate 3 first proof is a single sequenced operation:
 *     reopen, sync, list, metadata, search.  Inlining it into the
 *     CLI command layer would force the CLI to construct the
 *     read-only adapter directly, leaking adapter internals into the
 *     command boundary.
 *   - A dedicated module lets the CLI dispatch through one narrow
 *     `runOfflineSyncProof(options) -> RunOfflineSyncProofResult`
 *     surface.  The CLI prints the categorical outcome and the
 *     runner keeps every async / categorisation concern in one
 *     place that is straightforward to drive offline.
 *   - It also gives the operator a deterministic, repeatable
 *     pass/fail report — the "repeatable pass/fail" clause of the
 *     §13.7 first proof.
 *
 * Public surface
 * --------------
 *
 *   - {@link runOfflineSyncProof} — execute the offline proof
 *     against the injected source and return a categorical report.
 *
 *   - {@link formatOfflineSyncProofReport} — render the report to a
 *     multi-line human-readable string that never carries note
 *     bodies, error messages with upstream detail, or any byte that
 *     could be a credential / token.
 *
 * Categorical error normalisation
 * --------------------------------
 *
 * Every upstream rejection (whether thrown or rejected) is mapped
 * to a categorical {@link OfflineSyncProofError} whose `cause` and
 * `__context__` are explicitly cleared.  The marker is a private
 * `WeakSet<object>` keyed on object identity; the public predicate
 * is {@link isOfflineSyncProofError}.
 */

import {
  createNotesnookReadOnlyAdapter,
  isNotesnookReadOnlyAdapterError,
  type NotesnookReadOnlyAdapter,
  type NotesnookReadOnlyDatabaseSource,
  type NotesnookReadOnlyNoteMetadata,
  type NotesnookReadOnlyNotebookSummary,
  type NotesnookReadOnlySearchHit,
  type NotesnookReadOnlyStatus,
} from "./notesnook-readonly-adapter.js";

// ---------------------------------------------------------------------------
// Categorical error.
//
// Identified by object identity through a module-private `WeakSet`.
// `cause` and `__context__` are explicitly cleared so a hostile
// source cannot smuggle upstream payload text out of the proof
// boundary.
// ---------------------------------------------------------------------------

const PROOF_ERRORS = new WeakSet<object>();

/**
 * Categorical, chain-free proof error.
 */
export class OfflineSyncProofError extends Error {
  constructor(message: string) {
    super(message);
    Object.defineProperty(this, "cause", { configurable: true, value: undefined });
    Object.defineProperty(this, "__context__", { configurable: true, value: undefined });
    Object.defineProperty(this, "name", { configurable: true, value: "OfflineSyncProofError" });
    PROOF_ERRORS.add(this);
  }
}

/**
 * Public predicate: is `value` a proof-owned error emitted by this
 * module?  Recognised by object identity, not by message text.
 */
export function isOfflineSyncProofError(value: unknown): value is OfflineSyncProofError {
  return typeof value === "object" && value !== null && PROOF_ERRORS.has(value as object);
}

function proofError(message: string): OfflineSyncProofError {
  return new OfflineSyncProofError(message);
}

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Single-step outcome the offline proof records.  Every step is
 * either `pass` (the closed read-only surface returned a structurally
 * valid value) or `fail` (categorical failure).  The proof NEVER
 * carries the raw upstream value, message, or cause — only the
 * categorical step name and the high-level outcome.
 */
export type OfflineSyncProofStep = Readonly<{
  name: "open" | "status" | "sync" | "list-notebooks" | "note-metadata" | "search" | "close";
  status: "pass" | "fail";
  /** Categorical step detail; never carries upstream error text. */
  detail: string;
}>;

export type OfflineSyncProofReport = Readonly<{
  kind: "pass" | "fail";
  steps: ReadonlyArray<OfflineSyncProofStep>;
  /** Aggregate counts so a CLI can render a one-line summary. */
  summary: Readonly<{
    notebooks: number;
    notes: number;
    searchHits: number;
    syncStartedAt: number;
    syncCompletedAt: number;
  }>;
  /** Categorical message; never carries upstream error text. */
  message: string;
}>;

/**
 * Options accepted by {@link runOfflineSyncProof}.
 *
 * The `source` is the injected seam — either an already-resolved
 * `NotesnookReadOnlyDatabase` or a factory returning one.  Production
 * callers wire the projection's output through this seam.  Offline
 * tests pass a deterministic fake.
 *
 * The `query` is the optional title-only search query the proof runs
 * against the source after a successful sync.  It is only validated
 * for shape here; the adapter's `search` rejects empty queries.
 *
 * `noteMetadataId` is the optional note id the proof reads metadata
 * for.  It is only validated for shape here; the adapter's
 * `noteMetadata` rejects empty ids.
 */
export type RunOfflineSyncProofOptions = Readonly<{
  source: NotesnookReadOnlyDatabaseSource;
  query?: string;
  noteMetadataId?: string;
  /** Status uses the same bounded runner without initiating sync. */
  performSync?: boolean;
}>;

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

/**
 * Execute the offline read-only sync proof against the injected
 * source.  The runner:
 *
 *   1. Resolves the source and constructs the read-only adapter.
 *   2. Reads the closed status snapshot.
 *   3. Issues `sync({type: "fetch"})`.  Upstream `full` sync includes
 *      a send phase, so the proof deliberately uses fetch only.
 *   4. Lists notebook summaries through the adapter.
 *   5. Reads note metadata for the supplied id (if any).
 *   6. Runs the title-only search through the adapter (if a query
 *      was supplied).
 *
 * The runner NEVER touches the raw source outside of the closed
 * adapter surface — every operation goes through the adapter's
 * hostile-proxy-safe boundary.  Failures at any step are mapped to
 * a categorical {@link OfflineSyncProofError}; the report's `kind`
 * is `"fail"` and the offending step is the last entry in `steps`.
 *
 * The returned report never carries note bodies, error message text
 * from the source, or any byte that could be a credential / token.
 */
export async function runOfflineSyncProof(
  options: RunOfflineSyncProofOptions,
): Promise<OfflineSyncProofReport> {
  const startedAt = Date.now();
  const steps: OfflineSyncProofStep[] = [];
  const summary = {
    notebooks: 0,
    notes: 0,
    searchHits: 0,
    syncStartedAt: 0,
    syncCompletedAt: 0,
  };

  // Step 1 — open.  Constructing the read-only adapter resolves the
  // injected source and validates the allowlist.  A forged handle
  // is rejected here with a categorical adapter error.
  let adapter: NotesnookReadOnlyAdapter;
  try {
    adapter = createNotesnookReadOnlyAdapter({ source: options.source });
    steps.push({ name: "open", status: "pass", detail: "read-only adapter constructed" });
  } catch (error) {
    const detail = normaliseErrorMessage(error, "open");
    steps.push({ name: "open", status: "fail", detail });
    return failedReport(steps, summary);
  }

  // Step 2 — status.  Reads the closed status snapshot.  Both
  // upstream calls are read-only metadata accessors.
  try {
    const status: NotesnookReadOnlyStatus = await adapter.status();
    if (typeof status?.lastSynced !== "number" || typeof status?.hasUnsyncedChanges !== "boolean") {
      throw proofError("read-only status snapshot is malformed");
    }
    steps.push({
      name: "status",
      status: "pass",
      detail: "status snapshot read",
    });
  } catch (error) {
    const detail = normaliseErrorMessage(error, "status");
    steps.push({ name: "status", status: "fail", detail });
    return failedReport(steps, summary);
  }

  // Step 3 — sync.  `status` deliberately skips this step; the
  // read-only command issues `"fetch"` without `force`.  Upstream
  // `full` sync includes a send phase and is therefore not allowed.
  if (options.performSync !== false) {
    summary.syncStartedAt = Date.now();
    let syncOutcome: boolean;
    try {
      syncOutcome = await adapter.sync({ type: "fetch" });
      if (typeof syncOutcome !== "boolean") {
        throw proofError("sync returned a non-boolean result");
      }
      summary.syncCompletedAt = Date.now();
      steps.push({
        name: "sync",
        status: "pass",
        detail: syncOutcome ? "sync attempt completed" : "sync attempt reported no work",
      });
    } catch (error) {
      summary.syncCompletedAt = Date.now();
      const detail = normaliseErrorMessage(error, "sync");
      steps.push({ name: "sync", status: "fail", detail });
      return failedReport(steps, summary);
    }
  } else {
    steps.push({ name: "sync", status: "pass", detail: "sync skipped for status" });
  }

  // Step 4 — list-notebooks.  Reads the closed notebook summary
  // list.  We coerce the count to the summary for the CLI; we do NOT
  // surface any notebook body, encrypted content, or note ids here.
  let notebooks: NotesnookReadOnlyNotebookSummary[] = [];
  try {
    notebooks = await adapter.listNotebooks();
    if (!Array.isArray(notebooks)) {
      throw proofError("notebook listing is not an array");
    }
    summary.notebooks = notebooks.length;
    steps.push({
      name: "list-notebooks",
      status: "pass",
      detail: `${notebooks.length} notebook summary read`,
    });
  } catch (error) {
    const detail = normaliseErrorMessage(error, "list-notebooks");
    steps.push({ name: "list-notebooks", status: "fail", detail });
    return failedReport(steps, summary);
  }

  // Step 5 — note-metadata.  Reads metadata for the supplied id
  // (if any).  When the id is absent, the step is recorded as
  // `pass` with detail "skipped" so the report's pass/fail stays
  // driven by the upstream surface, not by an arbitrary default id.
  if (typeof options.noteMetadataId === "string" && options.noteMetadataId.length > 0) {
    try {
      const metadata: NotesnookReadOnlyNoteMetadata | undefined = await adapter.noteMetadata(
        options.noteMetadataId,
      );
      if (metadata === undefined) {
        steps.push({
          name: "note-metadata",
          status: "pass",
          detail: "note metadata reported absent",
        });
      } else if (typeof metadata.id !== "string" || typeof metadata.title !== "string") {
        throw proofError("note metadata is malformed");
      } else {
        summary.notes = 1;
        steps.push({
          name: "note-metadata",
          status: "pass",
          detail: "note metadata read",
        });
      }
    } catch (error) {
      const detail = normaliseErrorMessage(error, "note-metadata");
      steps.push({ name: "note-metadata", status: "fail", detail });
      return failedReport(steps, summary);
    }
  } else {
    steps.push({
      name: "note-metadata",
      status: "pass",
      detail: "no note id supplied",
    });
  }

  // Step 6 — search.  Title-only search through the closed surface.
  // When the query is absent, the step is recorded as `pass` with
  // detail "skipped" so the proof stays bounded on whatever the
  // operator supplied.
  if (typeof options.query === "string" && options.query.length > 0) {
    try {
      const hits: NotesnookReadOnlySearchHit[] = await adapter.search(options.query);
      if (!Array.isArray(hits)) {
        throw proofError("search returned a non-array result");
      }
      summary.searchHits = hits.length;
      steps.push({
        name: "search",
        status: "pass",
        detail: `${hits.length} title-only hit read`,
      });
    } catch (error) {
      const detail = normaliseErrorMessage(error, "search");
      steps.push({ name: "search", status: "fail", detail });
      return failedReport(steps, summary);
    }
  } else {
    steps.push({
      name: "search",
      status: "pass",
      detail: "no query supplied",
    });
  }

  steps.push({
    name: "close",
    status: "pass",
    detail: "proof completed",
  });
  void startedAt;
  return {
    kind: "pass",
    steps,
    summary,
    message: "read-only sync proof passed",
  };
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function normaliseErrorMessage(error: unknown, step: string): string {
  if (isOfflineSyncProofError(error)) {
    return `${step} failed: ${categorise(error.message)}`;
  }
  if (isNotesnookReadOnlyAdapterError(error)) {
    return `${step} failed: read-only adapter rejected the request`;
  }
  return `${step} failed: categorical error`;
}

function categorise(_message: string): string {
  // Reduce to a short categorical prefix so the report's detail
  // line never echoes upstream payload text.  We deliberately do not
  // surface the full message — the upstream may carry token bytes,
  // paths, or note corpus data we have already redacted at the
  // adapter boundary.
  return "categorical error";
}

function failedReport(
  steps: ReadonlyArray<OfflineSyncProofStep>,
  summary: OfflineSyncProofReport["summary"],
): OfflineSyncProofReport {
  return {
    kind: "fail",
    steps: [...steps, { name: "close", status: "fail", detail: "proof halted on failure" }],
    summary,
    message: "read-only sync proof failed",
  };
}

// ---------------------------------------------------------------------------
// Report formatter.
// ---------------------------------------------------------------------------

/**
 * Render an {@link OfflineSyncProofReport} as a multi-line, human
 * readable string.  The output is purely categorical: no raw upstream
 * error message text, no note body, no token bytes, no paths.
 *
 * Intended audience is an operator running the offline POC; the
 * format is deliberately plain text so it round-trips through a TTY
 * without escaping concerns.
 */
export function formatOfflineSyncProofReport(report: OfflineSyncProofReport): string {
  const lines: string[] = [];
  lines.push(`read-only sync proof: ${report.kind === "pass" ? "pass" : "fail"}`);
  for (const step of report.steps) {
    lines.push(`  - ${step.name}: ${step.status} (${step.detail})`);
  }
  lines.push(
    `  summary: notebooks=${report.summary.notebooks} ` +
      `notes=${report.summary.notes} ` +
      `searchHits=${report.summary.searchHits} ` +
      `syncStartedAt=${report.summary.syncStartedAt} ` +
      `syncCompletedAt=${report.summary.syncCompletedAt}`,
  );
  lines.push(`  ${report.message}`);
  return lines.join("\n");
}
