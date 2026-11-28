# Changelog

All notable user-visible changes are recorded here. The project is pre-alpha;
release entries describe the supported boundary at the time of the release.

## Unreleased

### Added

- Protocol-2 response bodies for note reads. A daemon that advertises protocol 2
  can return note Markdown as a declared body when the caller offers to accept
  one, so a read that answered `oversize` only because the Markdown did not fit
  one frame now returns the whole note, provided the stored row is under the
  read threshold and the text can be carried as a body.
  A read still goes out as a single frame first and is retried with `accept` only
  when it does not fit, so concurrent reads never contend for the body slot and
  callers that do not negotiate see byte-identical results. The content ceiling
  this project wants is Notesnook's own; today's bounds — the stored-row read
  threshold, the response budget and the wire body bound — are staging values
  that come from decoding, projection and encoding running on the daemon's main
  thread, and issue #337 removes them.
- Optional `operatorAccess` service-configuration block. It maps groups or users
  to the capability families `discover`, `read`, `write`, `conflict` and
  `admin`, is deny-by-default and has no deny entries, and is evaluated by the
  operator authorizer before any handle, lock or notebook read. `admin` stays
  with `nookbridge-operators`. Without the block, the base group keeps every
  family and its gid is resolved at startup, so an account whose effective gid
  is that group is admitted where it was previously refused everything; a failed
  lookup falls back to name matching, which is the old behaviour exactly. An
  invalid block refuses startup with a closed code that never repeats the
  offending value, including a principal that does not resolve, is privileged or
  cannot reach the operator socket. Each decision records one audit line with the
  matching entry index and the family only.

### Fixed

- An operator request refused after the caller is admitted is now attributable
  in the daemon log. The reply code alone could not distinguish "the daemon
  never built that capability" from "it built it and the call failed" — both
  answer `service_unavailable` — so an unwired runtime, a categorized runtime
  refusal, an uncaught throw, a failing authorization step and a reply that
  cannot be serialized each record their method, the reply code (or `no_reply`
  when nothing was sent), why the refusal happened and a fixed class for the
  error. The record holds no message, parameters, handle, title, path or
  request identifier.
- The operator socket no longer swallows an authorization failure or an
  unreadable reply: both closed the connection leaving no trace, and are now
  recorded like any other refusal.
- Requests the socket drops before dispatch are now recorded too. A frame that
  does not parse, one whose declared length is unusable, one that overflows the
  frame limit, a method this socket does not carry, and a peer that cannot be
  identified each closed the connection with no reply and no trace; from a
  client that reports a dead connection as `service_unavailable`, that was
  indistinguishable from a daemon that had stopped answering. Each now records
  `no_reply` with the fixed method `(unattributed)`, because the method and
  parameters in such a frame are the caller's own text. These records are
  written before any policy decision, and the length checks before the caller
  is identified. Five
  cases stay unrecorded because nothing was refused: the idle and lifetime
  timeouts, a client that leaves before or part-way through its frame, one that
  finishes its frame and leaves before it is identified, and the drops made at
  the connection cap or when idle sockets are closed at shutdown.
- Recovery reinitialize leaves state the service user can open. Fresh required
  members take the state root's owner and mode `0600`; before, they were
  root-owned inside a service-owned root, and the daemon could not start on
  them (issue #288).
- The `auth` commands (live-login, status and logout) read the production key from
  the systemd credential slot when `CREDENTIALS_DIRECTORY` is set, and refuse to
  open a state root owned by another user, so running them as root against the
  service-owned production directory cannot leave the daemon unusable state.
  Without a caller-supplied key the runtime does not create a development key at
  or below the production state directory, subdirectories included. Conflict,
  sync and write commands keep their call shape; on production state they now
  refuse at runtime construction instead of minting that development key
  (issue #288).
- The operator path diagnostic no longer describes a locked note's body.
  `notes.path_diagnostic` reports content type and structure markers worked out
  from the body, and it trusted the content record's own `locked` flag. A Vault
  lock is a `vault -> note` relation, so a locked note — and a note whose lock
  cannot be decided — is now refused instead of described, and the report shows
  those values as unavailable.
- A Vault link now locks a note even when the note has a readable content row.
  Core stores the lock as a `vault → note` relation, so a content record that
  reads `locked: false`, or carries no marker, was taken as proof the note was
  unlocked. Metadata reads, discovery, `notes.get` and every write now consult
  that link for any note whose content marker is not itself `locked: true`. A
  linked note is hidden from discovery, `notes.get` answers
  `contentStatus: "locked"`, and every mutation refuses with `vault_locked`; a
  probe that cannot answer stays undecidable, so discovery withholds the note
  and `notes.get` refuses to serve the body at all.
- `notes.delete` now works on a note that has a title and no body. Core reads
  rows with `select *`, so a note created without a body carries
  `contentId: null`; the write projection rejected that as a malformed
  identifier before the revision, lock and conflict guards ran, so a note that
  `notes.get` served and `notes.search` listed could not be trashed. Metadata-only
  edits (title, pin, favorite, notebook, tags) on such a note now work for the
  same reason; content edits and appends still refuse. Before an absent body is
  read as unlocked the write seam queries the note's incoming relations: a Vault
  link, or an incoming-link query that cannot be answered, refuses with
  `vault_locked`, and a note that names a content row this database has not
  received refuses with `sync_required` instead of acting on a body it cannot see.
- `notes.update` no longer fails with `sync_failed` when the patch carries
  `listKind` alongside `content`. The adapter treats `listKind` as codec intent,
  not a note attribute: it steers content encoding but is excluded from
  `appliedFields`, which reports only persisted fields. A `listKind`-only update
  is rejected by the adapter as `invalid_input` before mutation; the RPC handler
  rejects that request shape as `invalid_request` before invoking the adapter.
- `notes.update` now accepts multi-line Markdown in `patch.content`. Four
  layers (the MCP tool validator, the socket client, the RPC parser, and the RPC
  handler) rejected tab, newline, and carriage return in update content, so any
  multi-line update failed with a bare `invalid_request`. They now match
  `notes.create` and `notes.append`: tab, LF, and CR are allowed, every other
  control character is still rejected, and the title and identifier checks are
  unchanged.
- The trailing-checklist merge in `notes.append` now matches stored lists that
  carry Notesnook's `data-block-id` attributes. Notesnook adds those to every
  list and paragraph when content is read, so the previous bare-tag matcher
  never merged into a real stored list and started a second list instead. Only
  that one attribute is accepted; other attributes, nested lists, and trailing
  blocks still skip the merge.
- Content inputs for `notes.create`, `notes.append`, and `notes.update` now
  accept up to 4096 UTF-8 bytes (previously 512). The RPC boundary gains a
  dedicated `maxContentBytes` limit; query, path, title, and identifier caps
  are unchanged.
- The keep-both conflict resolver re-reads the bridge-local copy before
  overwriting the original, before clearing the conflict flag, and before
  reporting `resolved`. A copy that changes in that window is reported as the
  new closed outcome `copy_changed` instead of `resolved`, with nothing deleted
  (issue #305). The flag stays set for the first two re-checks; the third runs
  after the flag is cleared, so a change there returns `copy_changed` with the
  flag already cleared. Any non-resolved outcome after the original's content write
  marks the original pending for upload approval (issues #305, #317).
- `notes.append` now merges a checklist fragment into the document's trailing
  list when it is the same kind (`simple-checklist` or `task-list`) instead of
  starting a second list. Nested, mixed, or non-trailing lists keep the
  previous append behavior.
- Edits to existing notes (`notes.append`, and `notes.update` when content
  changes) now mark the note's content row as unsynced in the same statement
  as the body write. Previously the pinned `Content.updateByNoteId` left
  `synced` untouched, so sync pushed the note row but never the edited body
  and other clients kept the old content.

## [0.1.3] - 2026-09-26

Release focused on reliable production operator workflows and clearer command
entrypoints.

### Summary

- Fixed provisioning and sync state-lock collisions by suspending `nookd`
  automatically around transient operator commands.
- Added the `notesbridge provision` and `notesbridge sync` umbrella commands,
  while retaining the legacy standalone wrappers for compatibility.
- Added runtime contract coverage for daemon restoration, failure handling,
  inactive-service behavior, and umbrella command dispatch.

### Fixed

- Prevented provisioning from failing before the interactive credential flow
  when `nookd` already owns the shared encrypted state.
- Preserved the daemon's prior active state on operator failure and sync.

## [0.1.2] - 2026-09-22

Release focused on safer, more reproducible releases and portable Linux
artifacts.

### Summary

- Added guarded release commands and gates for synchronized versions, exact source
  commits, annotated tags, complete asset sets, and artifact verification.
- Hardened the Linux artifact workflow for a reproducible self-hosted build
  environment and portable release artifacts.
- Added a freestanding operator credential helper so portable artifacts do not
  depend on the build host's filesystem.
- Hardened canonical repository validation and secure release publishing.

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
- Authenticate the release command's canonical remote by host, repository path,
  explicit hosting account, and the instance's canonical SSH port, for its fetch
  URL and for every configured push URL; push to the validated URLs rather than to
  a remote name so a configuration change after validation cannot redirect a
  release.
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

[0.1.3]: https://git.montycasa.net/patrick/NookBridge/releases/tag/v0.1.3
[0.1.2]: https://git.montycasa.net/patrick/NookBridge/releases/tag/v0.1.2
[0.1.1]: https://git.montycasa.net/patrick/NookBridge/releases/tag/v0.1.1
[0.1.0]: https://git.montycasa.net/patrick/NookBridge/releases/tag/v0.1.0
