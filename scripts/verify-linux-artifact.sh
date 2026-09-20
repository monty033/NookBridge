#!/usr/bin/env bash

# Verify a NookBridge linux-x64-gnu release artifact without Nix, npm, or Node.
# The verifier is deliberately silent about input paths, archive members, and
# manifest values. Callers receive only a categorical result.

set -euo pipefail
umask 077

readonly OK_LINE="nookbridge-artifact verification ok"
readonly FAILURE_LINE="nookbridge-artifact verification failed"

fail() {
  printf '%s\n' "$FAILURE_LINE" >&2
  exit 1
}

artifact=''
checksum_file=''
expect_git_commit=''

while (($# > 0)); do
  case "$1" in
    --artifact)
      (($# >= 2)) || fail
      artifact=$2
      shift 2
      ;;
    --checksum-file)
      (($# >= 2)) || fail
      checksum_file=$2
      shift 2
      ;;
    --expect-git-commit)
      (($# >= 2)) || fail
      expect_git_commit=$2
      shift 2
      ;;
    --help)
      printf '%s\n' 'verify-linux-artifact.sh --artifact PATH --checksum-file PATH [--expect-git-commit SHA]'
      exit 0
      ;;
    *)
      fail
      ;;
  esac
done

[[ -n "$artifact" && -n "$checksum_file" ]] || fail
[[ -z "$expect_git_commit" || "$expect_git_commit" =~ ^[0-9a-f]{40,64}$ ]] || fail
[[ -f "$artifact" && ! -L "$artifact" ]] || fail
[[ -f "$checksum_file" && ! -L "$checksum_file" ]] || fail
[[ "${artifact##*/}" == nookbridge-v*.tar.gz ]] || fail

command -v sha256sum >/dev/null 2>&1 || fail
command -v tar >/dev/null 2>&1 || fail
command -v grep >/dev/null 2>&1 || fail
command -v awk >/dev/null 2>&1 || fail
command -v sed >/dev/null 2>&1 || fail
command -v mktemp >/dev/null 2>&1 || fail

checksum_name=${artifact##*/}
checksum_line=$(awk -v name="$checksum_name" '
  $2 == name { if (++count > 1) exit 2; line = $0 }
  END { if (count != 1) exit 3; print line }
' "$checksum_file" 2>/dev/null) || fail
expected_checksum=${checksum_line%%[[:space:]]*}
[[ "$expected_checksum" =~ ^[0-9a-fA-F]{64}$ ]] || fail
actual_checksum=$(sha256sum "$artifact" 2>/dev/null | cut -d ' ' -f1) || fail
[[ "${actual_checksum,,}" == "${expected_checksum,,}" ]] || fail

members=$(tar -tzf "$artifact" 2>/dev/null) || fail
[[ -n "$members" ]] || fail

first_member=${members%%$'\n'*}
top_level=${first_member%/}
[[ "$top_level" =~ ^nookbridge-v[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$ ]] || fail

while IFS= read -r member; do
  [[ -n "$member" ]] || fail
  [[ "$member" != *$'\r'* && "$member" != *$'\t'* ]] || fail
  case "$member" in
    /*|./*|../*|*/../*|*/..|*/./*|*\\*) fail ;;
  esac
  case "$member" in
    "$top_level"|"$top_level"/*) ;;
    *) fail ;;
  esac
done <<< "$members"

while IFS= read -r listing; do
  [[ -n "$listing" ]] || continue
  case "${listing:0:1}" in
    -|d) ;;
    *) fail ;;
  esac
done < <(tar -tvzf "$artifact" 2>/dev/null) || fail

required_members=(
  "$top_level/release.json"
  "$top_level/SHA256SUMS"
  "$top_level/bin/nookd"
  "$top_level/bin/nookctl"
  "$top_level/bin/nook-mcp"
  "$top_level/bin/nookbridge-health"
  "$top_level/bin/nookbridge-runtime-check"
  "$top_level/runtime/bin/node"
  "$top_level/app/package.json"
)
for required in "${required_members[@]}"; do
  grep -Fqx "$required" <<< "$members" 2>/dev/null || fail
done

# The operator socket resolves peer credentials by spawning
# <app>/operator-peercred-helper.  A release without it ships an install whose
# operator CLI surface fails closed, so verification must reject it.
grep -Fqx "$top_level/app/operator-peercred-helper" <<< "$members" 2>/dev/null || fail

grep -Fq "$top_level/app/dist/" <<< "$members" 2>/dev/null || fail
grep -Fq "$top_level/app/node_modules/" <<< "$members" 2>/dev/null || fail
grep -Fq "$top_level/licenses/" <<< "$members" 2>/dev/null || fail

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

manifest="$work_dir/release.json"
tar -xOzf "$artifact" "$top_level/release.json" > "$manifest" 2>/dev/null || fail
inventory="$work_dir/SHA256SUMS"
tar -xOzf "$artifact" "$top_level/SHA256SUMS" > "$inventory" 2>/dev/null || fail

unique_key() {
  local key=$1
  local count
  count=$(grep -E -c "^  \"${key}\"[[:space:]]*:" "$manifest" 2>/dev/null || true)
  [[ "$count" == 1 ]] || fail
}

json_value() {
  local key=$1
  local line
  line=$(grep -E "^  \"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$manifest" 2>/dev/null || true)
  [[ -n "$line" ]] || fail
  printf '%s\n' "$line" | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/'
}

for key in version gitCommit minGlibc minLibstdcxx packageLockSha256 payloadInventorySha256 stateCompatibility buildTimestamp; do
  unique_key "$key"
done
for key in artifactFormat dirtyTree target node; do
  unique_key "$key"
done

version=$(json_value version)
git_commit=$(json_value gitCommit)
min_glibc=$(json_value minGlibc)
min_libstdcxx=$(json_value minLibstdcxx)
lock_digest=$(json_value packageLockSha256)
payload_digest=$(json_value payloadInventorySha256)
state_compatibility=$(json_value stateCompatibility)
build_timestamp=$(json_value buildTimestamp)

[[ "$version" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$ ]] || fail
[[ "$top_level" == "nookbridge-v$version" ]] || fail
[[ "$git_commit" =~ ^[0-9a-f]{40,64}$ ]] || fail
# Source SHA association: the caller names the commit being released, and the
# artifact must record exactly that commit.  Format alone proves nothing.
[[ -z "$expect_git_commit" || "${git_commit,,}" == "${expect_git_commit,,}" ]] || fail
[[ "$min_glibc" =~ ^[0-9]+\.[0-9]+$ ]] || fail
[[ "$min_libstdcxx" =~ ^GLIBCXX_[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || fail
[[ "$lock_digest" =~ ^[0-9a-f]{64}$ ]] || fail
[[ "$payload_digest" =~ ^[0-9a-f]{64}$ ]] || fail
[[ "$state_compatibility" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$ ]] || fail
[[ "$build_timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^[:space:]]+Z$ ]] || fail
inventory_digest=$(sha256sum "$inventory" 2>/dev/null | cut -d ' ' -f1) || fail
[[ "$inventory_digest" == "$payload_digest" ]] || fail

grep -Eq '"artifactFormat"[[:space:]]*:[[:space:]]*1([,[:space:]]|$)' "$manifest" 2>/dev/null || fail
grep -Eq '"dirtyTree"[[:space:]]*:[[:space:]]*false([,[:space:]]|$)' "$manifest" 2>/dev/null || fail
grep -Eq '"os"[[:space:]]*:[[:space:]]*"linux"' "$manifest" 2>/dev/null || fail
grep -Eq '"arch"[[:space:]]*:[[:space:]]*"x86_64"' "$manifest" 2>/dev/null || fail
grep -Eq '"libc"[[:space:]]*:[[:space:]]*"glibc"' "$manifest" 2>/dev/null || fail
grep -Eq '"version"[[:space:]]*:[[:space:]]*"22\.23\.2"' "$manifest" 2>/dev/null || fail
grep -Eq '"abi"[[:space:]]*:[[:space:]]*"node-v[0-9]+"' "$manifest" 2>/dev/null || fail

tar -xzf "$artifact" -C "$work_dir" 2>/dev/null || fail
payload_root="$work_dir/$top_level"
[[ -d "$payload_root" ]] || fail
if grep -R -a -E -q '/nix/store/[[:alnum:]]|(^|[[:space:]])/build/|/tmp/nookbridge/' "$payload_root" 2>/dev/null; then
  fail
fi

peercred_helper="$payload_root/app/operator-peercred-helper"
[[ -f "$peercred_helper" && ! -L "$peercred_helper" && -x "$peercred_helper" ]] || fail

printf '%s\n' "$OK_LINE"
