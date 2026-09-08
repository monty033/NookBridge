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
Model: gpt-5.6-luna / deployed MCP probe + local Vitest focused suites
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

Observed current-pin results:

- `tools/list` exposed exactly the eight approved tools; no delete-shaped tool
  was exposed.
- A delete-shaped call returned categorical `unknown_tool`; malformed and
  oversized search requests returned categorical `invalid_request`.
- Explicit empty-queue `notesnook_sync` returned `synced`, `pendingSync:false`,
  and `attempts:1`.
- The six focused policy/sync/runtime suites passed: **104 tests**.

Unexpected successes: 0.
Regression tests added: none; existing focused suites passed.
Decision: **PASS WITH FOLLOW-UP**. The live create/append/update sequence and
phone-side deletion reconciliation now pass on the deployed runtime. The
separate local-write race remains unexercised; the phone-side deletion canary
is recorded in `docs/stage-9-canary.md`.

### RT-11 local-write race (2026-09-08 follow-up)

Red-team run: RT-11
Date/version: 2026-09-08 / deployed NookBridge
`78ed6c0adc08d25be167c26e65dbacd6432cdfdb` (post PR-71 `notesTouch` fix)
Permission profile: deployed `readWriteNoDelete`
Canaries used: disposable note titles and fragments only; no credentials or
real note content.

Attempts:

- 4 parallel `notesnook_append_note` calls against the same disposable note,
  each using the same `expectedRevision` derived from a fresh
  `notesnook_get_note`.
- A separate sequential probe: create → get → append → get → append → get to
  confirm every successful append advances the note's `dateEdited` (and
  therefore the read-only projection's revision token).
- A bounded disposable write canary: create → get → update → get → append →
  get, asserting each MCP tool call's projected result kind.

Observed current-pin results:

- 4-way parallel race: **1 winner**, 3 categorical `service_unavailable`
  rejections; the winner's final revision token differed from the initial
  revision (`revisionChanged: true`), so the concurrency gate fired at the
  daemon's request-budget layer.
- Sequential probe: three reads returned three distinct revision tokens
  (`rev_a07c…`, `rev_981f…`, `rev_5ec3…`), confirming that every append now
  bumps `dateEdited`.
- Bounded disposable write canary: every step returned the expected tool
  result kind; final revision token differed from the pre-update revision.
- Full source suite: **56 files / 1584 tests pass** (one new PR-71
  regression test pins that the append adapter invokes `notesTouch`).

Unexpected successes: 0.
Regression tests added: PR-71 regression test pins the contract.
Decision: **PASS**. The RT-11 local-write race is closed; the live race
fires the revision gate through the daemon's pre-existing
request-budget layer.

## Current-pin operational scan addendum (2026-09-07)

### RT-4 — target-host bounded resource soak

Red-team run: RT-4
Date/version: 2026-09-07 / deployed NookBridge `9260c6c507db02555046a905d8e7d77ad74865f0`
Model: gpt-5.6-luna / bounded stdio MCP harness
Permission profile: deployed `readWriteNoDelete`
Attempts: 100 rapid synthetic searches for `__rt4_nonexistent_canary__`.
Unexpected successes: 0.
Expected boundary: 20 requests succeeded; 80 returned the same categorical
`service_unavailable` response; elapsed time 522 ms; RSS increased 1,152 KiB;
file-descriptor count stayed at 21; stderr was empty.
Decision: **PASS WITH FOLLOW-UP** — this bounded soak is not a long-running
production-duration resource study.

### RT-4 — long-duration target-host soak (2026-09-08 follow-up)

Red-team run: RT-4
Date/version: 2026-09-08 / deployed NookBridge
`78ed6c0adc08d25be167c26e65dbacd6432cdfdb`
Model: bounded stdio MCP harness (Node 22.23.2) targeting
`nook-mcp` over `/run/nookbridge/nookbridge.sock`
Permission profile: deployed `readWriteNoDelete`
Canaries used: unique search queries of the form
`__rt4_soak_<ms>_<i>_<rand>__`. No real note bodies, no credentials.

Attempts: **1000** `notesnook_search_notes` calls spaced at 600 ms (target
duration **600 s**). The MCP stdio client (Hermes agent, PID 2034843)
opened a single persistent child `nook-mcp` process against the live
daemon (PID 2031054) and ran the entire burst over one connection.

Unexpected successes: 0.
Resource counters:

| Sample        | t (ms)   | client RSS (KiB) | client FDs | daemon RSS (KiB) | daemon threads |
| ------------- | -------- | --------------- | ---------- | ---------------- | -------------- |
| start         |       0  | 39040           |         25 | 83336            |             11 |
| call   100    |   59942  | 38204           |         25 | 84616            |             11 |
| call   250    |  150436  | 43964           |         25 | 86536            |             11 |
| call   500    |  301217  | 44348           |         25 | 89608            |             11 |
| call   750    |  451964  | 44732           |         25 | 91528            |             11 |
| call  1000    |  602703  | 44988           |         25 | 92296            |             11 |

End-to-end: 1000 / 1000 success, 0 rejected, 0 errors; elapsed 602,714 ms
(10:02). Daemon RSS grew 8,960 KiB over the 10-minute burst
(≈9 KiB / call) — visible-but-bounded growth, no unbounded loop. Client
RSS plateaued after call 500. FD count steady at 25 on the client side;
daemon FD limit remains at the systemd default of 256. stderr was empty
on both client and daemon. `nookd`, `hermes-agent`, and `hermes-dashboard`
remained active throughout.

Decision: **PASS WITH FOLLOW-UP**. The 10-minute / 1000-call soak
demonstrates bounded resource usage and zero rejections on a single
connection. The ~9 KiB / call daemon-side growth is plausible
upstream cache or per-request bookkeeping; a multi-hour follow-up would
be needed to characterize the long-tail slope, which is out of scope for
this agent's interactive runtime.

### RT-6/RT-9 — target-host plaintext-canary and package/runtime scan

Red-team run: RT-6/RT-9
Date/version: 2026-09-07 / deployed NookBridge `9260c6c507db02555046a905d8e7d77ad74865f0`
Permission profile: deployed `readWriteNoDelete`
Canaries used: prior disposable canary titles and IDs; no credentials.
Attempts: bounded scan of the deployed NookBridge store path and `/run/nookbridge`.
Unexpected successes: 0; zero hits in both service-owned roots.
The broader scan found only test-history copies in Hermes session/cache artifacts;
`/var/lib/nookbridge` and protected logs were inaccessible to this account and
are not claimed clean. Decision: **PASS WITH FOLLOW-UP** — privileged state/log
scan remains open.

### RT-8 — outsider/state/credential boundary

Red-team run: RT-8
Date/version: 2026-09-07 / deployed NookBridge `9260c6c507db02555046a905d8e7d77ad74865f0`
Permission profile: outsider boundary
Observed socket/state metadata: socket and runtime directory are owned by
`nookbridge:nookbridge-clients`; socket mode is `0770`; Hermes is a member of
`nookbridge-clients`; service state and credential paths returned permission
errors to Hermes. The agent could not change identity to an actual non-member
user (`setresuid` was not permitted), so outsider connection denial was not
independently rerun. Decision: **OPEN**.

## Current-pin decision

The current source, isolation VM, live remote-reconciliation, bounded soak,
RT-11 local-write race, and service-owned plaintext-scan evidence are fresh.
Stage 9 remains **FAIL — release blocked** until the privileged RT-6/RT-8/RT-9
checks, recovery VM/post-recovery checks, and dependency/license human sign-off
are complete.
