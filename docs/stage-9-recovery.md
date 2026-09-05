# Stage 9 recovery readiness

Status: **FAIL — recovery gate incomplete**

Date: 2026-09-05
Source candidate under review: `94ad5c0a`
Permission profile: deployed `readOnly`

## Current verified behavior

- The daemon and `nookctl doctor` have bounded diagnostics and do not perform
  authentication, synchronization, or live writes during this review.
- The Nix service uses a dedicated state directory and a separately injected
  systemd credential.
- An external NixOS isolation VM baseline in `nix-config` verifies the service
  can be stopped/restarted by the test harness without exposing the state
  directory or credential to clients. That baseline uses source pin `1f433a42`
  and is not evidence for this candidate until repinned and rerun.

## Missing recovery capability

No reviewed, non-destructive corruption workflow currently exists for:

1. stopping `nookd` and preserving the original state directory;
2. collecting a bounded integrity/diagnostic result without exposing note data;
3. quarantining a corrupt database with restrictive ownership/mode;
4. reinitializing an empty service state only after explicit operator approval;
5. verifying socket, credential, and read-only policy invariants after restart;
6. rolling back to the preserved state if recovery is abandoned.

A recovery script must not delete state, print database contents, or accept
credentials through argv/env. It must be separately reviewed and exercised in a
throwaway VM with generated fixture data before production use.

## Decision

**Do not claim recovery readiness.** This is a release blocker. Production
remains on the existing read-only service with no recovery mutation attempted.
