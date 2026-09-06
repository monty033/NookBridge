# Stage 9 source-evidence receipt

Status: **SOURCE PASS — VM and production gates remain open**

Date: 2026-09-06
Source merge: `909ec4a9d19eac2adf7a1a9bbeac573d82caee69` (PR #51)
Source repository: `patrick/NookBridge`
Permission profile: `operator` CLI only; Hermes-facing MCP/RPC remains unchanged
Live account exercised: **false**

This receipt records source-level evidence for Stage 9 §13.11. It does not
claim a clean VM result, a target-host canary, a deployed Nix pin, or production
acceptance. Those are independent gates.

## Executive summary

- The bounded operator `tree` CLI is merged and source-tested.
- Notes browse/search/get are merged with bounded metadata, opaque handles,
  cursors, stdin query input, and categorical formatting.
- Notes edit/undo is merged as a source-level operator runtime with exact
  approval gates, encrypted NBV1 preimages, expiry, optimistic revision checks,
  stale-undo refusal, and cleanup.
- `notes.delete` remains structurally absent; no MCP/RPC method or service policy
  was added for the CLI feature.
- Production edit/undo remains deliberately unavailable because the live
  read-only projection does not yet prove a safe note-body and revision source.
- The source implementation gate is closed; VM drill and production gates are
  still open.

## Snapshot identity

| Field | Value |
| --- | --- |
| Reviewed source merge | `909ec4a9d19eac2adf7a1a9bbeac573d82caee69` |
| Review request | PR #51 — `feat: add bounded notes edit undo runtime` |
| Source branch | `openclaw:feat/stage9-notes-edit-undo` |
| Base branch | `main` |
| Source review | Independent review `deleg_60b6619d`: PASS |
| Source review findings | No security concerns or blocking logic errors |
| Live account | Not exercised |
| VM evidence | Not produced for this source receipt |
| Production canary | Not performed |

## Plan-bullet to source evidence

| Plan requirement | Source evidence | Status |
| --- | --- | --- |
| Operator-only CLI tree | `src/cli.ts:1-1032`; `src/operator/tree-cli.ts:1-192`; `tests/stage-9-tree-cli.test.ts:1-166` | DONE — source |
| Allowlisted metadata-only filetree | `src/operator/tree-runtime.ts:1-180`; `tests/stage-9-tree-cli.test.ts:1-166` | DONE — source |
| Opaque handles and cursors | `src/operator/tree-runtime.ts:1-180`; `src/operator/notes-cli.ts:186-212`; `tests/stage-9-tree-cli.test.ts:1-166` | DONE — source |
| Bounded notes browse/search/get | `src/operator/notes-cli.ts:259-293, 500-760`; `src/operator/notes-read-runtime.ts:1-330`; `tests/stage-9-notes-cli.test.ts:1-1032`; `tests/stage-9-notes-read-runtime.test.ts:1-51` | DONE — source |
| Stdin-only query, edit content, and undo token | `src/operator/notes-cli.ts:74-115, 338-430`; `src/cli.ts:290-370`; `tests/stage-9-notes-cli.test.ts:1-1032`; `tests/stage-9-notes-cli-dispatch.test.ts:1-677` | DONE — source |
| Exact edit/undo approval gate | `src/operator/notes-cli.ts:55-62, 221-245, 400-430`; `tests/stage-9-notes-cli.test.ts:1-1032`; `tests/stage-9-notes-cli-dispatch.test.ts:1-677` | DONE — source |
| Encrypted bounded expiring undo preimage | `src/operator/notes-undo-journal.ts:1-600`; `src/operator/notes-edit-runtime.ts:1-287`; `tests/stage-9-notes-undo-journal.test.ts:1-53`; `tests/stage-9-notes-edit-runtime.test.ts:1-146` | DONE — source |
| Optimistic revision conflict and inverse update | `src/operator/notes-edit-runtime.ts:31-215`; `tests/stage-9-notes-edit-runtime.test.ts:97-145` | DONE — source |
| Closed categorical output and redaction | `src/operator/notes-cli.ts:254-293, 760-1032`; `src/operator/notes-edit-runtime.ts:82-215`; `tests/stage-9-notes-cli.test.ts:1-1032` | DONE — source |
| No delete capability | `src/operator/notes-cli.ts:221-245, 760-1032`; `src/service/rpc-protocol.ts:1-260`; `src/service/service-policy.ts:1-260`; `tests/stage-9-notes-cli-dispatch.test.ts:391-430` | DONE — source |
| Existing production source is safe to wire | `src/operator/notes-production-runtime.ts:1-260`; `src/core/notesnook-readonly-adapter.ts:1-260` | PARTIAL — edit/undo remains categorically unavailable pending a proven live body/revision source |
| VM service identity, socket, state, and credential boundary | `docs/stage-9-canary.md:14-37` | OPEN — existing evidence is against an older source/pin |
| Target-host canary and production edit canary | `docs/stage-9-canary.md:39-60` | OPEN — not performed |

## Source gate evidence

### Deterministic verification

All commands ran in the pinned offline development shell against the source
snapshot that became PR #51, with the final post-review source change included:

```text
focused edit/undo + CLI tests: PASS
full suite: 50 files / 1,491 tests PASS
npm run lint: PASS
npm run format:check: PASS
npm run typecheck: PASS
npm run build: PASS
git diff --check: PASS
```

The independent review re-ran the four touched test files with **234/234
passing** and returned **PASS** with no security concerns or blocking logic
errors.

### Boundary evidence

- Parser failures happen before runtime construction.
- Edit input is a closed JSON object containing only `content` and `undoToken`.
- Edit content is UTF-8 byte-bounded; undo input accepts only one optional
  trailing newline and a bounded opaque token.
- Caller-supplied tokens are checked against the opaque grammar and never
  printed.
- The undo journal uses the existing AES-256-GCM `NBV1` framing and stores
  ciphertext only through its bounded store interface.
- The edit runtime records the preimage before mutation, requires a predicted
  exact next revision, and supplies the original revision as the mutation
  precondition.
- Undo refuses expiry, missing entries, stale revisions, and ambiguous source
  state without applying an inverse update.
- Internal undo metadata is removed before restoring note metadata.
- Formatter results remain categorical and do not include note bodies, titles,
  handles, tokens, revisions, paths, or native errors.
- `notes.delete` is absent from the CLI command union and remains absent from
  the RPC/MCP method universe.

## Independent gate matrix

| Gate | Required evidence | Current status |
| --- | --- | --- |
| Source | Source/tests, full static gates, focused tests, independent review | **PASS** |
| VM | Reviewed source pin, clean disposable VM, service/socket/state/credential and CLI drills | **OPEN** |
| Production | Merged source + Nix pin, privileged rebuild, read-only canary, separately approved edit canary | **OPEN** |

The source pass does not close either operational gate.

## Explicit deferrals and caveats

- No real Notesnook credentials, account, sync transport, or live remote write
  was used.
- The current production notes runtime intentionally returns categorical
  unavailable for edit/undo. The source adapter is tested through injected
  seams only; wiring it to production requires a separately reviewed live
  source that proves bounded note body and revision values.
- Existing VM evidence in `docs/stage-9-canary.md` is baseline evidence for an
  older source/pin and must not be reused as proof for this merge.
- The VM drill must exercise the reviewed deployment pin and include bounded
  tree output, note browse/read, approved edit, stale-revision conflict, undo,
  cleanup, and negative-containment output checks.
- The production gate must keep the deployed policy read-only until a separate
  authorization enables any write-capable canary. Local update and remote sync
  outcomes must be recorded separately.

## Next gate order

1. Update the Nix consumer pin to this merged source revision only after the VM
   drill input is prepared.
2. Run the clean disposable VM drill against that pin and record a separate VM
   receipt.
3. Run the target-host read-only canary after the reviewed pin is deployed.
4. Treat any production edit canary as a separate explicit authorization and
   receipt; do not infer it from source or VM success.
