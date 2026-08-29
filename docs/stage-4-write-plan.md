# Stage 4 — Safe Writes and Bidirectional Sync Plan

**Status:** Active implementation plan. The pure write contract and local mutation adapter are merged; the next bounded slice is write-side runtime wiring. No remote sync, write CLI, or live write operation is included in the current slice.

**Goal:** Add narrowly guarded create, append, and update behavior to the proven Notesnook client while preserving revision safety, bounded synchronization, and an auditable separation between local commit and remote sync.

**Prerequisite:** Stage 3 Gate 3 is closed for the current fetch-only/read-only POC. The Vault-locked-note canary passed on 2026-08-29. Independent live conflict visibility remains deferred until the later local-note editing phase because Notesnook exposes that marker through device-local sync state rather than a fresh fetch-only projection.

## Verified progress

- **PR #22 — pure write contract:** merged at `0081e387`. Bounded commands, opaque revisions, categorical errors, and mutation-free validation are covered by the offline contract suite.
- **PR #23 — local mutation adapter:** merged at `d976547`. The separately named `NotesnookWriteDatabase` seam now supports local create, append, and controlled update with fresh revision checks, locked/conflict/unsupported-content guards, explicit Markdown-to-stored-content codec handling, and local-only outcome flags.
- **Offline receipts for PR #23:** 378/378 full tests, 28/28 adapter tests, 68/68 contract tests, strict typecheck, lint, format check, build, offline flake check, and independent specification/security reviews all passed.
- **Current limitation:** the write seam is not yet constructed from the live Notesnook runtime. No live write canary has been claimed. Remote synchronization, write CLI exposure, and local conflict observation remain deferred.

## Next bounded slice — write-side runtime wiring

Construct a separately named `NotesnookWriteDatabase` capability from the pinned local Notesnook runtime without changing `NotesnookReadOnlyDatabase` or `NotesnookLiveDatabase`. Wire only the explicit note/content/notebook/tag/relation slots consumed by the local mutation adapter, and preserve the existing fetch-only sync boundary.

Required boundaries:

- no raw `Database`, generic collection passthrough, transport, credential, or encrypted-record exposure;
- no `sync`, `send`, `full`, delete, force overwrite, Vault unlock, or write CLI path;
- no plaintext body caching or persistence;
- production wiring must use the same stored-content representation and codec contract as the local adapter;
- offline tests must use a fake runtime seam plus structural rejection tests before any operator-local live canary is considered;
- the live write canary remains a later gate after the wiring, offline matrix, and independent security review pass.

## Non-negotiable boundaries

- Keep the existing Stage 3 projection read-only; do not widen `NotesnookReadOnlyDatabase`.
- Add writes behind a separate explicit Stage 4 capability and gate. Existing read-only callers must not gain write access accidentally.
- Never expose the raw Notesnook `Database`, generic transport, collection mutators, credential carrier, or encrypted content records to Hermes.
- Every replace/update operation requires an `expectedRevision`; stale revisions fail closed.
- Do not expose delete, reset, force-overwrite, arbitrary core-method calls, or Vault unlock/password operations.
- Report local commit and remote synchronization as separate outcomes.
- Queue/coalesce synchronization through a single-flight coordinator; do not issue an unconditional full sync after every mutation.
- Preserve categorical errors and redact paths, credentials, note bodies, upstream causes, and transport details.
- Keep all live authentication and live write testing operator-local in an interactive TTY.

## Proposed sequence

### 1. Define the write contract

Document and type the smallest application-layer commands:

- `createNote(title, content, notebookId?, tags?)`
- `appendNote(id, markdownFragment, expectedRevision)`
- `updateNote(id, patch, expectedRevision)`

Define bounded input sizes, allowed fields, stable result shapes, revision tokens, and categorical errors including `stale_revision`, `conflict`, `vault_locked`, `unsupported_content`, and `sync_failed`.

**Likely files:** `src/core/` write contract module; `docs/upstream-contract.md`; Stage 4 tests.

### 2. Add a narrow local mutation adapter

Wrap only the pinned Notesnook operations required by the contract. Validate IDs, titles, content size, notebook references, patch fields, and revision tokens before any upstream/core call. Keep body access explicit and request-scoped; never cache or export a plaintext corpus.

**Likely files:** new `src/core/notesnook-write-adapter.ts`; existing adapter/projection tests as needed.

### 3. Add revision and conflict guards

Read the current revision immediately before mutation, compare it with `expectedRevision`, and fail closed on mismatch. Do not silently choose a side. Preserve the local Notesnook conflict signal when the local client has materialized one; the independent live conflict observer remains a later local-state task.

**Tests:** stale update rejection, repeated revision race, locked-note refusal, unsupported replacement, and categorical redaction.

### 4. Separate local commit from remote sync

Introduce a `SyncCoordinator` with single-flight execution, bounded retry/backoff, explicit pending state, and no uncontrolled request amplification. A successful local mutation must not be reported as remotely synchronized until a separate fetch/send policy confirms that result.

**Likely files:** new `src/core/notesnook-sync-coordinator.ts`; persistence/state tests; no changes to the Stage 3 fetch-only boundary.

### 5. Implement create, append, and controlled update

Implement the contract one operation at a time using TDD:

1. failing unit test;
2. minimal adapter/coordinator implementation;
3. categorical failure and redaction tests;
4. formatting round-trip test;
5. focused and full offline validation;
6. independent security review before the next operation.

Do not add delete or generic mutation methods.

### 6. Add the Stage 4 operator seam

Expose write commands only through a separately named, explicitly gated operator path. Keep credentials/MFA out of argv, chat, logs, PRs, and persistent config. The Stage 3 `sync read-only` command remains fetch-only and unchanged.

**Likely files:** `src/cli.ts`, Stage 4 command/admin module, `tests/stage-4-write.test.ts`, and operator documentation.

### 7. Offline acceptance matrix

The complete offline matrix must cover:

- create returns the bounded local result;
- append preserves existing Markdown and adds exactly one fragment;
- controlled update preserves fields outside the patch;
- stale revision is rejected without mutation;
- locked-note writes fail with `vault_locked` and no body leakage;
- unsupported content fails closed;
- offline mutations remain pending rather than falsely remote-synced;
- burst writes are serialized/coalesced;
- simulated 429/Retry-After/transient failures use bounded backoff;
- no credentials, bodies, or plaintext canaries appear in state, logs, temp files, or errors;
- existing Stage 3 focused/full tests remain green.

### 8. Operator Gate 4 canaries

Only after the offline matrix and S4 security review pass, use disposable notes in an interactive TTY to prove:

- bridge creates a note visible on phone/laptop;
- append preserves content and formatting;
- stale revision is rejected after a remote edit;
- offline write becomes pending and later synchronizes;
- burst writes do not amplify upstream requests;
- transient throttling does not lose pending state;
- clean restart recovers pending work without duplicate mutation.

Record categorical outcomes only. Do not inspect or commit generated `var/` state.

## Security checkpoint S4

Run the RT-10 resource/upstream-abuse review against the functional POC. A failure blocks Stage 4 completion. The review must specifically verify single-flight synchronization, bounded retries, stale-write behavior, no delete/force escape hatch, no plaintext persistence, no credential leakage, and no accidental widening of the Stage 3 read-only projection.

## Exit criteria

Stage 4 is complete only when:

- all offline acceptance tests and the existing Stage 3 matrix pass;
- the exact write boundary has an independent security review marked PASS;
- all disposable live Gate 4 canaries pass with categorical receipts;
- pending/offline/retry behavior is demonstrated;
- no delete, force-overwrite, Vault unlock, or arbitrary core-method path exists;
- the implementation plan records the receipts and remaining limitations.

The later local-state conflict phase remains separate. It is not substituted by the fetch-only fixture or by the Stage 4 write canaries.
