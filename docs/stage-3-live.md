# Stage 3 — Read-only native sync

## Current status

The initial Stage 3 read-only native-sync POC is **passed and merged**. The pinned `@notesnook/core@8.1.3` runtime is projected into a flattened read-only handle, the operator command is separately gated by `NOOKBRIDGE_ENABLE_LIVE_SYNC=1`, and a fresh authenticated disposable-state proof completed successfully.

The proof reopened persisted authenticated state, performed fetch-only native sync, returned 41 notebook summaries without exposing note bodies, and completed teardown cleanly. Offline tests do not substitute for live compatibility, so the proof remains recorded separately from the automated matrix.

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

The initial proof is complete. The remaining Gate 3 work is to use disposable test data to verify known title/body search behavior, restart after remote changes, conflict visibility, and locked-note handling. The bridge must not issue a `send`, mutation, delete, or write operation.

Required live scenarios for the later Gate 3 review:

- notebook and note listing;
- known title-safe search canary;
- Vault-locked note handling without body exposure;
- second-device edit visibility;
- deliberate two-device conflict observation;
- clean teardown and restart from the same disposable state.

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
