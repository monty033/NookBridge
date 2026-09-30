# NookBridge contributor guidance

## Repository workflow

- The canonical target is `patrick/NookBridge`; `origin` is the `openclaw/NookBridge` fork.
- Keep `main` clean. Start work from a current `upstream/main` on a dedicated branch.
- Before a PR, run the relevant checks, review the exact diff, and verify the PR head/base refs after creation.
- Do not commit generated state, credentials, or local build output.

## Development commands

Run Node commands inside the pinned offline shell:

```bash
nix develop --offline --command just check
nix develop --offline --command just stage3-test
```

`package.json` is the canonical script layer. `Justfile` provides thin operator shortcuts; do not duplicate build logic there.

## Security boundaries

- Never place Notesnook passwords, MFA codes, tokens, encryption keys, or state contents in chat, argv, environment snapshots, logs, commits, or PR descriptions.
- Keep live authentication in the echo-disabled interactive TTY flow.
- Do not inspect or commit generated `var/` state. `dist/` and `node_modules/` are generated dependencies.
- The read-only sync boundary accepts only `{ type: "fetch" }`. Never add `full`, `send`, or `force` to that surface; upstream `full` includes a send phase.
- Do not expose the raw Notesnook `Database`, generic transport, collection mutators, note bodies, or file-storage writes through the read-only projection.
- Normalize upstream failures to categorical errors without forwarding causes, paths, credentials, or note corpus data.

## Documentation source of truth

- `docs/project-status.md` is the current implementation, validation, and support status source of truth.
- `docs/implementation-plan-v1.5.md` is the design roadmap and acceptance-gate source of truth; dated receipts and superseded decisions are historical evidence, not current status.
- `docs/engineering/stages/stage-3-live.md` records the Stage 3 proof and operator reproduction path. Stage receipts are historical, scope-bounded evidence; consult `docs/project-status.md` for current status.
- `README.md` is concise project orientation; do not use it to override the status or roadmap sources above.
- Use Forgejo issues for discrete follow-up work; do not create a duplicate `TODO.md` roadmap.
