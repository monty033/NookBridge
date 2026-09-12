# Operator CLI reference

`nookctl` is an operator tool. It is not an MCP service and must not be exposed
to an untrusted agent. Production packaging may install the `nookctl` wrapper;
in a source checkout, build first and use `node dist/cli.js`. Run the installed
version's help for exact syntax and availability.

| Command family | Intended use | Safety boundary |
| --- | --- | --- |
| `doctor` | Local diagnostics and optional endpoint reachability probe. | Inspection only; do not include secrets in arguments. |
| `auth` | Development/acceptance authentication state. | Production provisioning uses `nookbridge-provision` from a real root TTY instead. |
| `sync` | Development/acceptance read-only synchronization. | Live operations are explicitly gated. |
| `write` | Bounded acceptance write workflow. | Explicitly gated; do not pass note content through argv or environment. |
| `conflicts` | Read-only local conflict-marker observation. | Explicitly gated; never resolves a conflict. |
| `notes` | Bounded browse, search, get, edit, and undo operations. | Search/content arrive through bounded stdin; edit and undo require `--approve-edit`. |
| `tree` | Bounded notebook/filetree navigation. | Opaque handles and cursors only. |
| `settings` | Inspect and validate settings. | Nix-managed installs reject CLI edits; change deployment configuration instead. |
| `recover-local-state` | Inspect, quarantine/reinitialize, or roll back damaged state. | Default is read-only; mutation requires the exact approval flag and must be operator-reviewed. |

## Input rules

Never place passwords, MFA codes, keys, tokens, note bodies, note queries,
paths, revisions, or opaque recovery data in environment variables or ordinary
command arguments. The CLI intentionally rejects many such carriers. Where a
notes command accepts a query or content, it requires bounded standard input;
where it can mutate state, it additionally requires the documented approval
flag.

## Production wrappers

Use these root-operated NixOS wrappers for production state provisioning and
fetch-only synchronization:

```text
nookbridge-provision
nookbridge-sync
```

They are separate from `nookctl` because they run with the production service
identity and systemd credential delivery. See
[setup and provisioning](../setup-and-provisioning.md).
