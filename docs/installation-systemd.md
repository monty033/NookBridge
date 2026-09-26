# Generic systemd Linux installation

NookBridge runs on Debian, Ubuntu, Fedora, and other Linux distributions with
systemd. The generic installer consumes a reviewed, prebuilt release artifact;
the target host does **not** need Nix, npm, or a global Node installation.

The first supported artifact target is `linux-x64-gnu` (x86_64 Linux with glibc).
The artifact carries its Node runtime, JavaScript bundle, production dependencies,
wrappers, and manifest. The installer renders the hardened systemd unit on the
target host; the artifact does not embed host-specific paths or account names.

## Requirements

- Linux with a systemd system manager;
- x86_64 CPU and glibc;
- root access for installation;
- `tar`, `gzip`, `sha256sum`, `flock`, and standard POSIX utilities;
- a reviewed artifact and its matching outer `SHA256SUMS` file;
- optional root-readable settings JSON and database-key files.

Do not put Notesnook passwords, MFA codes, tokens, or key contents in command
arguments, environment variables, logs, or chat. The installer only validates
and copies the supplied files into protected locations; systemd projects them
through fixed `LoadCredential=` labels.

## Install a release

Obtain the artifact and checksum file from the reviewed release. Verify that the
artifact filename and checksum line match before invoking the installer:

```bash
sha256sum --check --strict --status SHA256SUMS
```

Install as root:

```bash
sudo ./scripts/install-systemd.sh install \
  --artifact ./nookbridge-v1.2.3-linux-x64-gnu.tar.gz \
  --checksum-file ./SHA256SUMS \
  --settings-file /root/nookbridge-settings.json \
  --db-key-file /root/nookbridge-db-key
```

The installer:

1. acquires an exclusive transaction lock;
2. verifies the outer checksum and the archive manifest/payload;
3. extracts the release under `/opt/nookbridge/releases/1.2.3`;
4. atomically switches `/opt/nookbridge/current` to that release;
5. creates the `nookbridge` service account, private group, and client group;
6. writes `/etc/nookbridge/service.json` and protected credential inputs;
7. installs the hardened `nookd.service` and stable `/usr/local/bin` wrappers;
8. enables the systemd unit; on a first install it leaves the daemon stopped until
   provisioning completes, while upgrades activate it immediately;
9. runs the categorical health probe before committing upgraded installer state;
10. records the installer ledger.

The installer writes its ledger to `/etc/nookbridge/installer-state.json`.
Existing unmanaged `nookd.service` units are rejected. No state or credential
is deleted by the installer.

## Layout

```text
/opt/nookbridge/
  current -> releases/1.2.3
  releases/
    1.2.3/
      app/                 bundled dist and production node_modules
      bin/                 relocatable command wrappers
      runtime/bin/node     bundled Node runtime
      release.json         provenance and target manifest
      SHA256SUMS            payload inventory
/etc/nookbridge/
  service.json
  settings.json            optional, mode 0640
  db-key                   optional, mode 0400
  installer-state.json
/var/lib/nookbridge/       daemon state, mode 0750
/run/nookbridge/           runtime directory, mode 0750
```

## Verify

Use categorical diagnostics and service metadata only:

```bash
systemctl is-active nookd.service
nookd --check-config /etc/nookbridge/service.json
nookbridge-runtime-check
nookbridge-health --socket /run/nookbridge/nookbridge.sock
systemctl status nookd.service --no-pager
```

The long-running process runs as `nookbridge`, uses the private state group plus
the `nookbridge-clients` supplementary boundary, and binds the Unix socket at
`/run/nookbridge/nookbridge.sock`. This installer does not create a TCP or HTTP
listener.

### The operator group is the mutation capability

The installer creates three groups:

| group | purpose |
| --- | --- |
| `nookbridge` | private state group; owns the state directory |
| `nookbridge-clients` | the read boundary — browse, search, view, status |
| `nookbridge-operators` | the **mutation** capability — apply-edit, apply-undo, create |

`nookbridge-operators` is created but nobody is added to it. That is deliberate:
membership is what allows a peer to change a note, so it should be granted as a
decision rather than inherited. Add the identity that runs your operator CLI:

```bash
sudo usermod -aG nookbridge-clients,nookbridge-operators "$OPERATOR_USER"
```

A peer may be in both groups. `nookbridge-clients` alone is enough to read and
list notes — including a locked one — but it is **not** enough to mutate: the
daemon refuses a mutating method for a peer without the operator group. A locked
note refuses mutation outright (`vault_locked`), and an operation the note's
notebook policy forbids is refused (`permission_denied`); per-notebook overrides
live in the settings file.

The operator socket is a separate path from the service socket
(`/run/nookbridge/operator.sock`). The daemon's peer-credential authorization
is the enforcement boundary for that socket: filesystem ownership remains the
service user's runtime ownership because both listeners are created by the same
hardened, unprivileged daemon. Do not treat membership in
`nookbridge-operators` as a substitute for the daemon check, or vice versa.

## Upgrade, rollback, and retention

Use `upgrade` with the new artifact. Do not overwrite a release directory by
hand:

```bash
sudo ./scripts/install-systemd.sh upgrade \
  --artifact ./nookbridge-v1.2.4-linux-x64-gnu.tar.gz \
  --checksum-file ./SHA256SUMS \
  --settings-file /root/nookbridge-settings.json \
  --db-key-file /root/nookbridge-db-key
```

The previous release remains available. If a later operational check requires a
rollback, select only a version already below the managed releases directory:

```bash
sudo ./scripts/install-systemd.sh rollback --to 1.2.3
```

Prune only after the new release is healthy. `--keep 2` is the minimum and keeps
the active and immediate previous releases:

```bash
sudo ./scripts/install-systemd.sh prune --keep 3
```

A failed post-activation health check restores the previous `current` symlink
and restarts the daemon against it. Do not retry a failed mutation or sync while
the service is unhealthy; inspect the categorical service state first.

## Provision and sync

From a protected host TTY, run the installed operator wrappers:

```text
notesbridge provision
notesbridge sync
```

The product-name alias `nookbridge provision` / `nookbridge sync` is also
installed. The standalone `nookbridge-provision` and `nookbridge-sync` names
remain available for compatibility.

Both are root-gated transient systemd operations. Authentication material is
collected interactively and is never placed in command arguments or environment
snapshots. The wrappers suspend `nookd.service` automatically while they own
the shared state, then restore its prior active state on every exit path. A
successful provisioning operation activates the daemon when it was initially
inactive. The sync operation is fetch-only; it is not a generic full-sync path.

The fetch-only sync wrapper briefly stops `nookd.service` before invoking the
sync transient unit so the transient unit is the only process holding
`/var/lib/nookbridge/nookbridge.lock`. If the daemon was active before sync, it
is started again on both success and failure; if it was initially inactive, the
wrapper leaves it inactive. The wrapper preserves the sync command's exit
status; a sync failure surfaces to the operator unchanged.

## Building an artifact

Artifact assembly is package-manager-neutral at the target, but release builds
must run where the builder's requirements hold. The release workflow selects the
runner registered under the `nixos` label rather than pinning a container or entering
the repository's flake, so the compiler, glibc, and utility versions are properties of
that machine; the builder checks for the tools it needs and refuses a tree it cannot
build. The builder requires:

- a clean Git source tree;
- a completed `dist/` and production `node_modules/` tree;
- the pinned Node 22.23.2 runtime;
- explicit measured glibc and libstdc++ baseline values; and
- a deterministic `SOURCE_DATE_EPOCH`.

The canonical local command shape is:

```bash
npm ci
npm run build
npm prune --omit=dev
export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)"
npm run artifact:linux -- \
    --source-dir "$PWD" \
    --node-runtime "$(command -v node)" \
    --output-dir ./artifacts \
    --version 1.2.3 \
    --source-date-epoch "$SOURCE_DATE_EPOCH" \
    --min-glibc 2.36 \
    --min-libstdcxx GLIBCXX_3.4.29 \
    --operator-peercred-helper /tmp/nookbridge-operator-peercred-helper
```

`--operator-peercred-helper` is required: the artifact packages the helper binary
at `app/operator-peercred-helper`. Build it the way the release workflow does, so
the packaged binary is the freestanding static one the artifact expects:

```bash
STATIC_GLIBC="$(nix build --no-link --print-out-paths 'nixpkgs#glibc.static')"
cc -O2 -std=c11 -Wall -Wextra -Werror -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables \
  -fno-pie -no-pie -nostdlib -static -Wl,-e,_start -Wl,--build-id=none \
  -L"$STATIC_GLIBC/lib" -o /tmp/nookbridge-operator-peercred-helper \
  native/operator-peercred.c
```

The builder invokes the verifier before reporting success. Release signing,
SBOM publication, and additional architectures are separate release gates.

## GitHub one-command installer

A standalone bootstrap script (`scripts/install-from-github.sh`) is shipped
as `install.sh` on each reviewed GitHub release. The bootstrap downloads
the artifact + outer `SHA256SUMS`, generates a fresh database key and a
default closed settings JSON, and hands them to the existing transactional
installer. After install it interactively prompts for optional access
settings editing, Notesnook provisioning, and a final fetch-only sync.
See [github-one-command-installer.md](github-one-command-installer.md)
for the exact UX, non-interactive escape hatches, and the security
boundary.

## NixOS path

NixOS continues to use the Nix package and module path. The generic artifact
installer is an additional distribution path and must not be used to mutate a
NixOS generation. The packaged `nookbridge-health` and
`nookbridge-runtime-check` entry points remain available through `nix/package.nix`.
