# Getting started

## What NookBridge does

NookBridge runs the Notesnook client core under a dedicated local service
identity. An authorized local MCP client talks to that service through
`nook-mcp`, a thin stdio proxy over a Unix socket. This keeps the MCP client
away from Notesnook passwords, MFA material, reusable session secrets, database
key material, and the encrypted state directory.

The project is intended for operators who want a local, policy-controlled
Notesnook integration for an authorized agent or another local MCP client.

## Before you begin

- You administer the target NixOS host and can manage its deployment policy.
- You can provide a protected interactive TTY for Notesnook provisioning.
- You understand that any authorized MCP client can receive only the operations
  allowed by the root-owned service policy.
- You will keep passwords, MFA codes, tokens, keys, and note contents out of
  command arguments, environment variables, logs, tickets, and chat.

## Supported status

NookBridge is pre-alpha. The NixOS reference deployment is the only supported
production path. Generic Linux packages, Docker, macOS, and Windows are not
supported installation targets. Features and policy must be verified against
the deployed configuration; do not assume that an experimental CLI command is
enabled for a production daemon.

## Next steps

1. Read [security and privacy](security-and-privacy.md) to confirm the trust
   model meets your needs.
2. Follow [NixOS installation](installation-nixos.md) to establish the service
   boundary.
3. Complete [setup and provisioning](setup-and-provisioning.md) from a real
   host TTY.
4. Connect the approved MCP client using [usage](usage.md).
