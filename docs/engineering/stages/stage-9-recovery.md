# Stage 9 recovery readiness

Status: **SOURCE WORKFLOW IMPLEMENTED — historical 2026-09-05 baseline; VM drill and production recovery gates open**

Date: 2026-09-05
Source baseline for this recovery slice: `f84a6f2`
Permission profile in this historical slice: `readOnly`

## Current verified behavior

- The daemon, `nookctl doctor`, and `nookctl recover-local-state inspect` have
  bounded diagnostics and do not perform authentication, synchronization, or
  live writes during this review.
- The Nix service uses a dedicated state directory and a separately injected
  systemd credential.
- An external NixOS isolation VM baseline in `nix-config` verifies the service
  can be stopped/restarted by the test harness without exposing the state
  directory or credential to clients. That baseline uses source pin `1f433a42`
  and is not evidence for this candidate until repinned and rerun.

## Reviewed source workflow

`nookctl recover-local-state` is a separate operator-only local-state command.
It does not add RPC/MCP methods, authentication, synchronization, deletion, or
transport capabilities.

- The default invocation is categorical and read-only; `help` is explicit.
- The parser rejects credential/key/body carriers in argv and environment before
  state inspection or mutation.
- State roots must be canonical, existing, non-symlink directories; database
  paths must remain inside the state root.
- Active lock files, missing/unsafe state, quarantine collisions, unsafe
  identifiers, occupied rollback destinations, and incomplete quarantine entries
  fail closed.
- `--approve-reinitialize` is required for the quarantine path.
- The original database is preserved by a restrictive, same-filesystem,
  no-copy/no-clobber move into `.recovery-quarantine/<opaque-id>/`; it is never
  overwritten or silently removed.
- A fresh encrypted database is initialized only after approval and a healthy
  read-only integrity probe of the original state.
- `--approve-rollback <opaque-id>` restores the preserved database without
  replacing an occupied destination and refuses traversal or unsafe entries.
- Public results are closed categorical values; paths, keys, note data, native
  errors, and causes are not emitted.
- The focused recovery suite exercises inspection, approval ordering,
  quarantine preservation/mode, fresh-state initialization, rollback,
  collision handling, parser carrier rejection, and CLI dispatch.

## Remaining release gates

The source implementation is not a production recovery authorization by itself.
The current-pin isolation VM gate is already recorded as PASS in the current
source receipt. The recovery-specific evidence still required is:

1. exercise the workflow in a throwaway VM with generated fixture data;
2. verify socket, credential, state-directory, and current deployed policy
   invariants after the recovery/restart sequence, including the
   `readWriteNoDelete` allowlist and absent `notes.delete` boundary;
3. after the recovery drill, rerun the target-host post-recovery checks and
   record the current policy/no-`notes.delete` evidence; the existing
   current-pin runtime and remote-deletion canary are recorded separately.

No production recovery mutation has been attempted. The current deployment uses
`readWriteNoDelete`; that policy correction does not constitute recovery-drill
evidence. The current-pin VM check and remote-deletion canary are recorded in
`docs/engineering/stages/stage-9-source-evidence.md`, but the throwaway-state recovery exercise
remains open.

## Historical current-pin throwaway-state drill (2026-09-07)

Source/deployed revision: NookBridge `9260c6c507db02555046a905d8e7d77ad74865f0`.

- A disposable encrypted state fixture was inspected as healthy.
- Explicit `--approve-reinitialize` quarantined the original database under an
  opaque `.recovery-quarantine/<id>/nookbridge.db` entry and initialized fresh
  state.
- Rollback correctly refused an occupied destination with exit code 2.
- After explicit removal of the disposable fresh database, approved rollback
  restored the preserved state; final inspection reported healthy.
- The focused recovery/doctor/CLI suites passed **83 tests**.

This closes the throwaway-state CLI exercise only. The clean NixOS VM drill,
privileged production-state recovery, and post-recovery target-host policy and
no-`notes.delete` checks remain open.

## Current deployment note (2026-09-16)

The reference deployment now consumes source PR #101 merge `804e9c61` through
nix-config PR #338 merge `c1a702cc`; the rebuilt runtime is healthy and its
post-deployment sync reconciliation is clean. No recovery workflow was run in
that rollout, and no recovery gate is being inferred from service health or
the successful sync.

The clean VM recovery drill, production-shaped database-bundle recovery,
post-recovery policy checks, and resync evidence remain open exactly as stated
above.
