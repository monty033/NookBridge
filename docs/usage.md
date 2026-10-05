# Usage

## Task-list titles

A native rich task list may carry an optional title of at most 256 UTF-8 bytes. The versioned Markdown representation uses `:::nookbridge list task-list title="NookBridge Tasks"`. Omit `title=` to remove the title. Empty titles normalize to absent. Titles on simple checklists and unsupported/nested native title shapes remain opaque rather than being reinterpreted. Legacy unversioned edits are refused when stored content contains task-list title metadata, because the legacy writer cannot preserve it. The v1 document format is bound to the native source context/revision and does not promise forward compatibility with unknown versions.

**Source provenance caveat:** the `title`/`data-title` representation comes from `packages/editor/src/extensions/task-list/task-list.ts` in Notesnook editor commit `53c2a3500c05ba193dfb90791d6c7a1f82eac82c`. The runtime dependency remains `@notesnook/core` 8.1.3; that package version does not establish the editor version used by a live client. Matching-client visual acceptance remains a separate gate.

## MCP client connection

The approved local MCP client launches the thin proxy over stdio and supplies
the deployment's Unix socket explicitly:

```text
nook-mcp --socket /run/nookbridge/nookbridge.sock
```

The socket must be an absolute path. The proxy has no implicit socket default,
does not read NookBridge state, and owns no Notesnook credentials. MCP protocol
messages use stdout; diagnostics use stderr.

The service policy, owned by the deployment administrator, controls which
bounded operations are available. The MCP proxy registers a closed set of
read, write, single-note delete, and explicitly requested synchronization
tools; an unavailable tool must be denied by the service policy rather than
silently widened. The [MCP tool reference](reference/mcp-tools.md) describes
the currently compiled surface and its safety constraints.

## Operator CLI

`nookctl` is an administrative CLI, not an MCP replacement. A production
deployment may install it as a wrapper around the built CLI. In a source
checkout, invoke the same entry point as `node dist/cli.js` after building.
Its help lists the available command families:

```text
nookctl help                 # deployed wrapper
node dist/cli.js help       # source checkout
```

Some command trees are deliberately gated, are intended only for development
or acceptance work, or require explicit approval flags. In particular:

- Do not use CLI authentication commands in place of production provisioning.
- Do not pass note bodies through argv or environment variables; bounded CLI
  operations that accept content use standard input and explicit approvals.
- Do not enable a command solely because it is present in `nookctl help`.

For settings, use `nookctl settings show` and `nookctl settings validate` for
inspection. In Nix-managed deployments, settings edits are intentionally
unavailable from the CLI; change the root-owned deployment configuration.

The [operator CLI reference](reference/cli.md) distinguishes safe inspection
commands from actions that require an explicit approval or an interactive TTY.
