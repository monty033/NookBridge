# Stage 6: read-only MCP proxy

`nook-mcp` is a small stdio MCP proxy for the Stage 5 `nookd` Unix-socket
service. It has no Notesnook credentials and does not read the NookBridge state
directory. Its only service connection is the explicitly supplied Unix socket.

## Invocation

```text
nook-mcp --socket /run/nookbridge/nookbridge.sock
```

The socket argument must be absolute and canonical. There is no implicit socket
default. Invalid arguments fail closed before any socket I/O. `--help` prints a
bounded usage message to stderr.

## Exposed surface

Exactly one MCP tool is exposed:

- `notesnook_search_notes`
  - input: required non-empty `query`; optional integer `limit` from 1 through
    64
  - transport: existing framed `notes.search` RPC over the Unix socket
  - result: `kind` and title-only hits; note IDs, bodies, and notebook metadata
    are not returned
  - `limit` is currently accepted and bounded for forward-compatible schema
    stability, but is ignored because the Stage 5 RPC has no caller-provided
    limit field

Errors use the closed categorical vocabulary (`invalid_request`,
`permission_denied`, `service_unavailable`, `sync_failed`, `vault_locked`,
`not_found`, and `unknown_tool`). Query input rejects ASCII controls U+0000–U+001F
and U+007F before socket I/O. Raw socket errors, paths, causes, credentials, IDs,
and note bodies do not cross the MCP boundary. MCP protocol data stays on
stdout; diagnostics are fixed categorical messages on stderr.

Writes, synchronization controls (`full`/`send`), authentication, Vault,
administration, generic dispatch, filesystem tools, resources, prompts, TCP,
HTTP, and direct Notesnook/database imports are not part of this slice.

Declarative Hermes/Nix wiring is a separate follow-up after this source-side
proxy is independently reviewed and merged.
