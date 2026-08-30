# Stage 5 — Service Boundary Decision Record

> **Status: docs-only, pre-implementation decision record. Gate 5 is not passed.**
> No daemon code, Nix configuration, credential handling, or socket code is
> added by this document. The decision record defines the contract that the
> later implementation tasks must satisfy; it is not the implementation.

## 1. Purpose

This document captures the **resolved** decisions for the Stage 5 service
boundary *before* code is written, so each subsequent task has a reviewable
contract. It deliberately does not describe functions, classes, file layout,
or test strategy — those belong to the individual implementation tasks tracked
in `.hermes/plans/2026-08-30_185854-stage5-service-boundary.md` and the
roadmap's Stage 5 section.

Naming collision note: the repository already contains a merged
**"Stage 5 local conflict observation"** slice (read-only CLI projection,
`nookctl conflicts`). That slice is a separate, completed code slice whose
positive two-device live canary is still pending. It is **not** the formal
Stage 5 service boundary and is **not** covered by this decision record.

## 2. Trust zones

| Zone | Identity / artifact | Authority | Default posture |
|------|---------------------|-----------|-----------------|
| Root operator | `root` | Full host authority, owns deployment policy. | Sole writer of service config, Nix module, and key provisioning. |
| `nookbridge` daemon | Unix user `nookbridge` | Owns encrypted state, runtime directory, and socket. | Receives the database key only through the approved credential delivery mechanism. Refuses to start without it. |
| `nookbridge-clients` | Unix group `nookbridge-clients` | May connect to the service Unix socket. | No read access to state, config, credentials, or service `/proc` material. |
| Hermes | Unix user `hermes` | MCP proxy caller; member of `nookbridge-clients`. | Connects to the socket only. Never sees key bytes, state paths, raw upstream errors, or service `/proc` data. |
| sops-nix / systemd credential delivery | Encrypted-at-rest source → service-private file | Mediates the database key between `root` and the `nookbridge` daemon. | sops-nix decrypts the encrypted source at activation, then systemd `LoadCredential=` copies/presents the service-private file under `$CREDENTIALS_DIRECTORY`; Hermes and `nookbridge-clients` cannot read it. |
| Service state | Filesystem state owned by `nookbridge` | Owned by the daemon; mode and ownership set by the deployment. | Not readable by `hermes`. |
| Unix socket | Permission-controlled IPC endpoint | Owned by `nookbridge`; group `nookbridge-clients` may connect. | The only normal interface between Hermes and the daemon. No TCP/HTTP listener. |

## 3. Key-backend decision (selected, not speculative)

**Selected backend:** systemd `LoadCredential` delivery, sourced from an
encrypted **sops-nix** secret.

- The encrypted source lives in the canonical NixOS deployment repository
  (see §4). It is never committed to `NookBridge`.
- sops-nix decrypts the encrypted source; systemd `LoadCredential=`
  copies/presents the resulting service-private file under
  `$CREDENTIALS_DIRECTORY` under the non-secret label **`nookbridge-db-key`**.
- The concrete Nix expression that wires `sops-nix` →
  `LoadCredential=` → daemon `$CREDENTIALS_DIRECTORY` is deferred to
  **Task 7** and will be verified there. No Nix changes are part of this
  decision record.

**Fail-closed behavior:**

- Missing credential file → daemon refuses to start.
- Empty, oversized, or malformed credential → daemon refuses to start.
- Any startup-time read error → daemon refuses to start.
- No "generate a new key", "fall back to plaintext", or "reset state" path
  exists in the production backend. Recovery is an operator action, not an
  automatic one.

**Excluded backend:** the existing `development-file` keystore remains
**development-only**. The production daemon MUST NOT select it, and there is
no opt-in switch that enables it for the daemon.

**Out of record:** key bytes, on-disk credential path, key length, encryption
parameters, secret names beyond the public label, and any sops file path.
These are deployment facts that do not belong in this document.

## 4. Deployment ownership

| Item | Value |
|------|-------|
| Canonical NixOS deployment repo | `/var/lib/hermes/workspace/nix-config` |
| Hermes host deployment file | `hosts/nxc/hermes/configuration.nix` |
| Secret authority | `sops-nix` (already in use) |
| Phase creating the Nix changes | **Task 7** (later task in the Stage 5 plan) |
| Phase this document implements | **Task 1** — decision record only |

Task 7 will create the actual Nix expression, service unit, user/group
declarations, and socket/credential wiring in the canonical repo. That work
is **not happening now**. The existing Nix checkout is dirty and remains
untouched by this task.

## 5. Initial RPC allowlist

The first daemon vertical slice exposes **exactly one** RPC method:

| Method | Request | Success result (title-only) |
|--------|---------|----------------------------|
| `notes.search` | `{ id, method: "notes.search", params: { query } }` | `{ id, ok: true, result: { kind: "search", notes: [{ title }] } }` |

Rules that bound this surface from day one:

- The only allowed method is `notes.search`. Every other method name is
  rejected categorically, including methods that *look* like existing CLI
  verbs.
- Request frames are length-prefixed and size-capped before JSON parsing.
- The query is bounded; values exceeding the limit are rejected.
- The success result is **title-only**: no note IDs, no bodies, no paths,
  no revision tokens, no credentials, no raw upstream strings.
- Response frames are size-capped; over-limit responses fail as a bounded
  categorical error.
- Every response is a frozen envelope; unknown response fields fail.

## 6. Forbidden capabilities (explicit)

The service boundary MUST NOT expose any of the following, in this slice or
any follow-up slice, without an explicit decision-record amendment:

- Delete, reset, provisioning, logout, key rotation, or account-switch
  operations.
- Generic filesystem access, arbitrary paths, or file arguments.
- Raw `Database` / raw `@notesnook/core` method dispatch.
- Generic sync verbs (`full`, `send`, `force`) or caller-selected sync
  options. The read-only sync boundary accepts only `{ type: "fetch" }`.
- Note bodies, note IDs, revision tokens, local paths, or token/key bytes in
  any response or log.
- Raw upstream error strings, stack traces, or causes.
- A TCP/HTTP listener. Local IPC is Unix-socket only.
- Dynamic method lookup, `eval`, or any capability-smuggling escape.
- A "generate if missing" key path, a plaintext-next-to-DB fallback, or an
  automatic state reset.
- Selecting the `development-file` keystore from the daemon.

## 7. Out of scope (for the Stage 5 service-boundary slice)

- The MCP proxy and Hermes tool registration (Stage 6).
- The broader permission hardening, abuse limits, and audit behavior (Stage 7).
- The NixOS reference package/module (Stage 8), beyond the deployment
  contract named in §4.
- The full security-parity review and production MVP gate (Stage 9).
- The pending **positive two-device** live conflict canary for the already
  merged `Stage 5 local conflict observation` slice. That is a separate
  validation task and is **not** part of Gate 5.

## 8. Verification of this decision record

This Task 1 deliverable is verified by docs-only checks:

1. `git diff --check` reports no whitespace/marker errors.
2. (If dependencies are available) `npm run format:check` does not flag the
   new files. Markdown under `docs/` is excluded by the repository
   `.prettierignore`, so this is informational, not blocking.

No code, no Nix, no credentials, no socket, no daemon is started, modified,
or provisioned by this task.