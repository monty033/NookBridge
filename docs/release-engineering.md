# Release artifact engineering

This maintainer guide records the Linux artifact build path implemented by the
Forgejo release workflow. It is not an end-user installation procedure. For
release publication and promotion gates, see
[Forgejo-to-GitHub release publishing](forgejo-github-release-publishing.md)
and [versioning and releases](versioning-and-releases.md). For target-host
installation, see [generic systemd installation](installation-systemd.md).

## Canonical runner build

The current workflow builds on the `nixos` Forgejo runner. It verifies pinned
Node 22.23.2 and npm 10.9.8, obtains or verifies the pinned Node runtime archive,
installs dependencies without lifecycle scripts and then rebuilds them, runs
build/tests/typecheck/lint/format checks, and prunes development dependencies.
The artifact build step derives `SOURCE_DATE_EPOCH` from the commit, measures
the runner's glibc and libstdc++ baselines, discovers static glibc under
`/nix/store`, and compiles the peer-credential helper as a static freestanding
binary. The workflow then builds and verifies the artifact against the exact
commit and version.

The workflow's authoritative commands are in
[`.forgejo/workflows/linux-artifact.yml`](../.forgejo/workflows/linux-artifact.yml).
In particular, it invokes `npm run artifact:linux` with `--build-node`,
`--runtime-tarball`, `--operator-peercred-helper`, `--output-dir`, `--version`,
`--source-date-epoch`, `--min-glibc`, and `--min-libstdcxx`, followed by
`npm run artifact:verify` with artifact, checksum, expected commit, and expected
version. Use that workflow as the command source rather than copying a stale
local recipe: `scripts/build-linux-artifact.sh` accepts multiple runtime-input
forms, but its command-line options and required inputs are governed by the
script and `package.json`.

The helper is compiled from `native/operator-peercred.c` using the runner's
static glibc library. The workflow checks that the resulting executable has no
`INTERP` program header and contains no runner-specific paths. The Nix package
uses a separate musl static build; do not substitute that package build for the
portable artifact workflow without updating and verifying the release contract.

## Release boundary

A successful artifact build is not publication or promotion. Release publication
requires the separate version/channel, successful preflight, artifact
provenance, checksum, and asset-set gates documented in the release guides.
Do not claim a release or deployment based only on a local build.
