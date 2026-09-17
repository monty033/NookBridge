# GitHub one-command installer

The GitHub one-command installer ships the prebuilt NookBridge Linux
artifact to a reviewed systemd host in a single command, then walks the
operator through the optional first-install steps. The artifact under
distribution is `scripts/install-from-github.sh`, served from
`https://github.com/monty033/NookBridge/releases/latest/download/install.sh`.

## One-line quick start

```bash
curl -fsSL https://github.com/monty033/NookBridge/releases/latest/download/install.sh \
  | sudo bash
```

The interactive run asks whether to:

1. Provision the Notesnook account (echo-disabled TTY prompt inside
   `nookbridge-provision` — no secrets in argv, environment, or logs).
2. Edit access settings (after provisioning, writes through `nookctl settings
   edit` against `/etc/nookbridge/settings.json` — the exact file the daemon
   consumes via `LoadCredential=`).
3. Run the fetch-only sync (`nookbridge-sync`).

The download, outer SHA256SUMS verification, fresh database key, default
closed settings JSON, and the existing transactional installer run
without prompting.

## Non-interactive automation

For automation use `--yes` to accept every default, and combine it with
the explicit escape hatches to skip steps you don't want:

```bash
curl -fsSL https://github.com/monty033/NookBridge/releases/latest/download/install.sh \
  | sudo bash -s -- --yes --no-edit-settings --no-sync
```

| Option                 | Effect                                                                   |
| ---------------------- | ------------------------------------------------------------------------ |
| `--yes`                | Accept every interactive default (no secrets recorded in argv)           |
| `--no-provision`       | Skip the interactive provisioning step                                   |
| `--no-sync`            | Skip the optional fetch-only sync step                                   |
| `--no-fetch`           | Alias for `--no-sync`                                                    |
| `--no-edit-settings`   | Skip the optional settings editor step                                   |
| `--edit-settings`      | Always run the optional settings editor (overrides the prompt default)   |
| `--release-base URL`   | Override the GitHub release base URL                                     |
| `--help`               | Show the bootstrap usage                                                 |

The bootstrap also accepts `NOOKBRIDGE_RELEASE_BASE` as an environment
override of the release base URL.

## What the bootstrap does

1. Parses argv and refuses unknown options (`exit 2`).
2. Refuses to run as a non-root user (`exit 2`).
3. Requires only standard utilities: `bash`, `curl`, `sha256sum`,
   `mktemp`, `awk`, `id`, `mkdir`, `chmod`, `od`, `tr`, `wc`, `sleep`, and
   `systemctl`. The downloaded generic installer performs the remaining
   archive checks. No Nix, no npm, no global Node.
4. Downloads the release's `nookbridge-v$VERSION-linux-x64-gnu.tar.gz`
   artifact and matching `SHA256SUMS` into a private staging directory
   under `/tmp`.
5. Verifies the artifact's SHA256 against the outer `SHA256SUMS` entry
   (basename lookup only — the artifact path is never echoed).
6. Generates a fresh 64-hex-char database key into a `0400` tempfile,
   and a closed-default settings JSON (read: true, edit: false,
   create: false, delete: false) into a `0640` tempfile. Both tempfiles
   are removed on exit.
7. Downloads and verifies the matching `install-systemd.sh` and
   `verify-linux-artifact.sh` helpers from the same release, then invokes the
   transactional installer with the generated inputs.
8. Optionally prompts for `nookbridge-provision`. Authentication
   material is collected only through the existing echo-disabled TTY
   prompt inside the operator wrapper; the bootstrap never puts
   passwords, MFA codes, tokens, or key contents in argv or environment
   snapshots.
9. Runs the categorical health probe via `nookbridge-health`.
10. Optionally prompts for `nookctl settings edit`, pinned to the system
    settings path, and verifies health again after the restart.
11. Optionally prompts for the fetch-only sync (`nookbridge-sync`).

## Security boundary

- The bootstrap never logs, prints, or forwards the database-key
  contents, Notesnook passwords, MFA codes, tokens, encryption keys, or
  key contents.
- The database key is generated locally with `od -An -vtx1 -N32
  /dev/urandom` and stored in a `0400` tempfile that is removed when
  the bootstrap exits. It is handed to `install-systemd.sh install` via
  `--db-key-file`, which atomically copies it into `/etc/nookbridge/db-key`
  under `LoadCredential=nookbridge-db-key:`. systemd projects the file
  contents to the daemon through fixed credential labels — never
  through argv or environment.
- The settings JSON is generated with all overrides disabled. After
  provisioning and the first health check, the operator can opt into a
  narrower policy by editing it through `nookctl settings edit` against
  the system path; the daemon is restarted and health-checked afterward.

## Testing

The bootstrap ships with a focused test file
(`tests/github-installer-bootstrap.test.ts`) that exercises:

- `--help` and unknown-option handling;
- bootstrap exit code when the bootstrap can't run as root in a test
  harness;
- bootstrap argv never contains `--password`, `--token`, `--db-key`, or
  any 64-hex-char blob;
- the bootstrap hands `install-systemd.sh` the expected
  `--settings-file` / `--db-key-file` / `--artifact` / `--checksum-file`
  paths;
- `--no-provision`, `--no-sync`, `--no-fetch`, `--no-edit-settings`,
  and `--edit-settings` flags each suppress or force their respective
  optional steps;
- the `nookctl settings edit` invocation is pinned to
  `NOOKBRIDGE_SETTINGS_PATH=/etc/nookbridge/settings.json`;
- the bootstrap passes `bash -n` syntax validation.

Run the focused test set:

```bash
npx vitest run tests/github-installer-bootstrap.test.ts
```

Run the full suite:

```bash
npm test
```

## Release hosting

Forgejo remains the canonical development source; the public distribution
target is `https://github.com/monty033/NookBridge`. Release publishing is
automated by `.forgejo/workflows/linux-artifact.yml` after a `v*` tag push.
Configure the `RELEASE_PUBLISH_TOKEN` Forgejo repository secret as documented
in [Forgejo-to-GitHub release publishing](forgejo-github-release-publishing.md),
then:

1. Merge the reviewed commit on `main` and tag it `v$VERSION`.
2. Push the tag to Forgejo. The workflow builds the artifact in the pinned
   CI/container environment:

   ```bash
   npm ci
   npm run build
   npm prune --omit=dev
   export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)"
   npm run artifact:linux -- \
     --source-dir "$PWD" \
     --node-runtime "$(command -v node)" \
     --output-dir ./artifacts \
     --version "$VERSION" \
     --source-date-epoch "$SOURCE_DATE_EPOCH" \
     --min-glibc 2.36 \
     --min-libstdcxx GLIBCXX_3.4.29
   ```

3. The workflow creates or updates the GitHub release and uploads the artifact,
   `SHA256SUMS`, `scripts/install-systemd.sh`, `scripts/verify-linux-artifact.sh`,
   and the version-pinned bootstrap as `install.sh`.
