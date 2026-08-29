# Stage 3 — Read-only native sync

## Current status

The Stage 3 read-only native-sync POC and the conflict/locked-note proof seam are **merged**. The pinned `@notesnook/core@8.1.3` runtime is projected into a flattened read-only handle, the operator command is separately gated by `NOOKBRIDGE_ENABLE_LIVE_SYNC=1`, and the fetch-only boundary remains enforced.

The completed live receipts cover persisted-state reopen, fetch-only native sync, bounded notebook metadata, title-safe search, body-keyword search with title-only output, remote rename visibility after restart, and clean teardown. PR #18 adds deterministic conflict-marker and Vault-locked body-refusal coverage, but live conflict and locked-note account proof is still pending. A local-only fixture additionally models pinned Notesnook behavior in which the device that detects a conflict has `conflicted=true` on its local note while an independent fresh fetch-only projection of the same remote note has no conflict marker. This is offline evidence only: the phone UI conflict is a separate upstream observation, and independent live conflict visibility is deferred to the later local-state phase. Offline tests do not substitute for live compatibility, so the proof remains recorded separately from the automated matrix.

## Safe preparation boundary

The Stage 3 surface must remain read-only:

- allow `fetch` sync only; reject `full`, `send`, and forced sync before any upstream call because upstream `full` includes a send phase;
- expose notebook and note metadata plus title-safe lookup/search only;
- do not expose the raw `Database`, generic transport, collection mutators, note bodies, or file-storage writes;
- preserve the canonical `kv.token` persistence boundary;
- normalize upstream failures to categorical errors without forwarding causes, paths, tokens, passwords, or note corpus data;
- use injected fakes for all offline tests; no live account or network is required for the test suite;
- always tear down the production runtime after the proof attempt.

The production path is lazy: the CLI parses and checks the command and sync gate before constructing the live runtime. The runtime exposes only the flattened read-only projection; the raw core handle remains internal.

## Operator reproduction

Run from the repository with the fixed disposable state path in an interactive TTY. Do not send credentials or MFA codes through chat.

```bash
nix develop --offline --command just live-login
```

After the login command reports a categorical authenticated result, run:

```bash
nix develop --offline --command just live-status
nix develop --offline --command just live-sync
```

The Stage 3 initial proof, search canaries, and remote-change restart proof are
complete. The remaining operator Gate 3 work is the title-based Vault-locked-
note canary against disposable test data. Independent live conflict visibility
is deferred to the later local-state phase because the upstream conflict marker
is device-local and is not observable by a fresh fetch-only client. The bridge
must not issue a `send`, mutation, delete, or write operation.

Required live scenarios for the later Gate 3 review:

- notebook and note listing — passed;
- known title-safe search canary — passed;
- body-keyword search with bounded title-only output — passed;
- second-device edit visibility after restart — passed;
- deliberate two-device conflict observation — deferred to the later local-state phase;
- Vault-locked note handling without body exposure — pending live proof;
- clean teardown and restart from the same disposable state — passed.

A live pass must include the requested state directory, categorical command outcomes, and evidence that no plaintext corpus sidecar was created. Remote logout/revoke remains a separate unproven boundary unless explicitly tested.

## Offline validation

Focused Stage 3 coverage exercises the projection, redaction, forbidden sync type, separate gate, successful proof, and teardown. The full offline matrix must remain green:

```bash
nix develop --offline --command just check
nix develop --offline --command npx vitest run tests/stage-3-read-only-sync.test.ts
nix develop --offline --command npm test
nix develop --offline --command npm run typecheck
nix develop --offline --command npm run lint
nix develop --offline --command npm run format:check
nix develop --offline --command npm run build
git diff --check
```
