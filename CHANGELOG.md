# Changelog

All notable user-visible changes are recorded here. The project is pre-alpha;
release entries describe the supported boundary at the time of the release.

## [0.1.2] - 2026-09-22

Patch release hardening static glibc discovery in the release workflow.

### Added

- `scripts/release.sh` (`just release`, `just release-promote`,
  `just release-status`) executes the candidate and promotion gates with the
  version, tag, preflight, and asset guards stated in the release policy.

### Fixed

- Match the hash-prefixed Nix store basename used by `glibc.static`.
- Emit actionable diagnostics when static glibc or `libc.a` is unavailable.
- Add regression coverage so the release workflow cannot silently revert to the
  non-matching store glob.
- Build the operator peer-credential helper freestanding so portable artifacts
  cannot embed host `/nix/store` paths.
- Authenticate the release command's canonical remote by host and repository
  path, with no explicit port, for its fetch URL and for every configured push
  URL, and push to the validated URLs rather than to a remote name so a
  configuration change after validation cannot redirect a release.
- Derive the Forgejo and GitHub endpoints from that remote identity, refuse API
  responses served through a redirect, and refuse fixture overrides unless test
  mode is set and the remote is a filesystem path.
- Refuse a remote tag lookup error as an error rather than as an absent tag, and
  report a push whose outcome is unknown as uncertain instead of as
  "nothing was published".
- Exit non-zero when the release run succeeds but the candidate release cannot
  be verified, instead of reporting an unverified release as success.
- Forward the `Justfile` release recipes' arguments as positional parameters
  instead of interpolating them into the command text, so an argument cannot run
  a command before the release command validates it.
- Compare each release tooling module URL with `pathToFileURL(process.argv[1])`
  so a checkout path containing a space cannot reduce the preflight gate to a
  silent success, and refuse a preflight query that returns no data.
- Check every configured push destination, and consult `insteadOf` and
  `pushInsteadOf` rules directly, because `git remote get-url --push` does not
  expand `pushInsteadOf`; accept a rule only when its replacement still names the
  canonical repository.
- Keep the local tag when a failed push cannot be shown to have published
  nothing, and tell the operator to confirm the remote instead of asserting that
  nothing was published.
- Report `release_ready=false` when a mirror release or a promotion tag already
  exists for the version, and re-verify installer bytes after the prerelease flag
  is flipped.
- Refuse a canonical remote that carries HTTPS userinfo, so a credential cannot
  reach `git` as a command argument.
- Verify a successful tag push against the host's own record of the ref, read
  through the API, because a `pushInsteadOf` rule can redirect a push even when it
  is given an explicit URL and the rule can be added after the last pre-push check.
- Validate the release version as SemVer rather than as a filename-safe token, and
  refuse build metadata (`+`), which cannot survive asset naming and query-string
  handling unchanged; refuse an asset name outside `[A-Za-z0-9._-]` rather than
  encoding it, so no name can change the request it appears in.
- Bind the published artifact to the release version and not only to the commit: the
  verifier refuses an archive whose manifest version or file name disagrees with the
  version the release is named for.
- Recreate a partial candidate on a re-run rather than refusing to touch it, because a
  tag cannot be moved and an interrupted upload would otherwise be unrecoverable.
- Neutralise `BASH_ENV` and `ENV` in the token-bearing steps and assert they are
  empty, because a non-interactive shell sources them at startup: a value written to
  `GITHUB_ENV` by a tagged step would otherwise have that shell read the token before
  its first line ran.
- Require exactly the expected release assets, before and after the promotion flip,
  and re-verify the artifact and its checksum file after the flip as well.
- Derive the canonical API endpoints as an API root plus one repository path, so the
  post-push verification cannot build a doubled `/repos/<owner>/<name>/repos/...`
  URL that 404s and blocks every release.
- Check a rewrite rule by the URL it actually produces — applied until the URL stops
  changing — rather than by its replacement base, so a base that appends its suffix
  into a noncanonical destination is refused.
- Reject a numeric prerelease identifier with a leading zero (`1.2.3-01`) and a
  version longer than the 64 characters the artifact builder accepts, and verify the
  `package.json` and `package-lock.json` version surfaces in the publishing workflow
  so a tag pushed by hand cannot publish a mismatched artifact.
- Hold no secret in any step that executes code from the released revision: the
  preflight gate no longer carries a read token at all (the runs API is readable
  anonymously, and a refused read is an error rather than an empty result), every job
  clears Forgejo's automatic token under both of the names it is exported as
  (`FORGEJO_TOKEN` and `GITHUB_TOKEN`, either of which carries repository write
  access) and fails the job if the runner re-injects one, and the promotion job is
  split so the candidate verification and the post-flip re-verification run with no
  publishing token while the step that does hold it runs the runner's own `curl` — as
  resolved from an explicit `PATH` and validated against trusted prefixes — over a
  line-oriented data file, without sourcing cross-step shell. Bearer tokens reach
  `curl` through a mode-600 configuration file and every call runs with `-q`, so
  neither a command line nor a default configuration file carries it. The token steps
  read the release they act on from the API by tag instead of trusting a file written
  by an earlier step. A host runner gives the released revision and the token step the
  same user, so this limits accidental exposure, not a process that stays behind
  deliberately.
- Sanitise every message the command prints: remote-derived URLs are redacted and
  terminal control characters are stripped, so a rewrite target carrying credentials
  or an operator's rejected argument cannot leak or inject output.
- Verify the pinned Node runtime on every run and re-extract it from the verified
  archive each time, so a persistent runner or a preceding source-controlled step
  cannot substitute the runtime that later gets packaged.
- Apply the version policy from one shared script, which the operator command
  delegates to, so a version the command accepts cannot be one the workflow rejects
  after the tag is already published.
- Keep the publishing token out of any step that can be influenced by the released
  revision. The candidate is prepared, the release is written, and the result is
  re-read in three separate steps: only the middle one holds the token, it resolves
  its tools from an explicit PATH whose directories cover a conventional Linux runner
  and a NixOS one rather than hardcoding a path, and it refuses a `curl` or `awk`
  resolved from outside those prefixes. A workflow test asserts that both
  token-bearing steps — the one that publishes and the one that promotes — carry that
  PATH, name no repository script, and look up the release they act on by tag rather
  than reading its id from an earlier step's file.
- Check every shell variable a workflow step references against what that step
  defines, receives through `env`, or is given by the runner. A step runs in a fresh
  shell, so a variable renamed in one place and read in another is an unbound-variable
  failure under `set -u`; this class has twice broken a release path that the
  behavioural tests did not execute.
- Refuse an API response whose schema does not carry the fields the decision depends
  on: a release payload without `draft`, or a tag ref without a ref and commit sha, is
  unreadable rather than absent. Reporting "no release exists" for an answer that
  could not be parsed tells an operator their published tag is missing.
- Include local tags in the readiness report: a working copy holding `v<version>` or
  `promote-v<version>` is not ready to release, even though nothing is published yet.
- Configure the preflight lookup with no secret. Only the publish token is needed;
  the preflight reads the public Actions API anonymously and fails closed on a
  refused read, naming the requirement when a host refuses an anonymous read instead
  of reporting a missing preflight.
- Neutralise the inherited environment of the token-bearing steps beyond
  `BASH_ENV`: `curl` reads a default configuration file even when given `--config`, the
  loader searches `LD_LIBRARY_PATH` and honours `LD_PRELOAD` and `LD_AUDIT`, and a
  planted trust anchor would let a request be rewritten rather than stopped. Every one
  of those variables, plus the proxy variables and both names of the automatic token,
  is cleared and re-asserted in the step body, and every `curl` invocation in the
  workflow runs with `-q`.
- Clear the OpenSSL environment in the token-bearing steps as well: `OPENSSL_CONF`,
  `OPENSSL_MODULES`, and `OPENSSL_ENGINES` let a step running released code nominate a
  configuration and provider modules that the TLS stack loads before the request, which
  clearing the certificate sources does not prevent.
- Validate the release payload before anything authenticated happens. The publishing
  retry path deletes a release before it recreates it, so a tampered or missing payload
  used to take the immutable tag's candidate with it and leave nothing to retry from.
- Start each checkout from an empty workspace. A runner reuses its workspace, so a
  previous failed run could leave a repository, build output, or release context files
  that the next run tripped over, and `git init` fails outright on an existing `.git`.
- Name every command the build invokes in the prerequisite check, including `getconf`,
  `strings`, `grep`, `sort`, and `tail`, so a runner missing one fails with a diagnosis
  instead of halfway through artifact assembly, and read the source anonymously: the
  checkout no longer carries a token-bearing branch that no job can reach.
- Recheck the commit a release names inside the step that acts on it. The publishing
  step is given the runner's commit directly and compares both the release payload and
  the live release against it before deleting or creating anything, and the promotion
  step compares the release it is about to publish against the commit the token-free
  verification read from the canonical host's own ref. A release retargeted between
  verification and the authenticated write is refused instead of being repaired
  afterwards.
- Escape remote-derived values before printing them as `key=value` fields, so a
  forged newline in a run URL or an asset name cannot satisfy a status or asset
  check, and redact credentials and raw remote diagnostics from error output.
- Require the promotion workflow to verify the complete published asset set
  before it clears the prerelease flag, to match the promotion ref against the
  canonical release tag's commit, to run its verification tooling from that
  tagged revision, to compare the published installers byte-for-byte with the
  tagged sources, and to re-check the asset set after the flip.
- Refuse a remote whose fetch or push destination is changed by a Git URL
  rewrite rule (`insteadOf`/`pushInsteadOf`), and refuse a `.git` path segment
  or an SSH principal other than the hosting account.
- Never send a read token while test mode is on, so a fixture run that inherits
  credentials cannot disclose them to an overridden endpoint.
- Redact query strings and fragments, not only userinfo, and strip control
  characters from commit subjects and other repository-derived text.
- Require a reported candidate to still be a prerelease pointing at the commit
  that was built, and treat an exhausted run-page budget as a failed lookup
  rather than as a missing run.
- Require the promotion ref to name the canonical tag's commit, validate the
  promotion ref's version syntax before it reaches an API path, and re-check the
  release's target commit after the flag flip.

## [0.1.1] - 2026-09-22

Patch release correcting the portable Linux artifact build and Forgejo runner
integration.

### Fixed

- Added the static glibc toolchain required to build the operator
  peer-credential helper on the NixOS Forgejo runner.
- Removed the unsafe dynamically linked fallback that could embed `/nix/store`
  paths in portable artifacts.
- Added an ELF portability check rejecting helpers with a dynamic interpreter.
- Preserved artifact provenance, checksum, and source-commit verification.

## [0.1.0] - 2026-09-22

First intentional pre-1.0 release line. This release is usable for the
recorded Linux deployment path, but the public contracts and broader production
support boundary remain subject to change.

### Added

- Narrow Unix-socket `nookd` service boundary and stdio MCP proxy.
- Credential-separated Notesnook authentication and encrypted local state.
- Bounded fetch-only read sync and read-only MCP tools.
- Approval-gated operator note browsing, search, get, create, edit, and undo.
- Fail-closed authorization, notebook-scoped policy evaluation, operation
  ownership, and categorical error handling.
- Linux artifact build, verification, systemd installation, health checks, and
  transactional release activation.
- Regression coverage and live acceptance for the notebook-membership fallback
  used by operator authorization.

### Known limitations

- The project remains pre-alpha and the API/configuration contracts may change.
- The broader production-MVP release gates are not all closed.
- Delete is intentionally not part of the bounded operator notes surface.
- Sync and mutation support remain narrowly scoped; do not infer general account
  or cross-device support from the validated scenarios.

[0.1.2]: https://git.montycasa.net/patrick/NookBridge/releases/tag/v0.1.2
[0.1.1]: https://git.montycasa.net/patrick/NookBridge/releases/tag/v0.1.1
[0.1.0]: https://git.montycasa.net/patrick/NookBridge/releases/tag/v0.1.0
