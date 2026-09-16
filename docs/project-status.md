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
| NixOS reference deployment | Reference production path; host provisioning and secret wiring live in the deployment repository. | [NixOS installation](installation-nixos.md). |
| Conventional Linux and Docker | Planned portability targets. | Do not treat them as supported installation paths yet. |
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

## Reading status claims safely

“Implemented” means the repository contains the capability and its boundary
tests. “Live-validated” means a bounded receipt exists for the stated scenario,
not that every account, device, or deployment has been tested. “Supported” is a
deployment claim and requires the corresponding packaging, secret handling,
service isolation, and release gates.
