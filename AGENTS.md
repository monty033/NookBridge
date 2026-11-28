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
- Do not expose the raw Notesnook `Database`, generic transport, collection mutators, or file-storage writes through the read-only projection.
- **Amendment (owner-authorized, see `docs/security-and-privacy.md`):** `notes.get` / `notesnook_get_note` MAY return a bounded, decoded Markdown projection of note content (`contentStatus: "ok"`). The only content limit this project intends is Notesnook's own: NookBridge must not cap note content below what Notesnook accepts. That limit is not in force yet. A single-frame read is bounded by the response frame every client accepts. A stored row over `STORED_CONTENT_READ_BYTES` and a protocol-2 body read over `WIRE_BODY_BYTES` are refused because decoding, projection and encoding still run on the daemon's main thread. Those bounds — the stored-row threshold, the wire body bound, the decoder limits and the read-only fallback's own caps — are staging values that issue #337 replaces with Notesnook's own limits. A caller that does not negotiate a response body stays bound by the single-frame response frame, which is not a staging value: every client has to accept it. The prior categorical ban on note bodies covered the cloud-exfiltration risk of body content crossing an LLM boundary; the owner has accepted that risk for this local/self-hosted deployment and manages access instead via Notesnook's native per-note lock feature (which this surface still honors: a `locked` note's metadata flag suppresses the content read before the reader is ever called) and standard permission settings. Still forbidden: the raw `Database`, generic transport, collection mutators, and file-storage writes.
- Normalize upstream failures to categorical errors without forwarding causes, paths, credentials, or note corpus data.

## Documentation source of truth

- `docs/implementation-plan-v1.5.md` is the roadmap and acceptance-gate source of truth.
- `docs/stage-3-live.md` records the Stage 3 proof and operator reproduction path.
- `README.md` is the concise project status and orientation document.
- Use Forgejo issues for discrete follow-up work; do not create a duplicate `TODO.md` roadmap.
