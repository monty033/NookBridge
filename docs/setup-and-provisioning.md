# Setup and provisioning

Provisioning is a root-operated, interactive administrative action. It is not
an MCP capability and must never be delegated to an agent.

## First provisioning

On the deployed host, use a real host TTY as root:

```text
notesbridge provision
```

`nookbridge provision` is also installed as a product-name alias. The older
standalone `nookbridge-provision` wrapper remains available for compatibility.

Enter the Notesnook account information only when the program prompts with
echo-disabled input. Never pass passwords, MFA codes, recovery material,
tokens, or account names through command arguments, environment variables, or
configuration files.

The command runs as the protected service identity and uses the same
systemd-delivered database credential as `nookd`. This is true for both the
NixOS reference deployment and the generic systemd installation. Development
commands such as `nookctl auth live-login` are not substitutes for production
provisioning: they can use a separate development store.

## Initial read-only synchronization

After successful provisioning, run the separate root-operated wrapper:

```text
notesbridge sync
```

`nookbridge sync` is also installed as a product-name alias. The older
standalone `nookbridge-sync` wrapper remains available for compatibility.

The wrappers suspend `nookd` automatically while they own the shared encrypted
state, then restore its prior active state on every exit path. Users must not
stop the service manually. Provisioning starts `nookd` after successful
authentication when it was initially inactive; sync preserves an initially
inactive daemon state. The sync wrapper performs the bridge's fetch-only
synchronization path and must not be replaced by a generic or full-sync
command. Once it completes, verify the approved MCP client can connect to the
Unix socket.

## Routine operation

- Keep provisioning and synchronization manual administrative operations.
- Make policy changes through the root-owned deployment configuration, then
  validate and restart the service through the host's normal change process.
- Use [usage](usage.md) for MCP access and bounded operator workflows.
- If the state appears damaged, stop and preserve it; use
  [troubleshooting](troubleshooting.md) rather than deleting or recreating it.
