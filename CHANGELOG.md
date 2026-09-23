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
