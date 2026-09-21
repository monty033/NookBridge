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
| Operator `notes` surface | Implemented over the operator socket, with a daemon-owned encrypted operation store and approval-gated mutations. Live-validated for the create → read round trip. | Receipts recorded 2026-09-21; under review as source PR #125. The dedicated lock proof and the read-only sync proof remain open — see below. |
| NixOS reference deployment | Reference production path; host provisioning and secret wiring live in the deployment repository. | [NixOS installation](installation-nixos.md). |
| Conventional Linux | Experimental generic systemd installer and Nix package now exist; cross-distro live/security validation remains open. | Do not declare generic-Linux support until the L1 gate passes. |
| Docker | Planned portability target. | No Docker installation path yet. |
| macOS and Windows | Explicit non-goals. | No support commitment. |

## Current deployed rollout — 2026-09-16

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

## Operator notes surface — 2026-09-21

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

Also open: the dedicated lock proof (`notes locked-note-proof`) still reports
`service_unavailable` for a locked note and `permission_denied` for an unlocked
control; the daemon records `peerCredentials: "unknown"`, and a locked note's own
path resolution is collapsed into the generic code. The read-only sync proof
reports a pass against an empty store, because its state directory is derived from
the working directory when the environment variable is unset. An independent
read-only review of source PR #125 returned `REQUEST_CHANGES` with seven findings,
all open and none disputed; they are enumerated in the PR description.

## Reading status claims safely

“Implemented” means the repository contains the capability and its boundary
tests. “Live-validated” means a bounded receipt exists for the stated scenario,
not that every account, device, or deployment has been tested. “Supported” is a
deployment claim and requires the corresponding packaging, secret handling,
service isolation, and release gates.
