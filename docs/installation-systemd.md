# Generic systemd Linux installation

NookBridge can run on a Linux distribution with systemd and Nix without using
NixOS. This path is intentionally small: Nix builds the pinned application
package, while the installer creates the service identity, protected files,
Unix socket service, and systemd credential projection.

This is a pre-alpha installation path. It is intended for Debian, Ubuntu,
Fedora, and similar systemd distributions with a working Nix installation.
Docker, macOS, and Windows remain unsupported.

## Requirements

- Linux with a systemd system manager and `systemd-run --pty`;
- Nix with flakes enabled;
- `x86_64-linux` or `aarch64-linux` host architecture;
- root access for the installation step;
- a root-owned settings JSON file;
- a root-owned database-key file supplied by the approved provisioning process.

Do not put Notesnook passwords, MFA codes, tokens, or key contents in command
arguments, environment variables, logs, or chat. The installer reads neither
secret value; it only validates ownership and permissions, then copies the
key into the protected system location for systemd to deliver.

## Install

Obtain a reviewed NookBridge checkout, then inspect the installer and run it as
root. The default source is the canonical `main` branch; production operators
should prefer a reviewed immutable `rev=` source reference.

```bash
./scripts/install-systemd.sh \
  --settings-file /root/nookbridge-settings.json \
  --db-key-file /root/nookbridge-db-key \
  --source 'git+https://git.montycasa.net/patrick/NookBridge?rev=<reviewed-commit>'
```

The installer:

1. builds `#nookbridge` from the selected flake source;
2. creates the `nookbridge` service user and `nookbridge-clients` group;
3. installs `/etc/nookbridge/service.json` and the supplied settings/key files;
4. installs `/etc/systemd/system/nookd.service`;
5. exposes `nookd`, `nook-mcp`, `nookctl`, provisioning, and sync commands under
   `/usr/local/bin`;
6. validates the service config and settings before enabling the daemon; and
7. reloads systemd and starts `nookd.service`.

Existing managed files are never replaced unless `--force` is supplied. The
installer does not delete state, reset credentials, or provide an uninstall
operation.

## Verify

Use only categorical diagnostics and service metadata:

```bash
systemctl is-active nookd.service
nookd --check-config /etc/nookbridge/service.json
nookctl settings validate
systemctl status nookd.service --no-pager
```

The daemon reads both credentials through systemd `LoadCredential=`. The
long-running process runs as `nookbridge`, owns `/var/lib/nookbridge`, and
binds only `/run/nookbridge/nookbridge.sock`; no TCP or HTTP listener is
created by this installer.

## Provision and sync

From a protected host TTY, run:

```text
nookbridge-provision
nookbridge-sync
```

Both commands are root-gated wrappers around transient hardened systemd units.
They collect authentication material interactively and run under the same
service identity and database credential boundary as `nookd`. The sync command
is fetch-only; it is not a generic or full-sync command.

## Updates

Review the new source revision and rerun the installer with `--force`, the same
settings file, and the same database-key source. The encrypted state directory
is not replaced by an update:

```bash
./scripts/install-systemd.sh --force \
  --settings-file /root/nookbridge-settings.json \
  --db-key-file /root/nookbridge-db-key \
  --source 'git+https://git.montycasa.net/patrick/NookBridge?rev=<new-reviewed-commit>'
```

Before changing policy, validate the complete settings file and treat a failed
service restart as a deployment failure. Do not run sync or mutations while the
daemon is unhealthy.
