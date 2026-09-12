# Engineering stage records

These documents are the project's stage plans, decision records, validation
receipts, canaries, and review artifacts. They preserve implementation history
and release-gate evidence; they are not the primary onboarding or operating
instructions.

## Stage records

- [Stage 2A](stage-2a.md), [Stage 2B](stage-2b.md), [Stage 2 live](stage-2-live.md), and [Stage 2B live](stage-2b-live.md) — authentication and session persistence.
- [Stage 3 live](stage-3-live.md) — read-only native synchronization.
- [Stage 4 write plan](stage-4-write-plan.md) — bounded writes and explicit outbound sync.
- [Stage 5 service boundary](stage-5-service-boundary.md) — trusted daemon and local IPC decisions.
- [Stage 6 MCP proxy](stage-6-mcp-proxy.md) — historical read-only proxy baseline and addendum.
- [Stage 9 recovery](stage-9-recovery.md), [canary](stage-9-canary.md), [dependencies](stage-9-dependencies.md), [source evidence](stage-9-source-evidence.md), and [red-team review](stage-9-red-team.md).
- [Stage 9.5 review prompt](stage-9-5-astra-review-prompt.md) — review procedure and preserved prompt text.

The stage-9 production-license CSV and the stage-9.5 text prompt are supporting
artifacts in this same directory. The current user-facing summary is
[project status](../../project-status.md); the broader roadmap remains the
[implementation plan](../../implementation-plan-v1.5.md).
