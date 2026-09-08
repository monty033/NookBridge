# Stage 9 canary evidence

Status: **Historical baseline — superseded by current-pin evidence below**

Date: 2026-09-05
Source candidate under review: `94ad5c0a`
Deployment/source used by the external VM baseline: `1f433a421881031c407d84ab977ffda57d72c99c`

The VM evidence below was produced from `/var/lib/hermes/workspace/nix-config`
on the separate pin branch, not from this source repository. It is baseline
evidence only and does not substantiate the source candidate until the pin is
updated and the checks are rerun.

## Historical external clean-VM baseline (2026-09-05)

Command:

```text
cd /var/lib/hermes/workspace/nix-config
nix build --no-link .#checks.x86_64-linux.nookbridge-isolation
```

Result: **PASS**.

The VM test asserts:

- `nookd.service` reaches active/running;
- service identity is `nookbridge:nookbridge-clients`;
- state and runtime directory ownership/modes are restricted;
- socket ownership is `nookbridge:nookbridge-clients`, mode `0770`;
- a `nookbridge-clients` member connects;
- an outsider is denied;
- client users cannot read service state or the root-only credential;
- the runtime-generated fixture is absent from the built package output.

The fixture is generated from `/dev/urandom` at VM boot and is never embedded
in Nix expressions, derivations, logs, or this report.

## Historical target-host canary checklist (superseded by current-pin evidence below)

Status: **NOT RUN**.

The target host requires the Nix source-pin change and a user-authorized
`nixos-rebuild switch` handoff. No rebuild, service restart, or live write was
performed during this review.

Required target-host receipt:

1. verify the deployed derivation resolves to the reviewed source revision;
2. verify `nookd.service` active state and the socket owner/group/mode;
3. run bounded read-only MCP/RPC smoke calls with explicit timeouts;
4. verify outsider denial and state/credential non-readability;
5. run the controlled plaintext-canary scan without printing the canary;
6. record rollback/restart state before any write-policy change.

## Historical baseline decision (2026-09-05)

The external baseline result was insufficient for release approval until the
source pin was updated, the VM check was rerun against the reviewed candidate,
and the target-host canary was run against that same pin.

## Current deployed-pin evidence (2026-09-07)

Status: **PASS WITH FOLLOW-UP — Stage 9 release remains blocked**.

- **Source/pin:** NookBridge `9260c6c507db02555046a905d8e7d77ad74865f0`, consumed by nix-config PR #302 merge `1ec85850aad321fe339fe215b8d0b18e20f5e701` (pin-change head `fe951b6aabde4bcb8d8a7d4a0c843002cb98a8b9`).
- **Isolation VM:** `nix build --no-link .#checks.x86_64-linux.nookbridge-isolation` passed against the current merged pin.
- **Runtime:** `nookd`, `hermes-agent`, and `hermes-dashboard` are active on the `gsg2b1` NookBridge derivation; the installed service config passes; the socket is owned by `nookbridge:nookbridge-clients` with mode `0770`.
- **MCP smoke:** the deployed `nook-mcp` completed initialize, `tools/list`, and bounded tool calls through the Unix socket.
- **Remote-deletion canary:** the agent-created title `NookBridge phone deletion canary 2026-09-07T18:01:06Z` was deleted on the phone. Explicit `notesnook_sync` returned `synced`, `pendingSync:false`, `attempts:1`; an exact-title search returned **0 hits**.

This is fresh target-host operational evidence for the deployed pin. It does
not claim the full Stage 9 gate: RT-11 has bounded current-pin coverage but
live create/append/update race follow-up remains; RT-4 is a bounded soak rather
than a long-duration study; protected RT-6/RT-9 scans and RT-8 outsider checks
remain incomplete; and the clean recovery VM, post-recovery checks, and license
sign-off remain open.

## Current-pin operational follow-up (2026-09-07)

- **Bounded soak:** 100 rapid synthetic searches completed in 522 ms; 20
  succeeded and 80 returned the same bounded `service_unavailable` response;
  RSS delta was 1,152 KiB, file-descriptor delta was zero, and stderr was empty.
  This is follow-up evidence, not a long-duration soak closure.
- **Service-owned plaintext scan:** zero hits for the prior disposable canary
  titles/IDs in the deployed NookBridge store path or `/run/nookbridge`.
  Hermes-session/cache copies are test-history artifacts, not bridge-owned
  persistence. Protected `/var/lib/nookbridge` and logs were not readable by
  this account and remain unclaimed.
- **Boundary status:** socket/runtime ownership and mode remain
  `nookbridge:nookbridge-clients` / `0770`; an actual non-member identity could
  not be launched from the agent account, so outsider denial remains open.
- **Runtime health after scans:** `nookd`, `hermes-agent`, and
  `hermes-dashboard` remained active; explicit sync again returned
  `synced`, `pendingSync:false`, `attempts:1`.

- **RT-11 live lifecycle:** disposable note `6a9f1878954ad1f066cc91a7` was
  created, appended, updated, explicitly synced, deleted on the phone, then
  reconciled. The post-delete sync returned `synced`, `pendingSync:false`,
  `attempts:1`; exact-title search returned **0 hits**. The separate local-write
  race remains unexercised.

## Current-pin follow-up (2026-09-08)

NookBridge `78ed6c0adc08d25be167c26e65dbacd6432cdfdb` carries the PR-71
`notesTouch` fix that closes the RT-11 local-write-race follow-up.

- **Sequential probe (`\nseq-1` then `\nseq-2` against the same note):** three
  reads returned three distinct revision tokens
  (`rev_a07c7100…`, `rev_981f90fa…`, `rev_5ec303f6…`), proving every
  successful append now advances the note's `dateEdited` and therefore the
  read-only projection's revision token.
- **4-way parallel race against the same `expectedRevision`:** exactly **1
  winner** (`kind:"append"`), 3 categorical `service_unavailable` rejections;
  the winner's final revision token differed from the initial revision
  (`revisionChanged: true`). The daemon's pre-existing request-budget layer
  surfaced the racing writes; the append path is no longer able to mask a
  stale revision as a successful write.
- **Bounded disposable write canary (create → get → update → get → append →
  get):** every step returned the expected MCP tool result kind; the post-append
  revision token differed from the pre-update revision.
- **Source evidence:** PR-71 added a regression test that pins the contract
  `appendNote → notesTouch`. Full source suite: 56 files / 1584 tests pass.

The RT-11 local-write-race follow-up is **closed**. Remaining open items
on the plan: privileged plaintext/state/log scan, outsider recheck, clean VM
recovery drill, post-recovery target-host checks, and license sign-off.