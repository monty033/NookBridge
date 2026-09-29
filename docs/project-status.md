# Project status

NookBridge is pre-alpha. The table below separates repository implementation
from operational support; a feature being present in source does not by itself
make it safe or supported in every deployment.

| Area | Current position | Evidence / next boundary |
| --- | --- | --- |
| Notesnook client core and encrypted local state | Implemented around the pinned upstream dependency. | [Upstream contract](upstream-contract.md) and implementation tests. |
| Authentication and session persistence | Implemented with gated live-login and interactive credential input. | [Stage 2 live record](engineering/stages/stage-2b-live.md); credentials remain TTY-only. |
| Fetch-only native sync and bounded reads | Implemented and live-validated for the recorded scope. | [Stage 3 receipt](engineering/stages/stage-3-live.md). |
| Local writes and explicit outbound sync | Implemented as bounded, gated capability slices; broader account coverage is not implied. | [Stage 4 plan/receipt](engineering/stages/stage-4-write-plan.md). |
| Local conflict observation | Implemented as a read-only local projection; a fresh fetch-only client is not expected to see another device's marker. | [Stage 5 service notes](engineering/stages/stage-5-service-boundary.md) and the implementation handoff. |
| `nookd` service boundary and MCP proxy | Implemented as a narrow Unix-socket service and stdio proxy with policy-controlled tools. | [Architecture](architecture.md), [MCP reference](reference/mcp-tools.md), and recorded source evidence. |
| Operator `notes` surface | Implemented over the operator socket, with a daemon-owned encrypted operation store and approval-gated mutations. Live-validated for the create → read round trip. | Source PR #125 merged to `main` on 2026-09-21. The dedicated lock proof and the read-only sync proof remain separate evidence gates — see below. |
| NixOS reference deployment | Reference production path; host provisioning and secret wiring live in the deployment repository. | [NixOS installation](installation-nixos.md). |
| Conventional Linux | Experimental generic systemd installer and Nix package now exist; cross-distro live/security validation remains open. | Do not declare generic-Linux support until the L1 gate passes. |
| Docker | Planned portability target. | No Docker installation path yet. |
| macOS and Windows | Explicit non-goals. | No support commitment. |

## Current pause point — beta Markdown fidelity slice — 2026-09-29

This is the current handoff point. The source work is merged to the dedicated
Forgejo `beta` branch, but it is **not** a production release or deployment.

### Closed in the beta branch

- PR #165, `feat: add native block Markdown parity`, merged at
  `b813243a286789d641ea049a8e32b23498902f99`.
- PR #166, `feat: render nested ordinary lists as native bullet trees`, merged
  at `9d9e9af413defe3407f445d593b5516532ca3315`.
- PR #167, `feat: preserve ordered list starts and support HTTPS links`, merged
  at `192c9cdf17ef630befd9c181112f92224c6df0f4`.
- PR #168, the docs-only closeout, is the most recent merge; the current
  `upstream/beta` tip is `bb5d76fdb9253c56e30a4c1d12187cf014359e67`.
- The final source gate passed at **109 test files / 2,787 tests**, with
  typecheck, lint, formatting, build, and diff checks passing.
- The final independent review found no blocking security or logic findings.

The merged slice covers native Markdown block parity, nested ordinary lists,
arbitrary nonnegative ordered-list starts, and strict HTTPS inline links. The
link path rejects malformed, unsafe, credential-bearing, and unsupported
destinations before mutation; the ordered-list path refuses boundaries it
cannot preserve faithfully.

### Explicitly not done

- No promotion from `beta` to `main` has been requested or performed.
- No new production artifact release, NixOS repin, service restart, or
  production deployment was performed for PRs #165–#167.
- No new global Notesnook sync was performed as part of this closeout.
- The beta source gate does not close the broader production-MVP gates below.

### Resume checklist

When this work resumes, continue in this order:

1. Re-read `upstream/beta` at the current tip `bb5d76f…` (PR #168, the
   docs-only closeout) and decide whether the beta behavior is ready for a
   promotion PR to `main`.
2. If promotion is authorized, build and verify the artifact from the exact
   beta merge commit, then run the isolated beta canary/read-back checks.
3. Submit a separate promotion/deployment change only after the source target
   and artifact evidence are accepted; do not infer deployment permission from
   the merged beta PR.
4. Keep the broader production-MVP blockers open until their own evidence exists:
   production-shaped mutation/recovery acceptance, privileged and outsider
   boundary checks, clean recovery/resync, long-duration mixed-load stress, and
   exact shipped-artifact dependency/license evidence.

The detailed roadmap and historical evidence remain in
[implementation-plan-v1.5.md](implementation-plan-v1.5.md), with the current
closeout recorded in §13.20.

## Reference deployment rollout — 2026-09-16 (historical snapshot)

The update-compensation rollout is deployed and reconciled on the reference
NixOS host:

- Source PR #101 merged at `804e9c61`; deployment PR #338 merged at
  `c1a702cc`.
- Bounded update compensation covers metadata, notebook, tag-relation, and
  content failure boundaries, including relation-inspection failure.
- `nookd`, Hermes Agent, and the dashboard are active; MCP exposes nine tools;
  `nookctl doctor` reports zero failures.
- The explicitly authorized global sync completed in one attempt;
  `pendingSync=false` and `hasUnsyncedChanges=false` on read-back.
- The protected `Vault-locked-note canary` remains visible by title.

This closes the implementation/deployment/reconciliation workstream only. It
does not close the broader production-MVP release gate. The remaining
production-shaped atomicity, recovery, privileged-scan, outsider-boundary,
long-duration stress, and dependency/license sign-off work is tracked in the
[implementation plan](implementation-plan-v1.5.md#1314-fresh-astra-re-baseline--current-production-mvp-blockers).

## Historical operator notes surface receipt — 2026-09-21

This section records the review and live evidence from that implementation
slice. PR #125 subsequently merged to `main`; the current source/release
position is recorded in the beta pause-point section above. The historical
“blocks the merge” language below must not be read as the current PR state.

The operator `notes` surface is implemented on the sole daemon and live-validated
on the reference Debian host:

- A note created through `nookctl notes create --approve-edit` reads back as real
  markdown — heading, inline bold and code, and both checklist states render.
  Before this work every content block came back opaque, so the write path could
  create a note the read path could neither display nor edit.
- A CRLF document creates, where it previously failed input validation.
- A locked note returns a categorical `locked` refusal while an unlocked note
  beside it still returns its projection.
- Nothing is uploaded *by this surface*: the operator socket has no `sync` verb, and
  every sync run during this work used the fetch-only read-only path.

**What this does not prove.** An earlier statement here claimed operator-created
notes are never uploaded. **That was wrong.** Operator creates are recorded with
`pendingSync: true`, and the remote executor invokes upstream `{ type: "full" }`,
which includes a send phase — so a later daemon-side full sync would drain that
queue. The accurate position is "not automatically uploaded", not "may never be
uploaded". This is tracked as an open defect, not a closed boundary.

Also open: the dedicated lock proof (`notes locked-note-proof`) returns a
categorical `vault_locked` for a locked note and `permission_denied` for the
unlocked control — proven live on 1.3.9 — but the daemon still records
`peerCredentials: "unknown"` for the peer, and the proof's own path resolution
collapses every failure other than `not_found` into the generic code. The
read-only sync proof reports a pass against an empty store, because its state
directory is derived from the working directory when the environment variable is
unset.

An independent read-only review of source PR #125 returned `REQUEST_CHANGES`
twice. Round 1 raised seven findings; four are now fixed — list-class semantics
(`f119808`), inline attribute strictness (`f31e017`), the sync request shape
(`053c322`), and the lock category on the write paths (`52c0231`, with the
remaining paths covered in `4da0fe9`). One deferral was upheld (unknown tags are
separable from this PR). One was corrected as documentation rather than code
(creates are not automatically uploaded). One was reclassified: authorization is
not notebook- or lock-aware, which is a defect against the frozen T00
requirement rather than a future improvement, and it blocks the merge. Round 2
additionally found that `categoricalCode` trusted arbitrary error text
(`03ebb32`) and that the operator vocabulary header contradicted its own
constant; the shape check from round 1 was also found evadable and is now
un-evadable (`2f9b66b`).

## Reading status claims safely

“Implemented” means the repository contains the capability and its boundary
tests. “Live-validated” means a bounded receipt exists for the stated scenario,
not that every account, device, or deployment has been tested. “Supported” is a
deployment claim and requires the corresponding packaging, secret handling,
service isolation, and release gates.
