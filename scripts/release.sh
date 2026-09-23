#!/usr/bin/env bash
#
# NookBridge release operator command.
#
#   scripts/release.sh status               read-only report of the release state
#   scripts/release.sh tag    [--yes] [--no-watch]
#   scripts/release.sh promote [<version>] [--yes] [--no-watch]
#
# The command never invents a version and never moves a tag. It reads the
# version from the canonical commit, refuses to tag unless that exact commit has
# a terminal-successful main preflight, and refuses to promote unless the
# candidate release is still a prerelease with the complete asset set.
#
# Trust model. Every input that decides whether a guard passes is treated as an
# untrusted input:
#
#   * the canonical remote is authenticated by host AND repository path for both
#     its fetch URL and its push URL, so a lookalike host or a divergent pushurl
#     cannot redirect the tag;
#   * the Forgejo and GitHub endpoints are derived from that identity instead of
#     being accepted from the environment;
#   * a remote lookup that cannot be performed is an error, never evidence that
#     the tag is absent;
#   * a push whose outcome cannot be determined is reported as uncertain rather
#     than as "nothing was published".
#
# Every guard fails closed before anything is pushed. A push that provably did
# not reach the remote deletes the local tag it created, because a public tag is
# immutable: tagging a commit that cannot publish would burn that version
# permanently rather than fail safely.
#
# Test mode. The fixture overrides below are refused unless
# NOOKBRIDGE_RELEASE_TEST_MODE is set, and even then they may only relax the
# canonical identity check for a local filesystem remote. They must never be set
# for a real release:
#
#   NOOKBRIDGE_RELEASE_TEST_MODE   enable the fixture overrides (tests only)
#   NOOKBRIDGE_CANONICAL_REMOTE    remote name to tag and push
#   NOOKBRIDGE_FORGEJO_API_BASE    Forgejo API base for this repository
#   NOOKBRIDGE_GITHUB_API_BASE     GitHub API base
#   NOOKBRIDGE_GITHUB_REPOSITORY   public mirror repository
#
# Other settings:
#
#   NOOKBRIDGE_API_TOKEN           read token when the Forgejo API needs one
#   NOOKBRIDGE_WATCH_INTERVAL      seconds between run polls (default 10)
#   NOOKBRIDGE_WATCH_TIMEOUT       seconds to wait for a run (default 1800)

set -euo pipefail

readonly CANONICAL_HOST="git.montycasa.net"
readonly CANONICAL_PATH="patrick/NookBridge"
readonly MIRROR_REPOSITORY="monty033/NookBridge"
readonly RELEASE_BRANCH="main"
readonly WORKFLOW_ID="linux-artifact.yml"
readonly RUN_EVENT="push"
readonly API_TOKEN="${NOOKBRIDGE_API_TOKEN:-}"
readonly WATCH_INTERVAL="${NOOKBRIDGE_WATCH_INTERVAL:-10}"
readonly WATCH_TIMEOUT="${NOOKBRIDGE_WATCH_TIMEOUT:-1800}"
readonly PENDING_STATUSES="running waiting blocked queued"

test_mode=false
if [ -n "${NOOKBRIDGE_RELEASE_TEST_MODE:-}" ] && [ "${NOOKBRIDGE_RELEASE_TEST_MODE:-}" != "0" ]; then
  test_mode=true
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

canonical_remote=''
canonical_url=''
repo_root=''
runs_url=''
mirror_api_base=''
mirror_repository=''
release_commit=''
version=''
requested_version=''
run_output=''
run_code=0
tag_output=''
assume_yes=false
watch=true

usage() {
  cat <<'TEXT'
Usage: scripts/release.sh <command> [options] [version]

Commands:
  status             Print the current version, canonical commit, preflight
                     state, tag state, and mirror release state.
  tag                Tag the canonical commit with the version read from
                     package.json, push it, and watch the release run.
  promote [version]  Promote an accepted candidate release to the general
                     install path.

Options:
  --yes, -y          Skip the confirmation prompt.
  --no-watch         Do not wait for the workflow run to finish.
  --help, -h         Show this help.

The normal release is: `release.sh tag`, accept on a clean host, then
`release.sh promote`. Promotion is the only step that moves the public
`latest` installer path.
TEXT
}

fail() {
  printf 'release: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

field_of() { # $1 = key=value text, $2 = key
  printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -n 1
}

json_field() { # dotted path, JSON on stdin
  node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      let value = JSON.parse(input);
      for (const key of process.argv[1].split(".")) {
        if (value === null || typeof value !== "object") process.exit(2);
        value = value[key];
      }
      if (typeof value !== "string" && typeof value !== "number") process.exit(2);
      process.stdout.write(String(value));
    });
  ' "$1"
}

##########
# Trust boundaries
##########

# Accept a remote URL only when it names the canonical host and repository. A
# suffix match on the repository path alone would accept an attacker-controlled
# host that mirrors the path, so both components are checked.
canonical_url_ok() {
  local url=$1 host='' path='' rest
  case "$url" in
    https://*)
      rest=${url#https://}
      rest=${rest#*@}
      host=${rest%%/*}
      host=${host%%:*}
      path=${rest#*/}
      ;;
    ssh://*)
      rest=${url#ssh://}
      rest=${rest#*@}
      host=${rest%%/*}
      host=${host%%:*}
      path=${rest#*/}
      ;;
    *@*:*)
      rest=${url#*@}
      host=${rest%%:*}
      path=${rest#*:}
      ;;
    *)
      return 1
      ;;
  esac
  path=${path%.git}
  case "$path" in
    */) path=${path%/} ;;
  esac
  [ "$host" = "$CANONICAL_HOST" ] || return 1
  [ "$path" = "$CANONICAL_PATH" ] || return 1
  return 0
}

# A filesystem path is never a canonical release target; only the test fixtures
# may use one, and only while test mode is on.
local_path_url() {
  case "$1" in
    *://*|*@*:*) return 1 ;;
    *) return 0 ;;
  esac
}

remote_url_ok() {
  if canonical_url_ok "$1"; then
    return 0
  fi
  if [ "$test_mode" = true ] && local_path_url "$1"; then
    return 0
  fi
  return 1
}

require_trusted_configuration() {
  if [ "$test_mode" = true ]; then
    return 0
  fi
  local name value
  for name in NOOKBRIDGE_CANONICAL_REMOTE NOOKBRIDGE_FORGEJO_API_BASE \
    NOOKBRIDGE_GITHUB_API_BASE NOOKBRIDGE_GITHUB_REPOSITORY; do
    value=${!name:-}
    if [ -n "$value" ]; then
      fail "$name is only honoured when NOOKBRIDGE_RELEASE_TEST_MODE is set"
    fi
  done
}

##########
# Repository and endpoint resolution
##########

resolve_canonical_remote() {
  local name fetch_url push_url
  if [ -n "${NOOKBRIDGE_CANONICAL_REMOTE:-}" ]; then
    name=$NOOKBRIDGE_CANONICAL_REMOTE
    git remote get-url "$name" >/dev/null 2>&1 \
      || fail "the configured canonical remote does not exist: $name"
    fetch_url=$(git remote get-url "$name")
    push_url=$(git remote get-url --push "$name" 2>/dev/null || true)
    [ -n "$push_url" ] || push_url=$fetch_url
    remote_url_ok "$fetch_url" \
      || fail "remote $name does not fetch from $CANONICAL_HOST/$CANONICAL_PATH: $fetch_url"
    remote_url_ok "$push_url" \
      || fail "remote $name does not push to $CANONICAL_HOST/$CANONICAL_PATH: $push_url"
    printf '%s' "$name"
    return 0
  fi
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    fetch_url=$(git remote get-url "$name" 2>/dev/null || true)
    push_url=$(git remote get-url --push "$name" 2>/dev/null || true)
    [ -n "$fetch_url" ] || continue
    [ -n "$push_url" ] || push_url=$fetch_url
    if remote_url_ok "$fetch_url" && remote_url_ok "$push_url"; then
      printf '%s' "$name"
      return 0
    fi
  done < <(git remote)
  fail "no remote fetches from and pushes to $CANONICAL_HOST/$CANONICAL_PATH; add one, or set NOOKBRIDGE_RELEASE_TEST_MODE with NOOKBRIDGE_CANONICAL_REMOTE for fixture work"
}

forgejo_runs_url() {
  local base
  if [ "$test_mode" = true ] && [ -n "${NOOKBRIDGE_FORGEJO_API_BASE:-}" ]; then
    base=$NOOKBRIDGE_FORGEJO_API_BASE
  else
    base="https://$CANONICAL_HOST/api/v1/repos/$CANONICAL_PATH"
  fi
  printf '%s/actions/runs' "$base"
}

resolve_mirror_api_base() {
  if [ "$test_mode" = true ] && [ -n "${NOOKBRIDGE_GITHUB_API_BASE:-}" ]; then
    printf '%s' "$NOOKBRIDGE_GITHUB_API_BASE"
    return 0
  fi
  printf '%s' 'https://api.github.com'
}

resolve_mirror_repository() {
  if [ "$test_mode" = true ] && [ -n "${NOOKBRIDGE_GITHUB_REPOSITORY:-}" ]; then
    printf '%s' "$NOOKBRIDGE_GITHUB_REPOSITORY"
    return 0
  fi
  printf '%s' "$MIRROR_REPOSITORY"
}

##########
# Remote state queries
##########

query_run() { # $1 = ref, $2 = commit, $3 = optional status filter
  RUNS_URL="$runs_url" \
  EXPECT_WORKFLOW="$WORKFLOW_ID" \
  EXPECT_EVENT="$RUN_EVENT" \
  EXPECT_REF="$1" \
  EXPECT_COMMIT="$2" \
  EXPECT_STATUS="${3:-}" \
  RUNS_TOKEN="$API_TOKEN" \
    node "$script_dir/release-api.mjs" find-run
}

collect_run() { # sets run_output and run_code: 0 match, 2 none, other failure
  set +e
  run_output=$(query_run "$1" "$2" "${3:-}" 2>"$work_dir/run-error.txt")
  run_code=$?
  set -e
}

github_release_state() { # $1 = tag
  GITHUB_API_BASE="$mirror_api_base" \
  GITHUB_REPOSITORY="$mirror_repository" \
  RELEASE_TAG="$1" \
  GITHUB_READ_TOKEN="${NOOKBRIDGE_GITHUB_READ_TOKEN:-}" \
    node "$script_dir/release-api.mjs" release-state
}

# Print "absent" or "present <sha>" for a canonical tag. A lookup that cannot be
# performed is an error: reporting it as absence is how a fail-closed guard
# quietly becomes fail-open.
tag_state_of() { # $1 = tag; sets tag_output; returns 1 when the lookup failed
  tag_output=$(git ls-remote --tags "$canonical_remote" "refs/tags/$1" 2>"$work_dir/tag-lookup-error.txt") \
    || return 1
  if [ -z "$tag_output" ]; then
    printf 'absent'
  else
    printf 'present %s' "${tag_output%%$'\t'*}"
  fi
}

local_tag_exists() {
  git rev-parse --verify --quiet "refs/tags/$1" >/dev/null 2>&1
}

canonical_tag_commit() { # commit a canonical tag points at; empty when absent
  local state commit
  if ! state=$(tag_state_of "$1"); then
    fail "cannot check tag $1 on $canonical_remote: $(cat "$work_dir/tag-lookup-error.txt")"
  fi
  case "$state" in
    absent) return 0 ;;
    present\ *) commit=${state#present } ;;
    *) fail "unexpected tag state for $1: $state" ;;
  esac
  # ls-remote reports the tag object for an annotated tag, so fetch the ref and
  # peel it locally. The explicit refspec stores it in FETCH_HEAD without
  # creating a local tag.
  git fetch --quiet --no-tags "$canonical_remote" "refs/tags/$1" \
    || fail "cannot fetch tag $1 from $canonical_remote"
  if ! commit=$(git rev-parse --verify --quiet 'FETCH_HEAD^{commit}'); then
    fail "cannot resolve tag $1 to a commit"
  fi
  printf '%s' "$commit"
}

expected_asset_names() { # $1 = version
  printf '%s\n' \
    install.sh \
    install-systemd.sh \
    verify-linux-artifact.sh \
    SHA256SUMS \
    "nookbridge-v$1-linux-x64-gnu.tar.gz"
}

missing_assets() { # $1 = release state text, $2 = version
  local name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    printf '%s\n' "$1" | grep -Fxq "asset=$name" || printf '%s\n' "$name"
  done < <(expected_asset_names "$2")
}

##########
# Guards
##########

valid_version() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$ ]]
}

validate_watch_settings() {
  [[ "$WATCH_INTERVAL" =~ ^[0-9]+$ ]] \
    || fail "NOOKBRIDGE_WATCH_INTERVAL must be a whole number of seconds"
  [[ "$WATCH_TIMEOUT" =~ ^[0-9]+$ ]] \
    || fail "NOOKBRIDGE_WATCH_TIMEOUT must be a whole number of seconds"
}

resolve_release_target() {
  need_command git
  need_command node
  validate_watch_settings
  require_trusted_configuration
  if ! repo_root=$(git rev-parse --show-toplevel 2>/dev/null); then
    fail "run release commands from inside a clone of the repository"
  fi
  cd "$repo_root"
  canonical_remote=$(resolve_canonical_remote)
  canonical_url=$(git remote get-url "$canonical_remote")
  runs_url=$(forgejo_runs_url)
  mirror_api_base=$(resolve_mirror_api_base)
  mirror_repository=$(resolve_mirror_repository)
  git fetch --quiet --no-tags "$canonical_remote" "$RELEASE_BRANCH" \
    || fail "cannot fetch $RELEASE_BRANCH from $canonical_remote"
  if ! release_commit=$(git rev-parse --verify --quiet FETCH_HEAD); then
    fail "cannot resolve $RELEASE_BRANCH on $canonical_remote"
  fi
}

canonical_version() {
  local value
  if ! value=$(git show "$release_commit:package.json" 2>/dev/null | json_field version); then
    fail "cannot read the version from package.json at $release_commit"
  fi
  printf '%s' "$value"
}

version_sync_problems() { # $1 = commit, $2 = expected version
  local commit=$1 expected=$2 lock_version installer_version
  lock_version=$(git show "$commit:package-lock.json" 2>/dev/null | json_field version 2>/dev/null) \
    || lock_version=''
  if [ -z "$lock_version" ]; then
    printf 'package-lock.json has no readable version\n'
  elif [ "$lock_version" != "$expected" ]; then
    printf 'package-lock.json (%s) does not match package.json (%s)\n' "$lock_version" "$expected"
  fi
  installer_version=$(git show "$commit:scripts/install-from-github.sh" 2>/dev/null \
    | sed -n "s/^readonly RELEASE_VERSION='\([^']*\)'$/\1/p" || true)
  if [ -z "$installer_version" ]; then
    printf 'scripts/install-from-github.sh declares no RELEASE_VERSION\n'
  elif [ "$installer_version" != "$expected" ]; then
    printf 'installer pin (%s) does not match package.json (%s)\n' "$installer_version" "$expected"
  fi
}

require_version_sync() { # $1 = commit, $2 = version
  local problems
  problems=$(version_sync_problems "$1" "$2")
  [ -z "$problems" ] || fail "$problems"
}

require_tag_absent() { # $1 = tag
  local state
  if local_tag_exists "$1"; then
    fail "a local tag $1 already exists; a released version is never re-pointed"
  fi
  if ! state=$(tag_state_of "$1"); then
    fail "cannot check tag $1 on $canonical_remote: $(cat "$work_dir/tag-lookup-error.txt")"
  fi
  case "$state" in
    absent) return 0 ;;
  esac
  fail "canonical tag $1 already exists; a released version is never re-pointed"
}

require_main_preflight() { # $1 = commit; the gate is always the release branch
  collect_run "$RELEASE_BRANCH" "$1" success
  case $run_code in
    0) return 0 ;;
    2)
      fail "no successful $RELEASE_BRANCH runner preflight for $1; wait for it before tagging"
      ;;
    *)
      fail "cannot read Forgejo run state: $(cat "$work_dir/run-error.txt")"
      ;;
  esac
}

confirm() {
  local reply
  if [ "$assume_yes" = true ]; then
    return 0
  fi
  [ -t 0 ] || fail "confirmation is required; re-run with --yes in a non-interactive shell"
  printf '%s [y/N] ' "$1"
  read -r reply || reply=''
  case "$reply" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) fail "aborted" ;;
  esac
}

##########
# Publication
##########

# A push that reports failure may still have updated the remote. Report what is
# true instead of asserting that nothing happened.
publish_tag() { # $1 = tag, $2 = commit, $3 = message
  local tag=$1 commit=$2 message=$3 state
  git tag -a "$tag" "$commit" -m "$message" || fail "cannot create tag $tag"
  if git push "$canonical_remote" "refs/tags/$tag"; then
    note "Pushed $tag."
    return 0
  fi
  if ! state=$(tag_state_of "$tag"); then
    fail "pushing $tag failed and the remote state could not be read; inspect $canonical_remote for $tag before retrying"
  fi
  case "$state" in
    present\ *)
      fail "pushing $tag reported an error but the canonical tag now exists at ${state#present }; the release may already be running — inspect the run before taking any further action"
      ;;
  esac
  git tag -d "$tag" >/dev/null 2>&1 || true
  fail "pushing $tag failed and $canonical_remote has no such tag; the local tag was removed and nothing was published"
}

watch_release_run() { # $1 = ref, $2 = commit, $3 = description
  local deadline=$((SECONDS + WATCH_TIMEOUT))
  local announced=false status url
  note "Watching the $3 run (timeout ${WATCH_TIMEOUT}s)..."
  while :; do
    collect_run "$1" "$2" ''
    case $run_code in
      0)
        status=$(field_of "$run_output" status)
        url=$(field_of "$run_output" url)
        if [ "$announced" = false ] && [ -n "$url" ]; then
          note "Run: $url"
          announced=true
        fi
        case " $PENDING_STATUSES " in
          *" $status "*) ;;
          *)
            note "Result: $status"
            if [ "$status" = success ]; then
              return 0
            fi
            return 1
            ;;
        esac
        ;;
      2) ;;
      *)
        fail "cannot read Forgejo run state: $(cat "$work_dir/run-error.txt")"
        ;;
    esac
    if [ "$SECONDS" -ge "$deadline" ]; then
      fail "timed out after ${WATCH_TIMEOUT}s waiting for the $3 run"
    fi
    sleep "$WATCH_INTERVAL"
  done
}

report_candidate() { # $1 = version
  local tag="v$1" state missing
  state=$(github_release_state "$tag") || state=''
  if [ -z "$state" ]; then
    note "Could not read the mirror release state for $tag."
    return 0
  fi
  if [ "$(field_of "$state" exists)" != true ]; then
    note "The mirror has no release for $tag yet."
    return 0
  fi
  missing=$(missing_assets "$state" "$1")
  if [ -n "$missing" ]; then
    note "Release $tag is missing assets:"
    printf '%s\n' "$missing"
    return 0
  fi
  note "Candidate $tag has all five assets:"
  note "  https://github.com/$mirror_repository/releases/tag/$tag"
  note "Accept it on a clean host, then promote it:"
  note "  scripts/release.sh promote $1"
}

##########
# Commands
##########

command_status() {
  local problems state preflight="missing" release_tag_state promote_tag_state
  resolve_release_target
  version=${requested_version:-$(canonical_version)}
  valid_version "$version" || fail "invalid version: $version"
  if [ "$test_mode" = true ]; then
    note "test_mode=true (canonical identity checks are relaxed; never for a real release)"
  fi

  note "version=$version"
  note "canonical_remote=$canonical_remote"
  note "canonical_commit=$release_commit"
  note "canonical_subject=$(git show -s --format=%s "$release_commit")"

  problems=$(version_sync_problems "$release_commit" "$version")
  if [ -z "$problems" ]; then
    note "version_surfaces=synchronized"
  else
    note "version_surfaces=blocked"
    printf '%s\n' "$problems" | while IFS= read -r line; do
      [ -n "$line" ] || continue
      note "  $line"
    done
  fi

  release_tag_state=$(tag_state_of "v$version") \
    || fail "cannot check tag v$version on $canonical_remote: $(cat "$work_dir/tag-lookup-error.txt")"
  promote_tag_state=$(tag_state_of "promote-v$version") \
    || fail "cannot check tag promote-v$version on $canonical_remote: $(cat "$work_dir/tag-lookup-error.txt")"
  case "$release_tag_state" in
    absent) note "tag_v$version=absent" ;;
    *) note "tag_v$version=present" ;;
  esac
  case "$promote_tag_state" in
    absent) note "tag_promote-v$version=absent" ;;
    *) note "tag_promote-v$version=present" ;;
  esac

  collect_run "$RELEASE_BRANCH" "$release_commit" ''
  if [ $run_code -eq 0 ]; then
    preflight=$(field_of "$run_output" status)
    note "main_preflight=$preflight"
    note "main_preflight_url=$(field_of "$run_output" url)"
  elif [ $run_code -eq 2 ]; then
    note "main_preflight=missing"
  else
    preflight=unknown
    note "main_preflight=unknown"
  fi

  state=$(github_release_state "v$version") || state=''
  if [ -z "$state" ]; then
    note "mirror_release=unreachable"
  elif [ "$(field_of "$state" exists)" != true ]; then
    note "mirror_release=absent"
  elif [ "$(field_of "$state" prerelease)" = true ]; then
    note "mirror_release=candidate-prerelease"
    note "mirror_assets=$(printf '%s\n' "$state" | grep -c '^asset=' || true)"
  else
    note "mirror_release=published"
  fi

  if [ -z "$problems" ] && [ "$preflight" = success ] && [ "$release_tag_state" = absent ]; then
    note "release_ready=true"
  else
    note "release_ready=false"
  fi
}

command_tag() {
  local tag
  resolve_release_target
  version=$(canonical_version)
  valid_version "$version" || fail "invalid version: $version"
  tag="v$version"

  require_version_sync "$release_commit" "$version"
  require_tag_absent "$tag"
  require_tag_absent "promote-$tag"
  require_main_preflight "$release_commit"

  note "About to release NookBridge $tag"
  note "  commit: $(git show -s --format='%H %s' "$release_commit")"
  note "  remote: $canonical_remote"
  confirm "Create and push $tag?"

  publish_tag "$tag" "$release_commit" "NookBridge $tag"

  if [ "$watch" = true ]; then
    if ! watch_release_run "$tag" "$release_commit" "release"; then
      fail "the release workflow for $tag did not succeed; inspect the run before retrying"
    fi
    report_candidate "$version"
  fi
}

command_promote() {
  local tag promote_tag tag_commit state missing target
  resolve_release_target
  version=${requested_version:-$(canonical_version)}
  valid_version "$version" || fail "invalid version: $version"
  tag="v$version"
  promote_tag="promote-v$version"

  require_tag_absent "$promote_tag"
  if ! tag_commit=$(canonical_tag_commit "$tag"); then
    fail "cannot resolve the canonical tag $tag"
  fi
  [ -n "$tag_commit" ] || fail "canonical tag $tag does not exist; there is nothing to promote"

  state=$(github_release_state "$tag") || state=''
  [ -n "$state" ] || fail "cannot read the mirror release state for $tag"
  [ "$(field_of "$state" exists)" = true ] || fail "the mirror has no release for $tag"
  [ "$(field_of "$state" prerelease)" = true ] \
    || fail "$tag is not a prerelease candidate; it may already be promoted"
  missing=$(missing_assets "$state" "$version")
  [ -z "$missing" ] \
    || fail "$tag is missing release assets: $(printf '%s' "$missing" | tr '\n' ' ')"

  # The promotion workflow re-verifies the artifact against the release's own
  # target commit, so pushing the promotion ref at a different commit is a
  # doomed push that still consumes the promotion ref.
  target=$(field_of "$state" target_commitish)
  [ -n "$target" ] || fail "the mirror release for $tag reports no target commit"
  [ "$target" = "$tag_commit" ] \
    || fail "the mirror release for $tag targets $target but the canonical tag points at $tag_commit; refusing to promote a mismatched candidate"

  note "About to promote $tag"
  note "  candidate commit: $tag_commit"
  note "  remote: $canonical_remote"
  note "  the promotion run re-verifies the published artifact against that commit"
  confirm "Push $promote_tag?"

  publish_tag "$promote_tag" "$tag_commit" "Promote NookBridge $tag"

  if [ "$watch" = true ]; then
    if ! watch_release_run "$promote_tag" "$tag_commit" "promotion"; then
      fail "the promotion workflow for $tag did not succeed"
    fi
    note "Promoted $tag."
    note "  https://github.com/$mirror_repository/releases/tag/$tag"
  fi
}

parse_args() { # $1 = true when a positional version is accepted
  local allow_positional=$1
  shift
  while (($# > 0)); do
    case "$1" in
      --yes|-y) assume_yes=true ;;
      --no-watch) watch=false ;;
      --help|-h)
        usage
        exit 0
        ;;
      -*)
        fail "unknown option: $1"
        ;;
      *)
        if [ "$allow_positional" != true ]; then
          fail "this command does not take an argument: $1"
        fi
        [ -z "$requested_version" ] || fail "unexpected extra argument: $1"
        requested_version=$1
        ;;
    esac
    shift
  done
}

main() {
  local command=${1:-}
  case "$command" in
    status)
      shift
      parse_args false "$@"
      command_status
      ;;
    tag)
      shift
      parse_args false "$@"
      command_tag
      ;;
    promote)
      shift
      parse_args true "$@"
      command_promote
      ;;
    help|--help|-h)
      usage
      ;;
    '')
      usage
      exit 1
      ;;
    *)
      fail "unknown command: $command"
      ;;
  esac
}

main "$@"
