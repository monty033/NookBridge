# Background and intent

## The problem

Notesnook already provides an encrypted client experience, but an authorized
local agent cannot safely use that experience merely by being given access to a
desktop application's files or credentials. Export/import bridges are useful
for basic workflows, but they do not provide a native headless client and can
create a second plaintext data path.

NookBridge exists to provide a narrow local service boundary around the
Notesnook client core while preserving the important protections of the normal
client: encrypted local state, upstream authentication and synchronization,
and explicit operator-controlled access.

## Design intent

- Keep Notesnook cryptography, authentication, content handling, and sync in
  the pinned upstream client core rather than reimplementing them.
- Keep the credential-bearing client in `nookd`, behind a dedicated service
  identity and protected encrypted state.
- Give an MCP client only a narrow Unix-socket interface and bounded results.
- Put authorization in the service policy, not in an agent's configuration or
  prompt.
- Fail closed when secure credentials, policy, or state assumptions are not
  satisfied.
- Make Linux deployment portable at the application boundary while using NixOS
  as the reference production deployment.

## What NookBridge is not

NookBridge is not an official Notesnook component, a cloud relay, a plaintext
Markdown mirror, a generic filesystem agent, or a replacement Notesnook server.
It does not make an agent trusted merely because the agent can invoke an MCP
tool. The service policy and host permissions remain authoritative.

## Why the project is staged

Each capability is introduced behind an acceptance gate: implementation,
security review, bounded tests, and a written receipt precede the next stage.
That process makes it possible to distinguish a promising local experiment from
a deployment claim. The [project status](project-status.md) summarizes that
distinction; the [implementation plan](implementation-plan-v1.5.md) contains
the detailed stage history.
