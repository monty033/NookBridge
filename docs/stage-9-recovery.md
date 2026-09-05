# Stage 9 recovery readiness

Status: **SOURCE WORKFLOW IMPLEMENTED — VM DRILL AND PRODUCTION GATES OPEN**

Date: 2026-09-05
Source baseline for this recovery slice: `f84a6f2`
Permission profile: deployed `readOnly`

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
The following evidence remains required:

1. exercise the workflow in a throwaway VM with generated fixture data;
2. verify socket, credential, state-directory, and read-only policy invariants
   after the recovery/restart sequence;
3. verify the external NixOS isolation checks against the final merged source
   pin;
4. run the target-host canary only after the reviewed source is merged and the
   deployment pin is updated.

No production recovery mutation has been attempted. Production remains on the
existing read-only service until those gates pass.
