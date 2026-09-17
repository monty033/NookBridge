# NookBridge

NookBridge is a pre-alpha, headless [Notesnook](https://notesnook.com/) client
for Linux. It lets an authorized local MCP client work with Notesnook through a
narrow Unix-socket service boundary, without receiving reusable Notesnook
credentials, encryption keys, or direct access to the bridge state.

It is not an official Notesnook component and is not tied to a particular MCP
client.

## Status

NookBridge is under active development. The NixOS deployment is the reference
production path, and a pre-alpha generic systemd Linux installer is available
for Linux hosts without Nix. Docker remains a planned portability target.
Read the
[getting-started guide](docs/getting-started.md) before attempting a deployment.

The current deployed rollout includes bounded compensation for partial note
updates and has completed its authorized sync reconciliation. The broader
production-MVP release gates remain open; see [project status](docs/project-status.md)
and the [implementation plan](docs/implementation-plan-v1.5.md#1315-current-rollout-closure--update-compensation-and-reconciliation)
for the exact boundary.

## Start here

- [Documentation home](docs/index.md) — choose an operator, user, or contributor path.
- [Background and intent](docs/background.md) — why the bridge exists and its design principles.
- [Project status](docs/project-status.md) — implemented, validated, and supported boundaries.
- [Getting started](docs/getting-started.md) — purpose, support status, and prerequisites.
- [NixOS installation](docs/installation-nixos.md) — reference deployment boundary.
- [Generic systemd installation](docs/installation-systemd.md) — non-NixOS Linux path.
- [GitHub one-command installer](docs/github-one-command-installer.md) — single-command bootstrap from a reviewed release asset.
- [Setup and provisioning](docs/setup-and-provisioning.md) — safe first-login and sync workflow.
- [Usage](docs/usage.md) — MCP and operator-facing workflows.
- [Security and privacy](docs/security-and-privacy.md) — trust boundaries and safe-operation rules.
- [Troubleshooting and recovery](docs/troubleshooting.md) — diagnostics and conservative recovery guidance.

## Architecture

```text
Authorized local MCP client
        │ stdio
        ▼
nook-mcp (no Notesnook secrets)
        │ permission-controlled Unix socket
        ▼
nookd (trusted service identity)
        │
        ├── encrypted local state
        └── Notesnook encrypted sync
```

`nookd` owns the authenticated client state. `nook-mcp` is a thin proxy that
does not import the Notesnook client core or read the daemon's state directory.
The service exposes no TCP or HTTP listener by default.

## Engineering material

The user guides describe the supported operational surface. These documents
record implementation contracts, security evidence, and release gates:

- [Implementation plan and current handoff](docs/implementation-plan-v1.5.md)
- [Upstream compatibility contract](docs/upstream-contract.md)
- [Service-boundary decision record](docs/engineering/stages/stage-5-service-boundary.md)
- [MCP proxy contract](docs/engineering/stages/stage-6-mcp-proxy.md)
- [Security reviews](docs/security-reviews.md)

## Development

Use the pinned offline development shell for project checks:

```bash
nix develop --offline --command just check
nix develop --offline --command just stage3-test
```

See the [development guide](docs/development.md) for repository workflow and
the boundary between local development and production operations. In a source
checkout, the administrative CLI is `node dist/cli.js`; production packaging
may expose the same entry point as `nookctl`.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
