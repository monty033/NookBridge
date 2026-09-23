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
# untrusted input, and every destination is resolved once and then used by value:
#
#   * the canonical remote is authenticated by host AND repository path, with no
#     explicit port, for its fetch URL and for every configured push URL, so a
#     lookalike host, a second push destination, or a divergent pushurl cannot
#     receive the tag;
#   * the validated URLs are used for the fetch, the tag lookup, and the push
#     itself, so rewriting the remote configuration after validation cannot
#     redirect an already-approved release;
#   * the Forgejo and GitHub endpoints are derived from that identity instead of
#     being accepted from the environment, and API responses are read with
#     redirects refused;
#   * a remote lookup that cannot be performed is an error, never evidence that
#     the tag is absent;
#   * a push whose outcome cannot be determined is reported as uncertain rather
#     than as "nothing was published";
#   * the release run succeeding is not treated as the candidate existing, and
#     nothing printed in an error path carries credentials or raw remote
#     diagnostics.
#
# Every guard fails closed before anything is pushed. A push that provably did
# not reach the remote deletes the local tag it created, because a public tag is
# immutable: tagging a commit that cannot publish would burn that version
# permanently rather than fail safely.
#
# Test mode. The fixture overrides below are refused unless
# NOOKBRIDGE_RELEASE_TEST_MODE is set, and are then usable only against a local
# filesystem remote. They can never point this command at a network
# destination, and they must never be set for a real release:
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
# The hosting account that serves the canonical repository. A Forgejo deployment
# serves it through the service account its module creates, so an ssh remote
# naming that account is the canonical destination exactly as one naming the
# conventional git account is. A different name is a different destination.
readonly CANONICAL_PRINCIPALS="git forgejo"
# The port the canonical host serves git on. Any other port addresses a service
# other than the canonical one; an ssh URL without one uses the conventional port.
readonly CANONICAL_SSH_PORT="443"
readonly WATCH_INTERVAL="${NOOKBRIDGE_WATCH_INTERVAL:-10}"
readonly WATCH_TIMEOUT="${NOOKBRIDGE_WATCH_TIMEOUT:-1800}"

test_mode=false
if [ -n "${NOOKBRIDGE_RELEASE_TEST_MODE:-}" ] && [ "${NOOKBRIDGE_RELEASE_TEST_MODE:-}" != "0" ]; then
  test_mode=true
fi

# Test mode relaxes the remote identity check. It must not also become a way to
# send real credentials to an endpoint chosen by the environment, so no token is
# used at all while it is on.
usable_token() { # $1 = candidate token
  if [ "$test_mode" = true ]; then
    return 0
  fi
  printf '%s' "$1"
}

api_token=$(usable_token "${NOOKBRIDGE_API_TOKEN:-}")

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

canonical_remote=''
canonical_fetch_url=''
canonical_push_urls=''
repo_root=''
runs_url=''
mirror_api_base=''
mirror_repository=''
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

# Terminal controls must never reach a terminal or a log through a message: a
# rewrite target can carry credentials and an operator's rejected argument can
# carry a newline or an escape sequence. Sanitising at the printer covers every
# message, including the ones added later.
fail() {
  printf 'release: %s\n' "$(strip_controls "$*")" >&2
  exit 1
}

note() {
  printf '%s\n' "$(strip_controls "$*")"
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
      const text = String(value);
      // A version carrying whitespace or a control character is a malformed
      // value, not a version to be trimmed: command substitution would silently
      // remove a trailing newline and the command would tag something other than
      // the literal repository value.
      if (/[\s\u0000-\u001f\u007f]/.test(text)) process.exit(2);
      process.stdout.write(text);
    });
  ' "$1"
}

##########
# Output hygiene
##########

# Anything derived from a remote URL or from git's own diagnostics can carry
# credentials, local paths, or control characters. Drop the userinfo component,
# the query string, and the fragment, then collapse control characters before
# anything reaches a log.
redact() {
  printf '%s' "$1" \
    | sed -e 's#\(://\)[^[:space:]]*@#\1#g' \
      -e 's#[?#][^[:space:]]*##g' \
      -e 's#^[^/[:space:]]*@##' \
      -e 's#[[:cntrl:]]# #g'
}

# Terminal controls can also arrive through repository content (a commit
# subject), which is not a URL and must not be passed through the URL rules.
strip_controls() {
  printf '%s' "$1" | tr -d '[:cntrl:]'
}

# Git diagnostics are untrusted: keep one redacted line and drop the rest.
git_error_text() { # $1 = file holding captured stderr
  local line=''
  if [ -f "$1" ]; then
    line=$(head -n 1 "$1" 2>/dev/null || true)
  fi
  [ -n "$line" ] || line='no diagnostic was produced'
  redact "$line"
}

##########
# Trust boundaries
##########

# Normalize a repository path the way a hosting service spells it: one optional
# trailing slash, one optional `.git` suffix. A path segment that is exactly
# `.git` is a different endpoint, not the same repository spelled differently, so
# it is rejected rather than normalized away.
normalize_repo_path() { # $1 = path; prints the normalized path, fails when malformed
  local path=$1
  # Trim one trailing slash first, so that `NookBridge/.git/` is still visible as
  # a `.git` segment rather than being normalized into the canonical path.
  case "$path" in
    */) path=${path%/} ;;
  esac
  case "$path" in
    */.git|.git) return 1 ;;
  esac
  case "$path" in
    *.git) path=${path%.git} ;;
  esac
  case "$path" in
    */) path=${path%/} ;;
  esac
  printf '%s' "$path"
}

# The account names an instance serves the canonical repository through: the
# conventional git account, and the service account a Forgejo module creates.
# Any other name is a different destination on the same host.
canonical_principal_ok() {
  case " $CANONICAL_PRINCIPALS " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

# Accept a remote URL only when it names the canonical host and repository, the
# account that serves it, and no port other than the one it serves git on. A
# suffix match on the repository path alone would accept an attacker-controlled
# host that mirrors the path, another port selects a different service than the
# one the API identity is derived from, and a principal other than a hosting
# account may select a different destination on the same host.
canonical_url_ok() {
  local url=$1 rest host path authority normalized user=''
  case "$url" in
    https://*)
      rest=${url#https://}
      # HTTPS userinfo is a credential. It would be passed to `git fetch`,
      # `ls-remote`, and `push` as a command argument, where it is readable by any
      # local process, and the canonical remote is addressed anonymously.
      case "${rest%%/*}" in
        *@*) return 1 ;;
      esac
      ;;
    ssh://*)
      rest=${url#ssh://}
      # An ssh URL must name the hosting account explicitly: without a principal,
      # ssh chooses the local user, which may select a different account or
      # destination on the same host.
      case "$rest" in
        *@*) ;;
        *) return 1 ;;
      esac
      user=${rest%%@*}
      canonical_principal_ok "$user" || return 1
      rest=${rest#*@}
      # The authority may name the port this instance serves git on. It is removed
      # here so the shared check below sees a host and a path only; any other port
      # addresses a service other than the canonical one.
      authority=${rest%%/*}
      case "$authority" in
        "$CANONICAL_HOST") ;;
        "$CANONICAL_HOST:$CANONICAL_SSH_PORT") rest="${CANONICAL_HOST}${rest#"$authority"}" ;;
        *) return 1 ;;
      esac
      ;;
    *@*:*)
      # scp-style destination: the principal is mandatory here, so it must be
      # the hosting account.
      user=${url%%@*}
      rest=${url#*@}
      canonical_principal_ok "$user" || return 1
      host=${rest%%:*}
      path=${rest#*:}
      [ "$host" = "$CANONICAL_HOST" ] || return 1
      normalized=$(normalize_repo_path "$path") || return 1
      [ "$normalized" = "$CANONICAL_PATH" ] || return 1
      return 0
      ;;
    *) return 1 ;;
  esac
  # The remaining branches have already consumed any userinfo they accept: a
  # silent strip here is what let an HTTPS credential ride along to `git`.
  host=${rest%%/*}
  path=${rest#*/}
  # A port in the authority means a service other than the canonical one.
  case "$host" in
    "$CANONICAL_HOST") ;;
    *) return 1 ;;
  esac
  normalized=$(normalize_repo_path "$path") || return 1
  [ "$normalized" = "$CANONICAL_PATH" ] || return 1
  return 0
}

# A filesystem path is never a canonical release target. A scp-style URL such as
# `host:path` carries a colon before any slash, so it is a network destination
# and not a path, whether or not it names a user.
local_path_url() {
  local value=$1 head
  case "$value" in
    *://*) return 1 ;;
  esac
  head=${value%%/*}
  case "$head" in
    *:*) return 1 ;;
  esac
  case "$value" in
    /*|./*|../*) return 0 ;;
  esac
  # A bare `~` cannot be written as a case pattern: bash tilde-expands patterns,
  # so `~/*` would silently become the literal home directory.
  if [ "$head" = '~' ]; then
    return 0
  fi
  return 1
}

remote_url_ok() {
  if [ "$test_mode" = true ]; then
    # Test mode relaxes identity only for a local filesystem remote.
    local_path_url "$1"
    return $?
  fi
  canonical_url_ok "$1"
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

# Sets canonical_remote, canonical_fetch_url, and canonical_push_urls. Called
# directly rather than in a command substitution, because a guard that fails
# inside a subshell could not stop the caller.
resolve_canonical_remote() {
  local name='' candidate fetch_url push_url
  if [ -n "${NOOKBRIDGE_CANONICAL_REMOTE:-}" ]; then
    name=$NOOKBRIDGE_CANONICAL_REMOTE
    git remote get-url "$name" >/dev/null 2>&1 \
      || fail "the configured canonical remote does not exist: $name"
  else
    while IFS= read -r candidate; do
      [ -n "$candidate" ] || continue
      fetch_url=$(git remote get-url "$candidate" 2>/dev/null || true)
      [ -n "$fetch_url" ] || continue
      push_url=$(git remote get-url --push "$candidate" 2>/dev/null || true)
      [ -n "$push_url" ] || push_url=$fetch_url
      if remote_url_ok "$fetch_url" && remote_url_ok "$push_url"; then
        name=$candidate
        break
      fi
    done < <(git remote)
    [ -n "$name" ] \
      || fail "no remote fetches from and pushes to $CANONICAL_HOST/$CANONICAL_PATH; add one, or set NOOKBRIDGE_RELEASE_TEST_MODE with NOOKBRIDGE_CANONICAL_REMOTE for fixture work"
  fi
  canonical_remote=$name
  resolve_remote_urls "$name"
}

# Every rewrite rule that could apply to a URL must produce a URL that still names
# the canonical repository, including after a chain of rules. Git applies a rule the
# command cannot always predict — it prefers the longest matching prefix, and
# `pushInsteadOf` over `insteadOf` for a push — so the conservative rule is that no
# applicable rule may produce a noncanonical destination at all.
check_rewrite_targets() { # $1 = url, $2 = description, $3 = depth
  local url=$1 description=$2 depth=$3 line key base prefix expanded
  [ "$depth" -lt 4 ] || fail "the Git URL rewrite rules for $description form a chain that does not settle; refusing"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    key=${line%%[[:space:]]*}
    prefix=${line#*[[:space:]]}
    [ -n "$prefix" ] || continue
    case "$url" in
      "$prefix"*) ;;
      *) continue ;;
    esac
    base=${key#url.}
    base=${base%.insteadof}
    base=${base%.pushinsteadof}
    expanded="${base}${url#"$prefix"}"
    remote_url_ok "$expanded" \
      || fail "a Git URL rewrite rule would turn $description into '$(redact "$expanded")', which is not the canonical repository; refusing"
    if [ "$expanded" != "$url" ]; then
      check_rewrite_targets "$expanded" "$description" "$((depth + 1))"
    fi
  done < <(git config --get-regexp '^url\..*\.(insteadof|pushinsteadof)$' 2>/dev/null || true)
}

# A URL rewrite rule (`insteadOf`/`pushInsteadOf`) makes git expand a reported URL
# and expand it again when that URL is used, so a rule can send the fetch or the
# push somewhere other than the value that was validated. Every configured URL, in
# every configuration scope, must equal the URL git reports for it, and no rule may
# turn it into anything but the canonical repository. This is re-checked immediately
# before the network operations, because the rules can be edited while the command
# waits for confirmation.
check_url_rewrites() { # $1 = remote name
  local name=$1 url raw_url index
  local -a raw_push_list=()
  local -a expanded_push_list=()
  raw_url=$(git config --get-all "remote.$name.url" 2>/dev/null | head -n 1 || true)
  [ -n "$raw_url" ] || fail "remote $name has no configured fetch URL"
  [ "$raw_url" = "$(git remote get-url "$name" 2>/dev/null || true)" ] \
    || fail "a Git URL rewrite rule changes the fetch destination of remote $name; refusing to fetch or push to a URL that differs from its configured value"
  check_rewrite_targets "$raw_url" "the fetch destination of remote $name" 0
  while IFS= read -r url; do
    if [ -n "$url" ]; then raw_push_list+=("$url"); fi
  done < <(git config --get-all "remote.$name.pushurl" 2>/dev/null || true)
  while IFS= read -r url; do
    if [ -n "$url" ]; then expanded_push_list+=("$url"); fi
  done < <(git remote get-url --all --push "$name" 2>/dev/null || true)
  if [ "${#raw_push_list[@]}" -eq 0 ]; then
    [ "${#expanded_push_list[@]}" -eq 1 ] && [ "${expanded_push_list[0]}" = "$raw_url" ] \
      || fail "a Git URL rewrite rule changes the push destination of remote $name; refusing"
    check_rewrite_targets "$raw_url" "the push destination of remote $name" 0
    return 0
  fi
  # Every configured push destination is compared, not just the first one: git
  # pushes to all of them.
  [ "${#raw_push_list[@]}" -eq "${#expanded_push_list[@]}" ] \
    || fail "the push destinations of remote $name do not match their configured values; refusing"
  for index in "${!raw_push_list[@]}"; do
    [ "${raw_push_list[$index]}" = "${expanded_push_list[$index]}" ] \
      || fail "a Git URL rewrite rule changes the push destination of remote $name; refusing"
  done
  for index in "${!raw_push_list[@]}"; do
    check_rewrite_targets "${raw_push_list[$index]}" "a push destination of remote $name" 0
  done
}

# Validate the fetch URL and every configured push URL of the chosen remote, and
# keep them by value so that nothing later re-reads mutable configuration.
resolve_remote_urls() { # $1 = remote name
  local name=$1 url
  canonical_fetch_url=$(git remote get-url "$name" 2>/dev/null || true)
  [ -n "$canonical_fetch_url" ] || fail "remote $name has no fetch URL"
  remote_url_ok "$canonical_fetch_url" \
    || fail "remote $name does not fetch from $CANONICAL_HOST/$CANONICAL_PATH: $(redact "$canonical_fetch_url")"
  canonical_push_urls=''
  while IFS= read -r url; do
    [ -n "$url" ] || continue
    remote_url_ok "$url" \
      || fail "remote $name does not push to $CANONICAL_HOST/$CANONICAL_PATH: $(redact "$url")"
    canonical_push_urls="${canonical_push_urls}${url}"$'\n'
  done < <(git config --get-all "remote.$name.pushurl" 2>/dev/null || true)
  if [ -z "$canonical_push_urls" ]; then
    canonical_push_urls="${canonical_fetch_url}"$'\n'
  fi
  # Rewrite rules are checked after the configured URLs themselves, so that a
  # merely noncanonical destination is reported as such rather than as a rewrite.
  check_url_rewrites "$name"
}

# The API root only. Callers append `/repos/<owner>/<name>/...`, so that a caller
# cannot build `/repos/<owner>/<name>/repos/<owner>/<name>/...` by appending a
# repository-scoped path to a base that already names the repository.
forgejo_api_base() {
  if [ "$test_mode" = true ] && [ -n "${NOOKBRIDGE_FORGEJO_API_BASE:-}" ]; then
    printf '%s' "$NOOKBRIDGE_FORGEJO_API_BASE"
    return 0
  fi
  printf '%s' "https://$CANONICAL_HOST/api/v1"
}

forgejo_runs_url() {
  printf '%s/repos/%s/actions/runs' "$(forgejo_api_base)" "$CANONICAL_PATH"
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
  RUNS_TOKEN="$api_token" \
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
  GITHUB_READ_TOKEN="$(usable_token "${NOOKBRIDGE_GITHUB_READ_TOKEN:-}")" \
    node "$script_dir/release-api.mjs" release-state
}

canonical_tag_ref() { # $1 = tag; prints exists= and sha= from the host's record
  FORGEJO_API_BASE="$(forgejo_api_base)" \
  FORGEJO_REPOSITORY="$CANONICAL_PATH" \
  RELEASE_TAG="$1" \
  RUNS_TOKEN="$api_token" \
    node "$script_dir/release-api.mjs" tag-ref
}

# A push is not evidence that the tag arrived where it was meant to go: a rewrite
# rule can redirect a push even when the destination is given as an explicit URL,
# and such a rule can be added after the last pre-push check. The host's own record
# of the ref is therefore read back through the API, which local git configuration
# cannot redirect, and compared with the object that was pushed.
verify_pushed_tag() { # $1 = tag, $2 = released commit
  local tag=$1 commit=$2 output exists sha local_tag
  output=$(canonical_tag_ref "$tag") \
    || fail "pushed $tag but the canonical tag could not be read back through the host API; confirm $tag on $canonical_remote before treating the release as started"
  exists=$(field_of "$output" exists)
  sha=$(field_of "$output" sha)
  [ "$exists" = true ] \
    || fail "the push reported success but the canonical repository does not have $tag; the tag was not published where it was intended, so do not treat the release as started"
  local_tag=$(git rev-parse "refs/tags/$tag") \
    || fail "cannot resolve the local tag $tag"
  # The host reports the tag object for an annotated tag and the commit for a
  # lightweight one, and both are the object that was pushed.
  case "$sha" in
    "$local_tag"|"$commit") return 0 ;;
  esac
  fail "the canonical $tag resolves to ${sha:-an unreadable object}, not to the object that was pushed; do not treat the release as started"
}

# Print "absent" or "present <sha>" for a canonical tag. A lookup that cannot be
# performed is an error: reporting it as absence is how a fail-closed guard
# quietly becomes fail-open.
tag_state_of() { # $1 = tag
  local output
  output=$(git ls-remote --tags "$canonical_fetch_url" "refs/tags/$1" 2>"$work_dir/tag-lookup-error.txt") \
    || return 1
  if [ -z "$output" ]; then
    printf 'absent'
  else
    printf 'present %s' "$(printf '%s' "${output%%$'\t'*}" | tr -d '[:cntrl:]')"
  fi
}

local_tag_exists() {
  git rev-parse --verify --quiet "refs/tags/$1" >/dev/null 2>&1
}

canonical_tag_commit() { # commit a canonical tag points at; empty when absent
  local state commit
  if ! state=$(tag_state_of "$1"); then
    fail "cannot check tag $1 on $canonical_remote: $(git_error_text "$work_dir/tag-lookup-error.txt")"
  fi
  case "$state" in
    absent) return 0 ;;
    present\ *) commit=${state#present } ;;
    *) fail "unexpected tag state for $1" ;;
  esac
  # ls-remote reports the tag object for an annotated tag, so fetch the ref and
  # peel it locally. The explicit refspec stores it in FETCH_HEAD without
  # creating a local tag.
  git fetch --quiet --no-tags "$canonical_fetch_url" "refs/tags/$1" 2>"$work_dir/fetch-tag-error.txt" \
    || fail "cannot fetch tag $1 from $canonical_remote: $(git_error_text "$work_dir/fetch-tag-error.txt")"
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

# The release is documented as carrying exactly the expected assets, so an extra
# one is a finding rather than noise: it means the release was written by something
# other than this workflow, and the promotion gate must not bless it.
unexpected_assets() { # $1 = release state text, $2 = version
  local name expected
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    expected=false
    while IFS= read -r candidate; do
      if [ "$candidate" = "$name" ]; then expected=true; fi
    done < <(expected_asset_names "$2")
    [ "$expected" = true ] || printf '%s\n' "$name"
  done < <(printf '%s\n' "$1" | sed -n 's/^asset=//p')
}

##########
# Guards
##########

# The release policy has exactly one implementation: `check-release-version.sh`,
# which the publishing workflow runs too. It used to be duplicated here, and two
# copies of the rule drift — a version the operator accepts and the workflow
# rejects consumes an immutable tag before the release fails.
valid_version() {
  local version=$1
  [ -n "$version" ] || return 1
  bash "$script_dir/check-release-version.sh" "$version"
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
  if [ "$test_mode" = true ]; then
    note "test_mode=true (fixture overrides are active and only a local remote is accepted; never use this for a real release)"
  fi
  resolve_canonical_remote
  runs_url=$(forgejo_runs_url)
  mirror_api_base=$(resolve_mirror_api_base)
  mirror_repository=$(resolve_mirror_repository)
  # Re-check immediately before the fetch: the rewrite rules can be edited while
  # the command is running.
  check_url_rewrites "$canonical_remote"
  git fetch --quiet --no-tags "$canonical_fetch_url" "$RELEASE_BRANCH" 2>"$work_dir/fetch-error.txt" \
    || fail "cannot fetch $RELEASE_BRANCH from $canonical_remote: $(git_error_text "$work_dir/fetch-error.txt")"
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
    fail "cannot check tag $1 on $canonical_remote: $(git_error_text "$work_dir/tag-lookup-error.txt")"
  fi
  case "$state" in
    absent) return 0 ;;
  esac
  fail "canonical tag $1 already exists; a released version is never re-pointed"
}

require_main_preflight() { # $1 = commit; the gate is always the release branch
  collect_run "$RELEASE_BRANCH" "$1" success
  case $run_code in
    0)
      # A query that produced no data must not read as a successful preflight.
      [ -n "$run_output" ] \
        || fail "the Forgejo run query returned no data; refusing to treat it as a successful preflight"
      return 0
      ;;
    2)
      fail "no successful $RELEASE_BRANCH runner preflight for $1; wait for it before tagging"
      ;;
    *)
      fail "cannot read Forgejo run state: $(git_error_text "$work_dir/run-error.txt")"
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

# A push that reports failure may still have updated the remote, so report what
# is true instead of asserting that nothing happened. The push destinations were
# captured by value during validation, so rewriting the remote configuration
# after validation cannot redirect the tag.
publish_tag() { # $1 = tag, $2 = commit, $3 = message
  local tag=$1 commit=$2 message=$3 state url failed=false
  # The last check before the network write: a rewrite rule added while the
  # command waited at the confirmation prompt must not redirect the tag.
  check_url_rewrites "$canonical_remote"
  git tag -a "$tag" "$commit" -m "$message" || fail "cannot create tag $tag"
  while IFS= read -r url; do
    [ -n "$url" ] || continue
    if ! git push --quiet "$url" "refs/tags/$tag" 2>"$work_dir/push-error.txt"; then
      failed=true
    fi
  done <<< "$canonical_push_urls"
  if [ "$failed" = false ]; then
    # A push that reported success is verified against the host's own record: the
    # destination can have been rewritten by local configuration, and a redirect
    # produces a successful push that left the canonical repository untouched.
    verify_pushed_tag "$tag" "$commit"
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
  # An empty lookup is not proof that nothing was published: a server can accept
  # the ref and then lose the connection, and fetch and push can observe
  # different replicas. The local tag is kept so the version cannot be silently
  # re-tagged; the operator decides, having checked.
  fail "pushing $tag failed and $canonical_remote does not report the tag; confirm whether $tag exists on the remote, then delete the local tag with 'git tag -d $tag' if it does not"
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
          note "Run: $(redact "$url")"
          announced=true
        fi
        case "$status" in
          success|failure|cancelled|error|skipped)
            note "Result: $status"
            if [ "$status" = success ]; then
              return 0
            fi
            return 1
            ;;
          '')
            fail "the run state could not be read; do not treat the release as complete"
            ;;
        esac
        ;;
      2) ;;
      *)
        fail "cannot read Forgejo run state: $(git_error_text "$work_dir/run-error.txt")"
        ;;
    esac
    if [ "$SECONDS" -ge "$deadline" ]; then
      fail "timed out after ${WATCH_TIMEOUT}s waiting for the $3 run"
    fi
    sleep "$WATCH_INTERVAL"
  done
}

# The workflow succeeding is not the same as the candidate existing. A candidate
# that cannot be verified exits non-zero, so automation cannot read an unverified
# release as success.
report_candidate() { # $1 = version
  local tag="v$1" state missing target
  if ! state=$(github_release_state "$tag"); then
    fail "the release run succeeded but the mirror release state could not be read; verify $tag before announcing it"
  fi
  if [ "$(field_of "$state" exists)" != true ]; then
    fail "the release run succeeded but the mirror has no release for $tag yet; verify it before announcing it"
  fi
  # The release must still be the candidate this run produced: a published
  # release, a draft, or one pointing at another commit, is not evidence that
  # this release succeeded.
  if [ "$(field_of "$state" draft)" = true ]; then
    fail "the mirror release for $tag is still a draft, so users cannot install from it; publish it or re-run the release"
  fi
  if [ "$(field_of "$state" prerelease)" != true ]; then
    fail "the mirror release for $tag is not a prerelease candidate; verify it before announcing it"
  fi
  target=$(field_of "$state" target_commitish)
  if [ "$target" != "$release_commit" ]; then
    fail "the mirror release for $tag targets ${target:-no commit} but this run built $release_commit; verify it before announcing it"
  fi
  missing=$(missing_assets "$state" "$1")
  if [ -n "$missing" ]; then
    note "Release $tag is missing assets:"
    printf '%s\n' "$missing"
    fail "the candidate release for $tag is incomplete"
  fi
  extra=$(unexpected_assets "$state" "$1")
  if [ -n "$extra" ]; then
    note "Release $tag carries unexpected assets:"
    printf '%s\n' "$extra"
    fail "the candidate release for $tag was not written by this release process"
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
  local problems state preflight='missing' release_tag_state promote_tag_state
  local local_tag_state local_promote_tag_state
  local mirror_state='unknown'
  resolve_release_target
  version=${requested_version:-$(canonical_version)}
  valid_version "$version" || fail "invalid version: $version"

  note "version=$version"
  note "canonical_remote=$canonical_remote"
  note "canonical_commit=$release_commit"
  note "canonical_subject=$(strip_controls "$(git show -s --format=%s "$release_commit")")"

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
    || fail "cannot check tag v$version on $canonical_remote: $(git_error_text "$work_dir/tag-lookup-error.txt")"
  promote_tag_state=$(tag_state_of "promote-v$version") \
    || fail "cannot check tag promote-v$version on $canonical_remote: $(git_error_text "$work_dir/tag-lookup-error.txt")"
  case "$release_tag_state" in
    absent) note "tag_v$version=absent" ;;
    *) note "tag_v$version=present" ;;
  esac
  case "$promote_tag_state" in
    absent) note "tag_promote-v$version=absent" ;;
    *) note "tag_promote-v$version=present" ;;
  esac

  # A local tag is not a published release, but it does block this working copy from
  # releasing: reporting readiness that the release command then refuses would send
  # the operator to the remote to look for a tag that is only here.
  if local_tag_exists "v$version"; then
    local_tag_state=present
  else
    local_tag_state=absent
  fi
  if local_tag_exists "promote-v$version"; then
    local_promote_tag_state=present
  else
    local_promote_tag_state=absent
  fi
  note "local_tag_v$version=$local_tag_state"
  note "local_tag_promote-v$version=$local_promote_tag_state"

  collect_run "$RELEASE_BRANCH" "$release_commit" ''
  if [ $run_code -eq 0 ]; then
    preflight=$(field_of "$run_output" status)
    note "main_preflight=$preflight"
    note "main_preflight_url=$(redact "$(field_of "$run_output" url)")"
  elif [ $run_code -eq 2 ]; then
    note "main_preflight=missing"
  else
    preflight=unknown
    note "main_preflight=unknown"
  fi

  if state=$(github_release_state "v$version"); then
    if [ "$(field_of "$state" exists)" != true ]; then
      mirror_state=absent
    elif [ "$(field_of "$state" draft)" = true ]; then
      # A draft is not a candidate and not published: users cannot install from it,
      # and the promotion ref would fail against it.
      mirror_state=candidate-draft
    elif [ "$(field_of "$state" prerelease)" = true ]; then
      mirror_state=candidate-prerelease
    else
      mirror_state=published
    fi
    note "mirror_release=$mirror_state"
    if [ "$mirror_state" = candidate-prerelease ]; then
      note "mirror_assets=$(printf '%s\n' "$state" | grep -c '^asset=' || true)"
    fi
  else
    mirror_state=unreachable
    note "mirror_release=unreachable"
  fi

  # Ready to release means every gate is clear *and* nothing has been published or
  # reserved for this version yet: an existing mirror release, promotion tag, or even
  # a local tag means the release command would refuse after the operator had already
  # been told the version was ready.
  if [ -z "$problems" ] && [ "$preflight" = success ] && [ "$release_tag_state" = absent ] \
    && [ "$promote_tag_state" = absent ] && [ "$mirror_state" = absent ] \
    && [ "$local_tag_state" = absent ] && [ "$local_promote_tag_state" = absent ]; then
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
  note "  commit: $(strip_controls "$(git show -s --format='%H %s' "$release_commit")")"
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

  if ! state=$(github_release_state "$tag"); then
    fail "cannot read the mirror release state for $tag"
  fi
  [ "$(field_of "$state" exists)" = true ] || fail "the mirror has no release for $tag"
  # A draft is not a candidate: users cannot install from it, and promoting it would
  # announce a release that is not reachable.
  [ "$(field_of "$state" draft)" != true ] \
    || fail "$tag is still a draft on the mirror, so users cannot install from it; publish it or re-run the release"
  [ "$(field_of "$state" prerelease)" = true ] \
    || fail "$tag is not a prerelease candidate; it may already be promoted"
  missing=$(missing_assets "$state" "$version")
  [ -z "$missing" ] \
    || fail "$tag is missing release assets: $(printf '%s' "$missing" | tr '\n' ' ')"
  extra=$(unexpected_assets "$state" "$version")
  [ -z "$extra" ] \
    || fail "$tag carries unexpected release assets: $(printf '%s' "$extra" | tr '\n' ' ')"

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
