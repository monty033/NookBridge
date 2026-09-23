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
is terminal-success. The tag workflow fails closed unless it can read that
successful `main` run for the tagged commit from the Forgejo Actions API. It then
repeats the artifact build as a final release-local gate, so a release cannot
publish assets if the runner or artifact verification fails. The preflight and
candidate jobs use the same static glibc discovery, helper compilation, packaging,
and verifier commands; only the publishing steps are tag-only.

The preflight lookup uses a separate read-only `RELEASE_PREFLIGHT_TOKEN`; the
source-controlled install, rebuild, test, and packaging commands do not receive
the repository `GITHUB_TOKEN`. The lookup paginates the Actions API instead of
assuming the valid run is among the newest 100 records.

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

## Operator command

`scripts/release.sh` (wrapped by `just release`, `just release-promote`, and
`just release-status`) is the normal way to execute the candidate and promotion
gates. It is a convenience layer: the workflow keeps enforcing every gate, so a
release is no less strict when the command is used, and no more correct when it
is bypassed by hand.

- `release.sh status` is read-only. It prints the version from the canonical
  commit, whether the version surfaces agree, whether the `main` preflight for
  that commit succeeded, whether the version and promotion tags already exist,
  and the current mirror release state.
- `release.sh tag` reads the version from the canonical commit, refuses to run
  unless the version surfaces agree, no `v<VERSION>` or `promote-v<VERSION>`
  exists locally or on the canonical remote, and the exact commit has a
  terminal-successful `main` preflight. It then creates the annotated
  `NookBridge v<VERSION>` tag, pushes it, waits for the run, and reports the
  candidate assets. The tag targets the fetched canonical commit, so local
  working-tree state cannot change what is released. A release whose workflow
  succeeded but whose candidate release cannot be read or is incomplete exits
  non-zero, so automation cannot read an unverified release as success.
- `release.sh promote` refuses to run unless the tag exists, the mirror release
  is still a prerelease candidate at that commit with exactly the five-asset
  set, the release's `target_commitish` equals the canonical tag commit, and no
  promotion tag exists. It then pushes `promote-v<VERSION>` and waits for the
  promotion run. The promotion job itself validates the promotion ref's version
  syntax, matches the promotion ref against the canonical tag's commit, runs its
  verification tooling from that tagged revision, compares the published
  installers byte-for-byte with the tagged sources, and re-checks the complete
  asset set and the release's target commit before and after it clears the
  prerelease flag.

Both mutating commands confirm before pushing; `--yes` skips the prompt and
`--no-watch` skips waiting for the run. The command reads public release state
anonymously; it never needs a token unless the Forgejo API requires one, in
which case `NOOKBRIDGE_API_TOKEN` is read from the environment rather than the
command line.

The command treats every input that decides whether a guard passes as
untrusted:

- The canonical remote is authenticated by host **and** repository path, with no
  explicit port, for its fetch URL and for **every** configured push URL, so a
  lookalike host, a second push destination, or a divergent `pushurl` cannot
  receive the tag.
- Those resolved URLs are used for the fetch, the tag lookup, and the push
  itself, so rewriting the remote configuration after validation cannot redirect
  an already-approved release.
- The Forgejo and GitHub endpoints are derived from that identity rather than
  taken from the environment, and an API response served through a redirect is
  refused. The environment overrides used by the test fixtures are refused
  unless `NOOKBRIDGE_RELEASE_TEST_MODE` is set, and even then they only relax the
  identity check for a local filesystem remote. Never set them for a real
  release.
- A remote lookup that cannot be performed is an error, never evidence that a
  tag is absent.
- A push whose outcome cannot be determined is reported as uncertain. A push that
  failed without proof that nothing reached the remote keeps the local tag and
  tells the operator to confirm the remote state; the command does not decide for
  them by deleting the evidence.
- Remote-derived values are escaped before they are printed as `key=value`
  fields, so a forged newline in a run URL or an asset name cannot satisfy a
  status or asset check, and error output is redacted so no credential or raw
  remote diagnostic reaches a log.
- A remote whose fetch or push destination is changed by a Git URL rewrite rule
  (`insteadOf`/`pushInsteadOf`) is refused rather than used: git expands a
  rewrite when it reports a URL and again when the URL is used, so the configured
  value and the reported value must agree. Every configured push destination is
  checked, not only the first one, and the rules are consulted directly because
  `git remote get-url --push` does not expand `pushInsteadOf`. A rule is accepted
  only when its replacement still names the canonical repository, so a local
  https/ssh spelling preference keeps working. A `.git` path segment in any
  spelling, an explicit port, or an SSH principal other than the hosting account
  is likewise not the canonical repository.
- The `Justfile` recipes forward their arguments to the command as positional
  parameters (`"$@"`), never interpolated into the command text, so an argument
  cannot run before the release command validates it.
- The command-line entry points of the release tooling compare their module URL
  with `pathToFileURL(process.argv[1])`, because `import.meta.url` percent-encodes
  a path while `process.argv[1]` does not: a checkout under a path containing a
  space would otherwise run nothing and exit successfully, which reads as a passed
  gate. A preflight query that returns no data is likewise a failure, not a match.
- No read token is ever sent while test mode is on, and a reported candidate must
  still be a prerelease pointing at the commit that was built. An exhausted
  run-page budget or an unrecognized API payload is a failed lookup, not a missing
  run.
- Readiness requires that nothing has been published for the version yet: an
  existing mirror release or promotion tag makes `release_ready=false`, because
  the tag would be rejected after it had already been created locally.
- A push is verified against the host's own record of the tag, read through the
  API rather than through git: a `pushInsteadOf` rule can redirect a push even
  when the destination is given as an explicit URL, and a rule added after the
  last pre-push check cannot be observed beforehand, so a push that reports
  success is only accepted once the canonical ref is confirmed to name the object
  that was pushed. Local git configuration cannot redirect an HTTPS request to the
  canonical API, and the API path appends the repository exactly once.
- A rewrite rule is accepted only when the URL it actually produces — with the
  matched prefix removed and the replacement base prepended, applied until the URL
  stops changing — still names the canonical repository. Checking the replacement
  base alone accepts a base that appends its suffix into a destination that is not
  the canonical repository.
- A canonical URL may not carry HTTPS userinfo: the value is passed to `git` as an
  argument, where a credential is readable by any local process, and the canonical
  remote is addressed anonymously.
- The release version is SemVer (`major.minor.patch`, optional `-prerelease`, no
  leading zeros in any numeric component or numeric prerelease identifier) and at
  most 64 characters, which is the limit the artifact builder enforces. Build
  metadata (`+`) is refused: it is legal SemVer but it cannot survive asset naming
  and query-string handling unchanged. Asset names are percent-encoded where they
  become query values. The tag-triggered workflow re-checks the version surfaces
  (installer pin, `package.json`, `package-lock.json`) before it publishes, because
  a tag pushed by hand does not pass through the operator command.
- Canonical API endpoints are derived from the canonical identity with the
  repository path appended exactly once: the API base is an API root, and each
  caller appends `/repos/<owner>/<name>/...`.
- A release carries exactly the expected assets. A missing asset and an unexpected
  asset both fail the gate, before and after the promotion flip.
- Promotion re-verifies the artifact, its checksum file, and the installers after
  the prerelease flag is flipped, not only before, because a release asset can be
  replaced between the checks and the update.

The preflight gate is always `main`; there is no branch selection to configure,
because the tag-triggered workflow accepts only a `main` preflight.

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
6. Confirm the release state: `just release-status`.
7. Create and push the tag with `just release`. It re-checks the version
   surfaces, the existing tags, and the successful `main` preflight before it
   pushes, then reports the candidate and the assets.
8. Verify the artifact manifest, checksums, release assets, and installer URL.
9. Accept the candidate on a clean host, then promote it with
   `just release-promote`. Promotion is the only step that moves the general
   install path.
