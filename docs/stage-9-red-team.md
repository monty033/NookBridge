# Stage 9 red-team evidence

Run timestamp: 2026-09-05T21:15:10Z
Bridge revision under review: `94ad5c0a`
Working remediation branch: `stage9-source-hardening`
Permission profile: `readOnly` in deployment; write-capable profiles remain disabled
Canaries: generated fixture values only; no real credentials or note content

This report records bounded, source-level evidence. It is not a release approval.
The full Stage 9 gate remains fail-closed until the target-host canary and
recovery drill are completed.

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

**FAIL — release blocked.** Test-backed boundaries are passing, but the source
hardening branch is not merged/deployed, the target-host canary is outstanding,
and recovery tooling/drill evidence is absent.
