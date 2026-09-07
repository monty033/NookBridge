# Stage 9 red-team evidence

Run timestamp: 2026-09-05T21:15:10Z
Bridge revision under review: `94ad5c0a`
Working remediation branch: `stage9-source-hardening`
Permission profile in this historical slice: `readOnly`; the current deployed
profile is documented in the current-pin addendum below.
Canaries: generated fixture values only; no real credentials or note content

This report records bounded, source-level evidence. It is not a release approval.
The full Stage 9 gate remains fail-closed until the target-host canary and
recovery drill are completed.

> **Current-pin note (2026-09-07):** RT-1..RT-10 below are historical evidence
> for `94ad5c0a` under a `readOnly` deployment profile. They are not evidence
> for deployed `9260c6c507db02555046a905d8e7d77ad74865f0`, whose production policy is `readWriteNoDelete`.

## RT-1..RT-10 results

### RT-1 — closed method universe and delete denial

Red-team run: RT-1
Date/version: 2026-09-05 / source revision above
Model: local Vitest + offline Nix devShell
NixOS revision: current nix-config `origin/master` baseline
Bridge/core revision: `94ad5c0a`
Permission profile: `readOnly`
Canaries used: IDs only, never real secrets
Attempts: inspect RPC union/parser/dispatcher and exercise unknown/delete-shaped requests
Unexpected successes: 0
Expected denials observed: closed parser/policy tests deny unknown operations; `notes.delete` is absent
Regression tests added: existing Stage 5 RPC/policy suites
Decision: PASS

Evidence: `tests/stage-5-rpc-protocol.test.ts`, `tests/stage-7-service-policy.test.ts`,
`tests/stage-7-slice3-review-fixes.test.ts`.

### RT-2 — malformed framing and protocol inputs

Red-team run: RT-2
Date/version: 2026-09-05 / source revision above
Model: local Vitest + offline Nix devShell
NixOS revision: current nix-config `origin/master` baseline
Bridge/core revision: `94ad5c0a`
Permission profile: `readOnly`
Canaries used: bounded malformed frames only
Attempts: truncated frames, invalid JSON, wrong request shapes, invalid response shapes
Unexpected successes: 0
Expected denials observed: categorical protocol errors and connection-safe rejection
Regression tests added: existing Stage 5 RPC protocol/server suites
Decision: PASS

Evidence: `tests/stage-5-rpc-protocol.test.ts`, `tests/stage-5-nookd-server.test.ts`.

### RT-3 — request, response, and content-size bounds

Red-team run: RT-3
Date/version: 2026-09-05 / source revision above
Model: local Vitest + offline Nix devShell
NixOS revision: current nix-config `origin/master` baseline
Bridge/core revision: `94ad5c0a`
Permission profile: `readOnly`
Canaries used: synthetic boundary strings and byte counts
Attempts: maximum permitted values plus over-limit title, payload, frame, and array inputs
Unexpected successes: 0
Expected denials observed: bounded categorical errors
Regression tests added: existing bounds regressions
Decision: PASS

Evidence: `tests/stage-5-rpc-protocol.test.ts`, `tests/stage-7-slice3-review-fixes.test.ts`,
`tests/stage-7-slice3-writes.test.ts`.

### RT-4 — connection, request, and amplification bounds

Red-team run: RT-4
Date/version: 2026-09-05 / source revision above
Model: local Vitest + offline Nix devShell
NixOS revision: current nix-config `origin/master` baseline
Bridge/core revision: `94ad5c0a`
Permission profile: `readOnly`
Canaries used: synthetic note IDs and bounded queries
Attempts: concurrent/repeated requests through the bounded server configuration and retry/error paths covered by tests
Unexpected successes: 0
Expected denials observed: bounded connection/request limits and clean teardown
Regression tests added: existing server/runtime lifecycle suites
Decision: PASS WITH FOLLOW-UP

The source tests cover configured bounds, but a long-running target-host soak
with resource counters was not performed. That omission remains a Stage 9
release blocker.

### RT-5 — profile and operation authorization

Red-team run: RT-5
Date/version: 2026-09-05 / source revision above
Model: local Vitest + offline Nix devShell
NixOS revision: current nix-config `origin/master` baseline
Bridge/core revision: `94ad5c0a`
Permission profile: `readOnly`, plus source-only `readWriteNoDelete` policy tests
Canaries used: synthetic IDs only
Attempts: invoke create/append/update/delete-shaped operations under read-only policy
Unexpected successes: 0
Expected denials observed: write operations denied by frozen policy; delete absent
Regression tests added: existing Stage 7 profile suites
Decision: PASS

Evidence: `tests/stage-7-service-policy.test.ts`, `tests/stage-7-slice3-writes.test.ts`,
`tests/stage-7-slice3-mcp-writes.test.ts`.

### RT-6 — error, log, and output redaction

Red-team run: RT-6
Date/version: 2026-09-05 / source revision above
Model: local Vitest + offline Nix devShell
NixOS revision: current nix-config `origin/master` baseline
Bridge/core revision: `94ad5c0a`
Permission profile: `readOnly`
Canaries used: generated secret-shaped markers, never real secrets
Attempts: malformed input and CLI failure paths; inspect bounded projections and output
Unexpected successes: 0
Expected denials observed: secret/state paths and raw credential carriers excluded from tested output
Regression tests added: existing redaction suites
Decision: PASS WITH FOLLOW-UP

Evidence: `tests/stage-4-write-cli-redaction.test.ts`,
`tests/stage-5-systemd-credential-keystore.test.ts`, `tests/stage-2-s2-hygiene.test.ts`.
A separate target-host plaintext-canary scan remains required.

### RT-7 — lifecycle, teardown, and race handling

Red-team run: RT-7
Date/version: 2026-09-05 / source revision above
Model: local Vitest + offline Nix devShell
NixOS revision: current nix-config `origin/master` baseline
Bridge/core revision: `94ad5c0a`
Permission profile: `readOnly`
Canaries used: temporary sockets and synthetic requests
Attempts: shutdown during requests, repeated startup/cleanup, and runtime lock paths
Unexpected successes: 0
Expected denials observed: bounded shutdown and cleanup without leaked socket state
Regression tests added: existing startup/server/runtime suites
Decision: PASS

Evidence: `tests/stage-5-nookd-server.test.ts`, `tests/stage-5-nookd-startup.test.ts`,
`tests/stage-5-service-runtime.test.ts`.

### RT-8 — Unix socket authorization boundary

Red-team run: RT-8
Date/version: 2026-09-05 / source revision above
Model: NixOS VM test plus source regression test
NixOS revision: nix-config `origin/master` baseline
Bridge/core revision: `94ad5c0a`
Permission profile: deployed `readOnly`
Canaries used: generated VM fixture credential only
Attempts: group member and non-member socket access; state and credential reads
Unexpected successes: 0
Expected denials observed: outsider denied socket access; client denied state/credential reads
Regression tests added: source default-mode regression on remediation branch
Decision: PASS WITH FOLLOW-UP

Evidence: external `nix-config` check
`nix build --no-link .#checks.x86_64-linux.nookbridge-isolation` PASS against
source pin `1f433a42`; the source focused test in this repository proves the
candidate daemon defaults to mode `0770`. The external VM result must be rerun
after the candidate is merged and pinned.

### RT-9 — Nix store and runtime secret canary

Red-team run: RT-9
Date/version: 2026-09-05 / source revision above
Model: NixOS VM package scan
NixOS revision: nix-config `origin/master` baseline
Bridge/core revision: `94ad5c0a`
Permission profile: deployed `readOnly`
Canaries used: VM-generated random fixture only
Attempts: binary-safe scan of the built package output for the runtime-generated fixture bytes
Unexpected successes: 0
Expected denials observed: fixture absent from package output; root-only credential and non-root state access enforced
Regression tests added: existing NixOS isolation scan
Decision: PASS WITH FOLLOW-UP

The external clean-VM fixture scan passed against source pin `1f433a42`. It is
not candidate evidence until the source is repinned and the scan is rerun. A
target-host scan after pin deployment is still required.

### RT-10 — dependency, package, and release-boundary review

Red-team run: RT-10
Date/version: 2026-09-05 / source revision above
Model: offline Nix/Node build and static inventory
NixOS revision: nix-config `origin/master` baseline
Bridge/core revision: `94ad5c0a`
Permission profile: `readOnly`
Canaries used: none
Attempts: build/package checks, direct dependency/license inventory, diff and lock-graph review
Unexpected successes: 0
Expected denials observed: no public artifact claimed; write policy not enabled
Regression tests added: none
Decision: PASS WITH FOLLOW-UP

The source full gate passed. External `nix-config` flake/service/isolation
checks passed against source pin `1f433a42`; they are not candidate evidence
until repinned and rerun. The lockfile-derived production inventory has
221/221 license fields and is exported at
`docs/stage-9-production-licenses.csv`. Public distribution still requires the
human release/license review.

## Overall decision

**Historical decision (2026-09-05): FAIL — release blocked.** Test-backed
boundaries were passing, but the source hardening branch was not merged/deployed,
the target-host canary was outstanding, and recovery tooling/drill evidence was
absent.

## RT-11 — current-pin outbound sync/reconcile and deployed write policy

Red-team run: RT-11
Date/version: 2026-09-07 / deployed NookBridge `9260c6c507db02555046a905d8e7d77ad74865f0`
Model: not yet run; this row records the required current-pin coverage
Consumer revision: nix-config PR #302 merge `1ec85850aad321fe339fe215b8d0b18e20f5e701` from head
`fe951b6aabde4bcb8d8a7d4a0c843002cb98a8b9`
Bridge/core revision: `9260c6c507db02555046a905d8e7d77ad74865f0`
Permission profile: deployed `readWriteNoDelete`
Canaries used: disposable note title only; no credentials or note body

Required attempts:

- exercise `notesnook_create_note`, append, update, and approval-gated
  `notesnook_sync` through the deployed MCP dispatcher;
- verify delete-shaped methods remain absent/denied;
- exercise empty-queue remote reconciliation and a local-write race;
- verify retry/rate-limit/no-delete protections and bounded error projections;
- inspect the deployed service policy rather than assuming the historical
  `readOnly` profile.

**Decision: OPEN — not yet run.** The live remote-deletion canary is recorded
in `docs/stage-9-canary.md`, but it is an operational acceptance check, not a
substitute for this adversarial policy review.

## Current-pin decision

The current source, isolation VM, and live remote-reconciliation evidence are
fresh. Stage 9 remains **FAIL — release blocked** until RT-11, the RT-4/RT-6/RT-8/RT-9
operational scans, the recovery drill, and the human dependency/license review
are complete.
