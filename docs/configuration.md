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
