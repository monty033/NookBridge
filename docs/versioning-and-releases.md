# Versioning and releases

## Policy

NookBridge uses Semantic Versioning with a deliberate pre-1.0 policy. The
project is still pre-alpha, so the public release line begins at `0.1.0`, not
`1.0.0`.

The project does not use `alpha`, `beta`, or `rc` suffixes by default. A
pre-release suffix is appropriate only when there is a real staged testing
cycle that needs to distinguish candidate builds from the normal release line.

## Version meanings before 1.0

Until the project reaches `1.0.0`:

- **Patch** (`0.1.1`) means a backward-compatible bug fix, security fix,
  documentation correction, or packaging correction.
- **Minor** (`0.2.0`) means a new capability, meaningful behavior change, or
  intentional pre-1.0 contract change.
- **Major** (`1.0.0`) is reserved for the first stable public API and supported
  operational contract.

A release note must call out any compatibility or migration impact even when
SemVer permits the change under the pre-1.0 policy.

## Version sources and synchronization

The version must be synchronized across these surfaces:

1. `package.json` is the machine-readable project version.
2. `package-lock.json` repeats the root package version and must match it.
3. Git tags use the `v<VERSION>` form, such as `v0.1.0`.
4. Linux artifact names, manifests, installer pins, and release records use the
   same version.

A release is not complete if these values disagree. Local build directory names
and candidate labels are not releases and must not be presented as official
versions.

## Release rules

- Tag only a canonical merge commit on Forgejo `main`.
- Run the project checks and artifact verification before tagging.
- Do not move an existing tag to a different commit.
- Do not reuse a released version for different contents.
- Forgejo is canonical; the tag-triggered workflow publishes the corresponding
  public GitHub release and assets.
- Keep the release description focused on user-visible behavior, verification,
  known limitations, and upgrade notes.

The historical `v1.2.6` tag is outside this policy. If it is retired before
`v0.1.0`, it must not be reused or repointed. The new release line starts at
`v0.1.0` on the canonical merge commit selected for that release.

## Reliable release execution

The release is deliberately split into four gates:

1. **Merge gate:** the release PR contains the synchronized version surfaces,
   changelog, installer pin, release fixtures, and workflow regression coverage.
2. **Runner preflight gate:** every push to canonical `main` runs the complete
   Linux artifact build and verifier on the `nixos` Forgejo runner using an
   ephemeral `ci-<commit>` artifact version. A `runner-test/<name>` branch runs
   the same path before merge when a release-sensitive workflow change needs a
   direct runner check. These runs never publish a release or alter `latest`.
3. **Candidate gate:** pushing `v<VERSION>` runs the artifact build, verifies the
   manifest against the tag commit, publishes the exact five GitHub assets, and
   creates a prerelease candidate. The candidate must not move the `latest`
   installer path.
4. **Promotion gate:** after clean-target acceptance, push `promote-v<VERSION>`.
   The promotion job downloads the candidate artifact, re-verifies its checksum
   and source commit, then clears the prerelease flag and reads the release back.

Do not create a release tag until the `main` preflight for the exact merge commit
is terminal-success. The tag workflow repeats the artifact build as a final
release-local gate, so a release cannot publish assets if the runner or artifact
verification fails. The preflight and candidate jobs use the same static glibc
discovery, helper compilation, packaging, and verifier commands; only the
publishing steps are tag-only.

The artifact workflow must fail loudly before compilation when a required runner
input is missing. Static glibc discovery accounts for Nix store hash prefixes
(`*-glibc-*-static`) and prints the discovered path or a diagnostic listing. The
workflow test must assert this exact pattern; a green source suite is not enough
if the runner cannot produce the artifact.

A public tag is immutable. If a tag-triggered workflow fails, fix the workflow on
`main` and increment the patch version. Do not move or reuse the failed tag, and
do not manually declare the release complete while its asset set is incomplete.
A release is published only when all of these agree:

- the canonical tag target and merged `main` commit;
- a terminal successful tag workflow;
- the five expected assets: `install.sh`, `install-systemd.sh`,
  `verify-linux-artifact.sh`, `SHA256SUMS`, and the versioned Linux artifact;
- the artifact manifest source commit and checksum;
- the mirrored GitHub release and public download URLs.

## When NookBridge reaches 1.0

`1.0.0` should wait until these conditions are true:

- the MCP and operator contracts are intentionally stable;
- supported installation, upgrade, rollback, and recovery paths are documented
  and tested;
- the sync lifecycle and mutation boundaries are operationally understood;
- release artifacts and version metadata are consistently generated and
  verified; and
- remaining production-MVP gaps are either closed or explicitly outside the
  support promise.

Until then, the `0.x` line is an honest signal that users should expect change.

## Release checklist

1. Confirm the intended version in `package.json` and `package-lock.json`.
2. Update `CHANGELOG.md` with user-visible changes and limitations.
3. Run checks, typecheck, lint, formatting, build, and artifact verification.
4. Merge the release-ready change into Forgejo `main`.
5. Wait for the terminal-success `main` runner preflight for that exact merge
   commit. If the release changes the workflow or runner contract, first run a
   `runner-test/<name>` branch preflight before merging.
6. Create `v<VERSION>` on the canonical merge commit.
7. Push the tag and allow Forgejo Actions to build and publish the candidate.
8. Verify the artifact manifest, checksums, release assets, and installer URL.
9. Promote or announce the release only after the release gates pass.
