# NookBridge documentation

NookBridge is a pre-alpha Linux bridge between authorized local MCP clients and
Notesnook. Its security model deliberately separates the MCP-facing process
from the credential-bearing Notesnook client.

## Choose a path

| If you are… | Start here |
| --- | --- |
| Understanding the motivation and design | [Background and intent](background.md) and [architecture](architecture.md) |
| Evaluating whether NookBridge is appropriate | [Getting started](getting-started.md), [project status](project-status.md), and [security and privacy](security-and-privacy.md) |
| Operating the reference NixOS deployment | [NixOS installation](installation-nixos.md), then [setup and provisioning](setup-and-provisioning.md) |
| Connecting an authorized local MCP client | [Usage](usage.md) and the [MCP proxy contract](engineering/stages/stage-6-mcp-proxy.md) |
| Maintaining the service or deployment | [Configuration](configuration.md), [troubleshooting](troubleshooting.md), and [development](development.md) |

## Support boundary

The reference deployment is NixOS. Conventional systemd Linux and Docker are
design targets, not supported production installation methods. NookBridge is
not an official Notesnook product. Do not treat implementation-stage records as
operator instructions unless a user guide links to them explicitly.

For a compact view of what is implemented, validated, and supported, see
[project status](project-status.md).

## Reference and engineering evidence

- [Architecture](architecture.md)
- [Background and intent](background.md)
- [Project status](project-status.md)
- [Command and MCP usage](usage.md)
- [MCP tool reference](reference/mcp-tools.md)
- [Operator CLI reference](reference/cli.md)
- [Security and privacy](security-and-privacy.md)
- [Documentation maintenance](documentation-maintenance.md)
- [Engineering stage records](engineering/stages/index.md)
- [Implementation plan](implementation-plan-v1.5.md)
- [Upstream contract](upstream-contract.md)
- [Security reviews](security-reviews.md)
- [Licensing](licensing.md)
