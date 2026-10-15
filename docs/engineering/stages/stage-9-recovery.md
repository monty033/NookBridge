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
- Any existing lock file, including a stale lock, missing/unsafe state, quarantine collisions, unsafe
  identifiers, occupied rollback destinations, and incomplete quarantine entries
  fail closed. A stale lock requires an operator to confirm no daemon is running and remove
  `nookbridge.lock` by hand; inspect never reclaims it. A symlinked or non-directory quarantine root also fails closed
  before any move, for both reinitialize and rollback.
- Quarantine manifests carry one of three statuses: `incomplete` (member moves
  in progress), `initializing` (every original member has moved and fresh
  members are being created), and `complete`.  Reinitialize resumes an
  `incomplete` or `initializing` checkpoint; an `initializing` checkpoint is
  resumed only when every member is recorded as moved and present in the entry.
  Rollback refuses an `initializing` checkpoint outright, and refuses any entry
  with a manifest member missing, before any move.
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

## P1-9 Phase 1 — production bundle recovery (source, 2026-10-14)

Branch `feat/production-bundle-recovery-20261013`, local only. Not pushed; no
PR. This is source behavior for the production database bundle
(`nookbridge-storage.db`, `notesnook.db`, `notesnook-logs.db`, with WAL/SHM
sidecars). It does not include a VM drill, privileged state, or live Notesnook
access.

Verified behavior (source and focused tests):

- One exclusive state lock (`openSync(..., "wx")`) is taken before inspect
  reads member presence and is held across the private copy and probe. A held
  lock is reported as `locked`. Inspect never reclaims a lock file, live or
  stale. On release it renames the lock file aside, then removes it only when its inode
  and holder record still match what was written; a non-matching file is linked
  back. This narrows the release race but is not atomic: a new holder can create
  a lock after an operator deletes a live one, our release can rename that lock
  aside, and a third process can acquire before it is linked back. This residual
  window is accepted and not closed by this change. If restoration fails, the file
  remains under a `.release-*` name for an operator to inspect. A holder-record
  write that fails or is short removes its own lock file when it can. If that
  removal fails, the file stays at the lock path and acquisition still refuses
  until an operator clears it. No code path guarantees that file is removed.
- Each probe copies members into a per-run directory created with `mkdtemp` and
  set to mode `0700`. Its owner record is written exclusively (`wx`, `0600`).
  The startup sweep runs under the lock at each probe (inspect or
  reinitialize), not at process start. It removes a
  `nookbridge-bundle-inspect-*` directory only when all of these hold: it is
  owned by the current uid, is not a symlink, is older than one hour, and its
  recorded owner pid is no longer alive.
- Member and sidecar copies open each source with `O_NOFOLLOW`, which refuses a
  symlink at open, and `O_NONBLOCK`, which keeps an open of a FIFO from waiting
  for a writer. The opened descriptor is then checked with `fstat`, which refuses
  a FIFO or other non-regular file. The code does not establish that opening every
  special file is non-blocking. A preliminary
  `lstat` presence check is not tied to that inode. Inspect assumes no
  non-cooperating writer swaps a member or sidecar between the check and the
  open, or alters one in place during the copy. It does not detect either, so a
  copy taken during such a write could mix two states. The owner-file check
  rejects symlinks.
- For inspect, a probe that throws becomes the categorical `indeterminate`
  result. Reinitialize never returns `indeterminate`: a probe that throws, or a
  copy that cannot be classified, refuses with the categorical error
  "refusing unprobeable production database bundle" (exit code 2). A failure to
  create the private copy directory, write its owner record, or copy a member
  or sidecar returns `corrupt` to inspect and the same categorical refusal
  (exit code 2) to reinitialize. Inspect removes its own lock file when it can prove the file is its own. If that removal fails, inspect returns `indeterminate` and leaves the file for an operator. Inspect also removes its private copy directory. If that removal fails, inspect returns `indeterminate`, and reinitialize refuses with the same categorical error, because a copy of the bundle would remain in `tmpdir()`.
- Reinitialize resumes an `initializing` checkpoint only when every member is
  recorded as moved and present in the entry. Rollback refuses an
  `initializing` checkpoint and any entry with a manifest member missing.
- Rollback and resume refuse unlisted sidecars in the state root or in an
  entry, and refuse symlinked manifests.
- A `-wal` or `-shm` sidecar with no main database file is an orphan, not an
  empty root. Inspect reports it as `partial`, and reinitialize refuses it
  before any move. Only a resumable checkpoint can explain a partial state.
- Manifest writes use random-named temporaries created exclusively (`wx`, no
  symlink following). Resume and rollback sweep manifest temporaries left by a
  crash, and never unlink a symlink that has that name.
- If a restore move fails, rollback undoes its own completed moves. If that
  undo also fails, it returns `ROLLBACK_PARTIAL` (exit 3).
- `NOOKBRIDGE_DATABASE_KEY` is a forbidden bundle carrier. Its presence fails
  closed, and its value is never read or copied into the parser snapshot. The
  CLI forwards `CREDENTIALS_DIRECTORY` only when it is absolute.
- `bundle reinitialize` requires both `--approve-reinitialize` and
  `--accept-unsynced-loss`. The second flag acknowledges that unsynced local
  state will be discarded. It is refused alone or alongside unrelated flags.

Test and mutation evidence (this commit's tree):

- `tests/stage-9-production-bundle-recovery.test.ts`: 118/118 passing. This includes regression tests for
  sidecar inventory, symlinked manifests, probe failure, a partial bundle
  snapshot (bytes and inodes), manifest temporary naming, and quarantine-remover
  containment.
- Scratch mutation driver (not committed): 14 targeted mutants of
  `recover-bundle.ts`, 14/14 killed, on an earlier candidate. It was not re-run
  on this tree; the mutation evidence is therefore stale for the current code.

Not proven by this slice: SQLCipher error classification on real encrypted
state, WAL behavior under real crashes, filesystem durability, runtime races,
the clean NixOS VM drill, privileged production recovery, post-recovery policy
checks, or resync. Those remain open, as listed below.

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
