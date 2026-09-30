# Configuration

Production configuration is a small, root-owned, non-secret JSON document read
by `nookd`. It establishes the state directory, Unix socket, socket group,
selected secure-key backend, credential label, settings backend, and closed RPC
method policy. It must not contain password material, key bytes, token values,
or arbitrary environment overrides.

The daemon accepts only the `systemd-credential` backend in production, with
the fixed public credential label `nookbridge-db-key`. systemd supplies its
contents privately at runtime. Missing, malformed, insecure, or unexpected
configuration must cause categorical, fail-closed startup behavior.

## Policy ownership

The root operator selects the service policy. MCP clients may use only the
methods granted by that policy; they cannot alter permissions through MCP,
settings, or service RPC. Broad capability profiles are:

- `readOnly` for bounded read operations;
- `readWriteNoDelete` for the closed read and bounded write surface;
- `custom` for an explicitly enumerated, closed allowlist.

Credential management, provisioning, account changes, state export, and
generic sync dispatch are never ordinary MCP methods. Deletion is a distinct,
policy-controlled single-note capability and must be explicitly enabled and
reviewed; it is not part of the `readWriteNoDelete` profile.

## Settings

NixOS installations keep settings declarative in deployment configuration.
Generic systemd installations use the supplied root-owned JSON file and mark
the service configuration as CLI-managed. The root operator can inspect,
validate, edit, or reset that file through `nookctl settings`; ordinary users
must not be granted access to it. See `nookctl settings help` for the installed
binary's exact behavior.

### Settings JSON schema (version 1)

The settings file requires top-level `version`, `defaults`, and `overrides`;
`version` must be integer `1`. The loader reads these fields but does not reject
additional top-level properties. `defaults` must contain exactly the four
operation keys in this order: `read`, `edit`, `create`, `delete`; each value
must be a JSON boolean. `overrides` must be an array and may be empty. If the
CLI creates defaults (including `reset`), they are `read: true`, `edit: false`,
`create: false`, and `delete: false`.

Each override may contain `notebooks` or `notes`, but not both; either list,
when present, must contain non-empty printable-ASCII patterns with no `//`.
An override must also contain at least one operation boolean (`read`, `edit`,
`create`, `delete`); unknown override keys and non-boolean operation values
are rejected. A scope-less override with an operation boolean passes loading
but cannot match a notebook or note. `create` matches notebook scope only;
other operations can match a note path or notebook path. Patterns are
slash-separated segments; `*` and `?` match within a segment, matching is
ASCII case-insensitive, and segment counts must match. Notebook rules cascade
to descendants at `/` boundaries. The most specific matching pattern wins;
equal-length ties go to the later override.

```json
{
  "version": 1,
  "defaults": { "read": true, "edit": false, "create": false, "delete": false },
  "overrides": [
    { "notebooks": ["Personal"], "edit": true, "create": true }
  ]
}
```

The JSON schema itself has no environment-variable overrides. CLI location
and backend selection can be influenced by `NOOKBRIDGE_SERVICE_CONFIG`
(service config path), `NOOKBRIDGE_SETTINGS_BACKEND` (`nix` or `cli`, default
`cli` when no service config specifies a backend), `NOOKBRIDGE_SETTINGS_PATH`
(settings path, subject to installed-path restrictions), and
`XDG_CONFIG_HOME`/`HOME` (user settings path fallback). `NOOKBRIDGE_NIX_SETTINGS_SOURCE`
selects the displayed Nix source path, defaulting to
`nix-config/modules/nookbridge/settings.json`. In production wrappers, service
configuration may supply `settingsBackend`; when omitted, the CLI uses `cli`.
`NOOKBRIDGE_SERVICE_UNIT` selects the unit restarted and verified after a CLI
settings edit/reset (default `nookd.service`); `VISUAL` then `EDITOR` select the
editor for CLI-managed edits (default `vi`). These affect CLI behavior, not the
settings JSON schema. Nix-managed `edit` and `reset` are refused; change the
deployment source.

Validate without editing or restarting:

```text
nookctl settings validate
```
