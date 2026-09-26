# NixOS installation

## Reference deployment

NixOS is NookBridge's reference deployment. Its deployment configuration—not
the MCP client—creates the dedicated service identity, protected encrypted
state directory, runtime socket, root-owned policy, and systemd credential
delivery.

The production Nix wrappers and secret wiring are maintained in the canonical
deployment repository, separate from this application repository. This is
intentional: deployment secrets and host-specific state must never be committed
here.

For a non-NixOS Linux host that still uses Nix for reproducible application
packaging, use the [generic systemd installation](installation-systemd.md).
That installer does not use NixOS module evaluation; it creates the equivalent
systemd boundary explicitly.

## Required deployment properties

Before provisioning, verify that the host deployment provides all of the
following:

- a dedicated `nookbridge` service identity and protected state directory;
- a `nookbridge-clients` group for approved Unix-socket clients only;
- a root-owned, non-secret daemon configuration and selected method policy;
- a systemd credential named `nookbridge-db-key`, sourced from approved secret
  management rather than plaintext configuration or the Nix store;
- a Unix socket under `/run/nookbridge`, with no TCP/HTTP listener;
- root-operated provisioning and sync wrappers supplied by the canonical
  deployment repository. The generic systemd installer exposes these as
  `notesbridge provision` and `notesbridge sync`; NixOS command names and
  lifecycle wrappers are deployment-module contracts and must be verified
  against the active Nix configuration before use;

The daemon must fail closed if its credential or secure configuration is absent
or invalid. Do not substitute a development file-backed key store for this
production setup.

## Verify before provisioning

From an administrator context, confirm the deployment's service configuration
and unit status according to your host's Nix configuration. The narrow daemon
diagnostic is:

```text
nookd --check-config <absolute-config-path>
```

It intentionally returns categorical output only. Do not paste configuration
contents, credential paths, service environment, or state paths into support
requests.

Continue with [setup and provisioning](setup-and-provisioning.md) only after
the secure deployment boundary is in place.
