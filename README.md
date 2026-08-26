# NookBridge

> **Status: pre-alpha. Stage -1 — native-runtime compatibility spike.** No application code, packaging, deployment configuration, or source/dependency/build files have been added to this repository yet. This bootstrap commit ships documentation only.

## What this project is

**NookBridge** is a planned headless Notesnook client for Linux, designed to be used by [Hermes Agent](https://hermes-agent.nousresearch.com/) (and other authorized local clients) as an ordinary MCP-backed notes service. It is **not** an official Notesnook component, and its architecture is not inherently tied to Hermes.

The goal is to give an authorized agent capabilities comparable to an authorized user operating the official Notesnook desktop client — authentication, encrypted local state, native encrypted sync, and read/search/create/append/update of notes — **without** materially weakening Notesnook's desktop-client security model.

- Canonical project name: **NookBridge** (repository / package namespace: `nookbridge`).
- Planned components: trusted daemon `nookd`, admin CLI `nookctl`, and thin MCP proxy `nook-mcp`.
- Target environment: Linux only. **NixOS is the reference and first production deployment**; conventional systemd Linux and a Docker Linux-container profile are the first portability targets after the NixOS MVP. macOS and Windows are explicit non-goals.
- Recommended implementation language: TypeScript / Node.js (because `@notesnook/core` is TypeScript/JavaScript and its Node E2E tests are the practical integration blueprint).
- Project license: **GPL-3.0-or-later**. This is chosen to align with the `@notesnook/core` license, which the daemon directly imports/incorporates. See `LICENSE` at the repository root.

## Current stage

The project is at **Stage -1 — NixOS native runtime compatibility spike**.

This is the cheapest possible go/no-go signal on the highest-uncertainty technical dependency (Notesnook's native Node SQLite / search-extension stack under NixOS) before any bridge architecture, persistence, authentication, or MCP code is written. Stage -1 builds only a minimal temporary Nix `devShell` / Node harness on the actual target NixOS host, attempts to build and load `better-sqlite3-multiple-ciphers` plus the Notesnook-required FTS/trigram/regex extensions, creates and reopens an encrypted SQLite database, runs representative extension queries, and — if feasible — initializes the smallest Notesnook DB test harness. No source code, dependency manifests, build files, Nix modules, or service configuration are being added at this stage.

Stages 0 through 9 (reproducible baseline, persistent client, authentication, native sync, writes, production service boundary, MCP proxy, NixOS package, security-parity review) follow the same rule: **do not start the next stage until the current stage has a repeatable automated test and a written pass/fail result**. Failed gates are concrete decisions: fix, change architecture, or stop.

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

## What is *not* in this bootstrap commit

To be explicit about the current state of the repository: nothing in this commit claims that NookBridge functionality has been implemented. There is no application source code, no `package.json` / `package-lock.json` / `tsconfig.json`, no Nix flake or module, no `flake.nix`, no systemd units, no Docker artifacts, no test harness, no CI configuration, and no `.gitignore` — none of those have been authored yet. They will be introduced as the project advances through the stages defined in the implementation plan, starting with the Stage -1 spike on the target NixOS host.

## License

GPL-3.0-or-later. See [`LICENSE`](LICENSE) for the full license text. SPDX-License-Identifier: `GPL-3.0-or-later`.