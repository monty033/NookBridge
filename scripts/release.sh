#!/usr/bin/env bash
#
# NookBridge release operator command.
#
#   scripts/release.sh status              read-only report of the release state
#   scripts/release.sh tag    [--yes] [--no-watch]
#   scripts/release.sh promote [<version>] [--yes] [--no-watch]
#
# The command never invents a version and never moves a tag. It reads the
# version from the canonical commit, refuses to tag unless that exact commit has
# a terminal-successful main runner preflight, and refuses to promote unless the
# candidate release is still a prerelease with the complete asset set.
#
# Every guard fails closed before anything is pushed. A failed push deletes the
# local tag it created, because a public tag is immutable: tagging a commit that
# cannot publish would burn that version permanently rather than fail safely.
#
# Environment overrides (defaults suit the canonical repository):
#
#   NOOKBRIDGE_CANONICAL_REMOTE    remote name to tag and push (else detected)
#   NOOKBRIDGE_CANONICAL_PATH      canonical owner/repository path
#   NOOKBRIDGE_RELEASE_BRANCH      canonical branch to release from (default main)
#   NOOKBRIDGE_FORGEJO_API_BASE    Forgejo API base for this repository
#   NOOKBRIDGE_GITHUB_API_BASE     GitHub API base (default https://api.github.com)
#   NOOKBRIDGE_GITHUB_REPOSITORY   public mirror (default monty033/NookBridge)
#   NOOKBRIDGE_API_TOKEN           read token when the Forgejo API needs one
#   NOOKBRIDGE_WATCH_INTERVAL      seconds between run polls (default 10)
#   NOOKBRIDGE_WATCH_TIMEOUT       seconds to wait for a run (default 1800)

set -euo pipefail

readonly WORKFLOW_ID="linux-artifact.yml"
readonly RUN_EVENT="push"
readonly RELEASE_BRANCH="${NOOKBRIDGE_RELEASE_BRANCH:-main}"
readonly CANONICAL_PATH="${NOOKBRIDGE_CANONICAL_PATH:-patrick/NookBridge}"
readonly CANONICAL_REMOTE_OVERRIDE="${NOOKBRIDGE_CANONICAL_REMOTE:-}"
readonly FORGEJO_API_BASE_OVERRIDE="${NOOKBRIDGE_FORGEJO_API_BASE:-}"
readonly mirror_api_base="${NOOKBRIDGE_GITHUB_API_BASE:-https://api.github.com}"
readonly mirror_repository="${NOOKBRIDGE_GITHUB_REPOSITORY:-monty033/NookBridge}"
readonly API_TOKEN="${NOOKBRIDGE_API_TOKEN:-}"
readonly WATCH_INTERVAL="${NOOKBRIDGE_WATCH_INTERVAL:-10}"
readonly WATCH_TIMEOUT="${NOOKBRIDGE_WATCH_TIMEOUT:-1800}"
readonly PENDING_STATUSES="running waiting blocked queued"

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

canonical_remote=''
canonical_url=''
repo_root=''
runs_url=''
release_commit=''
version=''
requested_version=''
run_output=''
run_code=0
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

remote_host() { # host component of a git remote URL
  local url=$1 rest
  case "$url" in
    https://*|http://*|ssh://*) rest=${url#*://} ;;
    *@*:*)
      rest=${url#*@}
      rest=${rest%%:*}
      [ -n "$rest" ] || return 1
      printf '%s' "$rest"
      return 0
      ;;
    *) return 1 ;;
  esac
  rest=${rest#*@}
  rest=${rest%%/*}
  [ -n "$rest" ] || return 1
  printf '%s' "$rest"
}

resolve_canonical_remote() {
  local name url
  if [ -n "$CANONICAL_REMOTE_OVERRIDE" ]; then
    git remote get-url "$CANONICAL_REMOTE_OVERRIDE" >/dev/null 2>&1 \
      || fail "the configured canonical remote does not exist: $CANONICAL_REMOTE_OVERRIDE"
    printf '%s' "$CANONICAL_REMOTE_OVERRIDE"
    return 0
  fi
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    url=$(git remote get-url "$name" 2>/dev/null || true)
    case "$url" in
      *"$CANONICAL_PATH"|*"$CANONICAL_PATH.git")
        printf '%s' "$name"
        return 0
        ;;
    esac
  done < <(git remote)
  if git remote get-url upstream >/dev/null 2>&1; then
    printf '%s' 'upstream'
    return 0
  fi
  fail "cannot identify the canonical remote; set NOOKBRIDGE_CANONICAL_REMOTE"
}

forgejo_runs_url() {
  local base host
  if [ -n "$FORGEJO_API_BASE_OVERRIDE" ]; then
    base=$FORGEJO_API_BASE_OVERRIDE
  else
    host=$(remote_host "$canonical_url") \
      || fail "cannot derive the Forgejo host from the canonical remote; set NOOKBRIDGE_FORGEJO_API_BASE"
    base="https://$host/api/v1/repos/$CANONICAL_PATH"
  fi
  printf '%s/actions/runs' "$base"
}

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

resolve_release_target() {
  need_command git
  need_command node
  if ! repo_root=$(git rev-parse --show-toplevel 2>/dev/null); then
    fail "run release commands from inside a clone of the repository"
  fi
  cd "$repo_root"
  canonical_remote=$(resolve_canonical_remote)
  canonical_url=$(git remote get-url "$canonical_remote")
  runs_url=$(forgejo_runs_url)
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

valid_version() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$ ]]
}

version_sync_problems() {
  local lock_version installer_version
  lock_version=$(git show "$release_commit:package-lock.json" 2>/dev/null | json_field version 2>/dev/null) \
    || lock_version=''
  if [ -z "$lock_version" ]; then
    printf 'package-lock.json has no readable version\n'
  elif [ "$lock_version" != "$version" ]; then
    printf 'package-lock.json (%s) does not match package.json (%s)\n' "$lock_version" "$version"
  fi
  installer_version=$(git show "$release_commit:scripts/install-from-github.sh" 2>/dev/null \
    | sed -n "s/^readonly RELEASE_VERSION='\([^']*\)'$/\1/p" || true)
  if [ -z "$installer_version" ]; then
    printf 'scripts/install-from-github.sh declares no RELEASE_VERSION\n'
  elif [ "$installer_version" != "$version" ]; then
    printf 'installer pin (%s) does not match package.json (%s)\n' "$installer_version" "$version"
  fi
}

local_tag_exists() {
  git rev-parse --verify --quiet "refs/tags/$1" >/dev/null 2>&1
}

remote_tag_exists() {
  [ -n "$(git ls-remote --tags "$canonical_remote" "refs/tags/$1" 2>/dev/null)" ]
}

canonical_tag_commit() { # commit a canonical tag points at; empty when the tag is absent
  local commit
  if [ -z "$(git ls-remote --tags "$canonical_remote" "refs/tags/$1" 2>/dev/null)" ]; then
    return 0
  fi
  # ls-remote reports the tag object for an annotated tag and offers no peeled
  # entry for a lightweight one, so fetch the ref and peel it locally. The
  # explicit refspec stores it in FETCH_HEAD without creating a local tag.
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

require_version_sync() {
  local problems
  problems=$(version_sync_problems)
  [ -z "$problems" ] || fail "$problems"
}

require_tag_absent() {
  if local_tag_exists "$1"; then
    fail "a local tag $1 already exists; a released version is never re-pointed"
  fi
  if remote_tag_exists "$1"; then
    fail "canonical tag $1 already exists; a released version is never re-pointed"
  fi
}

require_main_preflight() {
  collect_run "$RELEASE_BRANCH" "$release_commit" success
  case $run_code in
    0) return 0 ;;
    2)
      fail "no successful $RELEASE_BRANCH runner preflight for $release_commit; wait for it before tagging"
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

command_status() {
  local problems state preflight
  resolve_release_target
  version=${requested_version:-$(canonical_version)}
  valid_version "$version" || fail "invalid version: $version"

  note "version=$version"
  note "canonical_remote=$canonical_remote"
  note "canonical_commit=$release_commit"
  note "canonical_subject=$(git show -s --format=%s "$release_commit")"

  problems=$(version_sync_problems)
  if [ -z "$problems" ]; then
    note "version_surfaces=synchronized"
  else
    note "version_surfaces=blocked"
    printf '%s\n' "$problems" | while IFS= read -r line; do
      [ -n "$line" ] || continue
      note "  $line"
    done
  fi

  if remote_tag_exists "v$version"; then
    note "tag_v$version=present"
  else
    note "tag_v$version=absent"
  fi
  if remote_tag_exists "promote-v$version"; then
    note "tag_promote-v$version=present"
  else
    note "tag_promote-v$version=absent"
  fi

  preflight=missing
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

  if [ -z "$problems" ] && [ "$preflight" = success ] && ! remote_tag_exists "v$version"; then
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

  require_version_sync
  require_tag_absent "$tag"
  require_tag_absent "promote-$tag"
  require_main_preflight

  note "About to release NookBridge $tag"
  note "  commit: $(git show -s --format='%H %s' "$release_commit")"
  note "  remote: $canonical_remote"
  confirm "Create and push $tag?"

  git tag -a "$tag" "$release_commit" -m "NookBridge $tag" || fail "cannot create tag $tag"
  if ! git push "$canonical_remote" "refs/tags/$tag"; then
    git tag -d "$tag" >/dev/null 2>&1 || true
    fail "pushing $tag failed; the local tag was removed and no release was published"
  fi
  note "Pushed $tag."

  if [ "$watch" = true ]; then
    if ! watch_release_run "$tag" "$release_commit" "release"; then
      fail "the release workflow for $tag did not succeed; inspect the run before retrying"
    fi
    report_candidate "$version"
  fi
}

command_promote() {
  local tag promote_tag tag_commit state missing
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

  note "About to promote $tag"
  note "  candidate commit: $tag_commit"
  note "  remote: $canonical_remote"
  note "  the promotion run re-verifies the published artifact against that commit"
  confirm "Push $promote_tag?"

  git tag -a "$promote_tag" "$tag_commit" -m "Promote NookBridge $tag" \
    || fail "cannot create tag $promote_tag"
  if ! git push "$canonical_remote" "refs/tags/$promote_tag"; then
    git tag -d "$promote_tag" >/dev/null 2>&1 || true
    fail "pushing $promote_tag failed; the local tag was removed"
  fi
  note "Pushed $promote_tag."

  if [ "$watch" = true ]; then
    if ! watch_release_run "$promote_tag" "$tag_commit" "promotion"; then
      fail "the promotion workflow for $tag did not succeed"
    fi
    note "Promoted $tag."
    note "  https://github.com/$mirror_repository/releases/tag/$tag"
  fi
}

parse_args() {
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
      parse_args "$@"
      command_status
      ;;
    tag)
      shift
      parse_args "$@"
      command_tag
      ;;
    promote)
      shift
      parse_args "$@"
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
