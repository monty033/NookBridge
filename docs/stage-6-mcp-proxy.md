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

Exactly four read-only MCP tools are exposed:

- `notesnook_search_notes`
  - input: required non-empty `query`; optional integer `limit` from 1 through
    64
  - transport: existing framed `notes.search` RPC over the Unix socket
  - result: `kind` and title-only hits; note IDs, bodies, and notebook metadata
    are not returned
  - `limit` is currently accepted and bounded for forward-compatible schema
    stability, but is ignored because the Stage 5 RPC has no caller-provided
    limit field

- `notesnook_status`
  - input: empty object
  - transport: `notes.status` over the Unix socket
  - result: bounded `lastSynced` and `hasUnsyncedChanges` metadata only

- `notesnook_list_notebooks`
  - input: empty object
  - transport: `notes.list_notebooks` over the Unix socket
  - result: bounded notebook IDs, titles, and optional timestamps; unknown
    fields are projected away

- `notesnook_get_note`
  - input: one bounded note `id` (maximum 256 bytes; identifier characters are
    limited to ASCII letters, digits, `_`, and `-`)
  - transport: `notes.get` over the Unix socket
  - result: bounded note metadata only; body/content and unknown fields are
    never returned

The RPC method allowlist is exactly `notes.search`, `notes.status`,
`notes.list_notebooks`, and `notes.get`. The only new RPC size limit in this
slice is `maxIdentifierBytes = 256`; the existing frame, response, query,
title, and hit-count limits remain unchanged.

Errors use the closed categorical vocabulary (`invalid_request`,
`permission_denied`, `service_unavailable`, `sync_failed`, `vault_locked`,
`not_found`, and `unknown_tool`). Query input rejects ASCII controls U+0000–U+001F
and U+007F before socket I/O. Raw socket errors, paths, causes, credentials, IDs,
and note bodies do not cross the MCP boundary. MCP protocol data stays on
stdout; diagnostics are fixed categorical messages on stderr.

The Stage 6 baseline did not include writes, synchronization controls
(`full`/`send`), authentication, Vault, administration, generic dispatch,
filesystem tools, resources, prompts, TCP, HTTP, or direct
Notesnook/database imports. Stage 7 Slice 3 adds only the three bounded local
write methods documented below; all other surfaces remain absent.

The production daemon now selects its bounded service policy from the
root-owned service configuration. Existing four-method configurations remain
read-only; write-capable configurations can select only the closed create,
append, and update methods.

## Stage 7 Slice 3 addendum: bounded write tools

Stage 6 remains the read-only baseline. Stage 7 Slice 3 adds three explicitly
bounded write tools while preserving the Stage 6 transport and isolation model:

- `notesnook_create_note` — required bounded `title` and `content`, with an
  optional bounded `notebookId`; transport: `notes.create`.
- `notesnook_append_note` — bounded `id`, Markdown fragment, and opaque expected
  revision; transport: `notes.append`.
- `notesnook_update_note` — bounded `id`, expected revision, and a non-empty
  closed patch containing only `title`, `content`, `notebookId`, `tags`,
  `pinned`, or `favorite`; transport: `notes.update`.

The current MCP surface therefore contains exactly seven tools: the four
Stage 6 read tools plus these three writes. There is still no delete tool;
`notes.delete` is absent from the RPC method union and every MCP allowlist.
The `readOnly` profile admits only reads. `readWriteNoDelete` admits create,
append, and update in addition to reads. `custom` remains an explicit closed
allowlist selected by service configuration.

Write results are projected to bounded identifiers, byte counts, and applied
field names. Raw note content, patches, adapter errors, internal lifecycle
flags, credentials, and revision values are not returned. Stale-revision,
conflict, vault-locked, and sync-failed outcomes remain categorical; no
automatic conflict resolution or synchronization is performed by the MCP
proxy.
