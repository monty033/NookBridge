# Architecture

NookBridge keeps the MCP-facing process separate from the authenticated
Notesnook client:

```text
MCP client → nook-mcp → Unix socket → nookd → @notesnook/core → Notesnook
```

- `nook-mcp` is a stateless stdio proxy. It has no Notesnook credentials,
  encryption keys, or state-directory access.
- `nookd` is the trusted daemon. It enforces policy, owns encrypted local state,
  performs approved synchronization, and exposes only a narrow local RPC
  surface.
- The Unix socket is permission-controlled and is the only normal interface
  between the MCP client and the daemon.
- The deployment injects the database key as a systemd credential; the key does
  not belong in the code repository, Nix store, or MCP configuration.

The full design, including package/deployment targets and non-goals, is in the
[implementation plan](implementation-plan-v1.5.md#3-proposed-architecture).
