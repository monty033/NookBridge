# NookBridge

> **Status: pre-alpha. Stages 0–3 read-only native sync are proven; Stage 4 safe writes are offline-verified and remain remote-pending.** The gated live-login, cold-restart, refresh, logout/relogin, credential-hygiene, fetch-only sync, search, restart, and Vault-locked-note checks are recorded as passing. Independent live conflict visibility is deferred until the later local-note editing phase.

## What this project is

**NookBridge** is a planned headless Notesnook client for Linux, designed to be used by [Hermes Agent](https://hermes-agent.nousresearch.com/) (and other authorized local clients) as an ordinary MCP-backed notes service. It is **not** an official Notesnook component, and its architecture is not inherently tied to Hermes.

The goal is to give an authorized agent capabilities comparable to an authorized user operating the official Notesnook desktop client — authentication, encrypted local state, native encrypted sync, and read/search/create/append/update of notes — **without** materially weakening Notesnook's desktop-client security model.

- Canonical project name: **NookBridge** (repository / package namespace: `nookbridge`).
- Planned components: trusted daemon `nookd`, admin CLI `nookctl`, and thin MCP proxy `nook-mcp`.
- Target environment: Linux only. **NixOS is the reference and first production deployment**; conventional systemd Linux and a Docker Linux-container profile are the first portability targets after the NixOS MVP. macOS and Windows are explicit non-goals.
- Recommended implementation language: TypeScript / Node.js (because `@notesnook/core` is TypeScript/JavaScript and its Node E2E tests are the practical integration blueprint).
- Project license: **GPL-3.0-or-later**. This is chosen to align with the `@notesnook/core` license, which the daemon directly imports/incorporates. See `LICENSE` at the repository root.

## Current stage

Stages 0–2A, Stage 2B authentication, and the Stage 3 read-only native-sync POC
are complete and merged. The repository contains the TypeScript/Node
implementation, pinned Nix development environment, production-compatible
Notesnook crypto/storage adapter, closed read-only projection, and gated live
sync path. Credentials are accepted only through the echo-disabled interactive
TTY flow; argv/environment credential carriers are rejected.

On 2026-08-28, a fresh-state manual run completed the full live login flow and
returned `authenticated`. The follow-up cold-restart, explicit refresh,
logout/relogin, credential-hygiene, and fetch-only native-sync receipts passed.
On 2026-08-29, the title-based Vault-locked-note canary returned
`vault-locked: pass` with body refusal and clean teardown. PR #20 also added a
local-only fixture documenting why the phone's device-local conflict marker
cannot be independently observed by a fresh fetch-only client. **Gate 3 is
closed for the current read-only scope. Stage 4 safe-write implementation has
under offline verification; no live write or remote-sync proof is claimed, and
MCP work remains deferred.** The
exact handoff and acceptance criteria are in
[`Section 13.7`](docs/implementation-plan-v1.5.md#137-current-implementation-status-and-codex-handoff).

All stages follow the same rule: **do not start the next stage until the
current stage has a repeatable automated test and a written pass/fail result**.
Failed gates are concrete decisions: fix, change architecture, or stop.

## Stage 4 operator acceptance (offline-prepared)

The write path is exposed only through the separate `nookctl write` command
tree and is **off by default**. An operator must explicitly set
`NOOKBRIDGE_ENABLE_LIVE_SYNC=1`; an unset or different value fails closed
before the live runtime is constructed.

Supported acceptance commands are intentionally narrow:

```text
nookctl write help
nookctl write create --title <disposable-title> [--notebook-id <id>]
nookctl write append --note-id <id> --expect-revision <token>
nookctl write update --note-id <id> --expect-revision <token> (--set-pinned <true|false> | --set-favorite <true|false>)
```

Use only a disposable title and state. Create/append use fixed acceptance
content owned by the command; note bodies are not accepted through argv,
environment, logs, or chat. Credentials and MFA remain TTY-only and are never
accepted by the write command. Output is categorical only: local commit,
remote synchronization, pending state, and a bounded pending count.

The current slice performs local writes only. It does **not** invoke remote
sync, and successful writes are reported as `remote: pending` until a separate
reviewed remote executor exists. The offline pre-flight is:

```bash
just check-stage4-operator-gate
```

This proves parser/gate behavior and the local pending contract; it is not a
live-account, second-device, or Gate 4 canary receipt. Do not inspect or commit
generated `var/` state.

## Target architecture and security boundary

NookBridge separates an untrusted agent-facing proxy from the credential-bearing Notesnook client so that using the bridge does not imply possession of reusable client secrets.

```
Hermes Agent (Unix user: hermes)
│
│ stdio MCP
▼
nook-mcp                              ← thin proxy; owns no Notesnook secrets
│
│ narrow local RPC over Unix socket
▼
nookd service (Unix user: nookbridge)  ← trusted Notesnook client
├── authorization / policy layer       (root-owned, not writable by hermes)
├── content normalization layer
├── sync coordinator                  (coalescing, backoff, throttling)
├── secure-key-store adapter          (runtime credential, separate from DB)
└── @notesnook/core
    │
    ├── encrypted local SQLite + client state
    └── Notesnook encrypted sync
              │
              ▼
       Notesnook service
              │
              ▼
       phone / laptop
```

Key security boundary properties:

- The Unix socket is the only normal interface between Hermes and the authenticated bridge service. Hermes must not need or receive the Notesnook account password, MFA secret, recovery material, database encryption key, reusable authentication tokens, or direct filesystem access to the bridge's state directory.
- Notes and metadata remain encrypted at rest; there is no plaintext Markdown mirror, plaintext SQLite index, or persistent decrypted cache. Production mode fails closed when an approved secure key backend is unavailable.
- The bridge exposes no TCP/HTTP listener by default; local IPC is a permission-controlled Unix socket. The MCP proxy is stateless and never imports `@notesnook/core`.
- Authorization policy is enforced inside `nookd`; Hermes configuration / approval is defense in depth, not authorization. Global profiles: `readOnly`, `readWriteNoDelete`, or `custom` (configurable allow/deny list). Delete is not implemented.
- Notesnook cryptography, authentication, and sync are performed by upstream `@notesnook/core`, not reimplemented by the bridge.
- Note content is treated as data; the bridge does not execute or browser-render note HTML/scripts.
- Logs, crash reports, metrics, and diagnostic output do not contain note bodies or reusable secrets by default.

This is a summary; the authoritative specification, including all MVP tools, permission profiles, packaging/deployment contracts, testing strategy, threat model, and explicit non-goals, lives in [`docs/implementation-plan-v1.5.md`](docs/implementation-plan-v1.5.md).

## Documentation

- [`docs/implementation-plan-v1.5.md`](docs/implementation-plan-v1.5.md) — full Development and Design Plan v1.5: goals, background research, proposed architecture, technical decisions, staged development plan and gates (Stage -1 through Stage 9 plus the production MVP), MVP interface and permission model, Linux packaging and deployment design, testing and validation strategy, security and privacy model, risks, post-MVP roadmap, recommended repository structure, definition of done, and research sources.

## Current handoff

The Stage 3 read-only proof is complete for its current scope: authenticated
state reopen, fetch-only sync, bounded metadata, title/body search canaries,
remote-change restart visibility, clean teardown, and Vault-locked-note body
refusal all have live receipts. PR #20 merged the deterministic local conflict
fixture. Independent live conflict visibility is deliberately deferred until
the bridge is editing notes locally; the phone UI observation is not an
independent fetch-only receipt. The next bounded artifact is the Stage 4
safe-write plan. Ignore generated `var/` state and keep credentials at the
interactive TTY boundary.
See the [implementation-plan handoff](docs/implementation-plan-v1.5.md#137-current-implementation-status-and-codex-handoff)
for the exact constraints and receipt.

## License

GPL-3.0-or-later. See [`LICENSE`](LICENSE) for the full license text. SPDX-License-Identifier: `GPL-3.0-or-later`.
