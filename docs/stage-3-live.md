# Stage 3 — Read-only native sync

## Current status

Stage 3 preparation is offline-only. The pinned `@notesnook/core@8.1.3` runtime has been initialized successfully in a disposable `/tmp` state, but no authenticated account sync has been exercised from this slice.

The first live proof remains gated on an operator-owned interactive session. It must reopen a fresh authenticated state, perform a read-only native sync, list/read known data, and record a categorical pass or fail. Offline tests do not substitute for that proof.

## Safe preparation boundary

The Stage 3 surface must remain read-only:

- allow `full`/`fetch` sync only; never expose `send`;
- expose notebook and note metadata reads plus title/body search only;
- do not expose the raw `Database`, generic transport, collection mutators, or file-storage writes;
- preserve the canonical `kv.token` persistence boundary;
- normalize upstream failures to categorical errors without forwarding causes, paths, tokens, passwords, or note corpus data;
- use injected fakes for all offline tests; no live account or network is required for the test suite.

## Future operator gate

Run from a disposable state directory in an interactive TTY. Do not send credentials or MFA codes through chat.

```bash
NOOKBRIDGE_ENABLE_LIVE_AUTH=1 \
NOOKBRIDGE_ENABLE_LIVE_SYNC=1 \
NOOKBRIDGE_STATE_DIR="$PWD/var/state/stage-3-live-poc" \
nix develop --offline --command node dist/cli.js auth live-login
```

After the login command reports a categorical authenticated result, run the read-only status/sync proof supplied by the completed Stage 3 implementation. Then edit a disposable test note from the official Notesnook client on a second device and verify that the bridge can read its metadata/content without issuing a write or delete request.

Required live scenarios for the later Gate 3 review:

- notebook and note listing;
- known title/body search canary;
- Vault-locked note handling;
- second-device edit visibility;
- deliberate two-device conflict observation;
- clean teardown and restart from the same disposable state.

A live pass must include the requested state directory, categorical command outcomes, and evidence that no plaintext corpus sidecar was created. Remote logout/revoke remains a separate unproven boundary unless explicitly tested.

## Offline validation

```bash
nix develop --offline --command npm test
nix develop --offline --command npm run typecheck
nix develop --offline --command npm run lint
nix develop --offline --command npm run format:check
nix develop --offline --command npm run build
git diff --check
```
