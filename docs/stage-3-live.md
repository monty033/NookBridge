# Stage 3 — Read-only native sync

## Current status

The offline Stage 3 wiring slice is complete on the dedicated branch, but Stage 3 is **not yet passed**. The pinned `@notesnook/core@8.1.3` runtime is now projected into a flattened read-only handle, and the operator command is separately gated by `NOOKBRIDGE_ENABLE_LIVE_SYNC=1`. No authenticated account sync has been exercised from this slice.

The first live proof remains gated on an operator-owned interactive session. It must reopen a fresh authenticated state, perform a read-only native sync, list/read known metadata, and record a categorical pass or fail. Offline tests do not substitute for that proof.

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

## Future operator gate

Run from a disposable state directory in an interactive TTY. Do not send credentials or MFA codes through chat.

```bash
NOOKBRIDGE_ENABLE_LIVE_AUTH=1 \
NOOKBRIDGE_STATE_DIR="$PWD/var/state/stage-3-live-poc" \
nix develop --offline --command node dist/cli.js auth live-login
```

After the login command reports a categorical authenticated result, run:

```bash
NOOKBRIDGE_ENABLE_LIVE_SYNC=1 \
NOOKBRIDGE_STATE_DIR="$PWD/var/state/stage-3-live-poc" \
nix develop --offline --command node dist/cli.js sync read-only
```

Then edit one disposable test note from the official Notesnook client on a second device and repeat the read-only command with `--note-id <id>` or `--query <title>`. The bridge must not issue a `send`, mutation, delete, or write operation.

Required live scenarios for the later Gate 3 review:

- notebook and note listing;
- known title-safe search canary;
- Vault-locked note handling without body exposure;
- second-device edit visibility;
- deliberate two-device conflict observation;
- clean teardown and restart from the same disposable state.

A live pass must include the requested state directory, categorical command outcomes, and evidence that no plaintext corpus sidecar was created. Remote logout/revoke remains a separate unproven boundary unless explicitly tested.

## Offline validation

Focused Stage 3 coverage currently exercises the projection, redaction, forbidden sync type, separate gate, successful proof, and teardown. The full offline matrix must remain green:

```bash
nix develop --offline --command npx vitest run tests/stage-3-read-only-sync.test.ts
nix develop --offline --command npm test
nix develop --offline --command npm run typecheck
nix develop --offline --command npm run lint
nix develop --offline --command npm run format:check
nix develop --offline --command npm run build
git diff --check
```
