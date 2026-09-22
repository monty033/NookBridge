#!/usr/bin/env bash

# Assemble a reviewed linux-x64-gnu NookBridge release artifact.
# Dependency installation and native compilation belong in the controlled build
# container; this script only packages an already-built, clean source tree.

set -euo pipefail
umask 077

readonly OK_LINE="nookbridge-artifact build ok"
readonly FAILURE_LINE="nookbridge-artifact build failed"

fail() {
  printf '%s\n' "$FAILURE_LINE" >&2
  exit 1
}

source_dir=''
build_node=''
runtime_tarball=''
legacy_node_runtime=''
legacy_node_runtime_exec=''
output_dir=''
version=''
source_epoch=''
min_glibc=''
min_libstdcxx=''
operator_peercred_helper=''

while (($# > 0)); do
  case "$1" in
    --source-dir)
      (($# >= 2)) || fail
      source_dir=$2
      shift 2
      ;;
    --build-node)
      (($# >= 2)) || fail
      build_node=$2
      shift 2
      ;;
    --runtime-tarball)
      (($# >= 2)) || fail
      runtime_tarball=$2
      shift 2
      ;;
    --node-runtime)
      (($# >= 2)) || fail
      legacy_node_runtime=$2
      shift 2
      ;;
    --node-runtime-exec)
      (($# >= 2)) || fail
      legacy_node_runtime_exec=$2
      shift 2
      ;;
    --output-dir)
      (($# >= 2)) || fail
      output_dir=$2
      shift 2
      ;;
    --version)
      (($# >= 2)) || fail
      version=$2
      shift 2
      ;;
    --source-date-epoch)
      (($# >= 2)) || fail
      source_epoch=$2
      shift 2
      ;;
    --min-glibc)
      (($# >= 2)) || fail
      min_glibc=$2
      shift 2
      ;;
    --min-libstdcxx)
      (($# >= 2)) || fail
      min_libstdcxx=$2
      shift 2
      ;;
    --operator-peercred-helper)
      (($# >= 2)) || fail
      operator_peercred_helper=$2
      shift 2
      ;;
    --help)
      printf '%s\n' 'build-linux-artifact.sh --source-dir PATH --build-node PATH --runtime-tarball PATH --output-dir PATH --version VERSION --source-date-epoch EPOCH --min-glibc VERSION --min-libstdcxx SYMBOL --operator-peercred-helper PATH'
      exit 0
      ;;
    *)
      fail
      ;;
  esac
done

if [[ -z "$build_node" && -n "$legacy_node_runtime_exec" ]]; then
  build_node=$legacy_node_runtime_exec
fi
if [[ -z "$build_node" && -z "$runtime_tarball" && -n "$legacy_node_runtime" ]]; then
  build_node=$legacy_node_runtime
fi
[[ -n "$source_dir" && -n "$build_node" && -n "$output_dir" ]] || fail
[[ -n "$version" && -n "$source_epoch" && -n "$min_glibc" && -n "$min_libstdcxx" ]] || fail
[[ -n "$operator_peercred_helper" ]] || fail
[[ -n "$runtime_tarball" || -n "$legacy_node_runtime" ]] || fail
[[ "$version" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$ ]] || fail
[[ "$source_epoch" =~ ^[0-9]+$ ]] || fail
[[ "$min_glibc" =~ ^[0-9]+\.[0-9]+$ ]] || fail
[[ "$min_libstdcxx" =~ ^GLIBCXX_[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || fail

[[ "$(uname -s 2>/dev/null)" == Linux ]] || fail
[[ "$(uname -m 2>/dev/null)" == x86_64 ]] || fail
[[ -d "$source_dir" && ! -L "$source_dir" ]] || fail
build_node_real=$(readlink -f "$build_node" 2>/dev/null) || fail
[[ -f "$build_node_real" && ! -L "$build_node_real" && -x "$build_node_real" ]] || fail
if [[ -n "$runtime_tarball" ]]; then
  [[ -f "$runtime_tarball" && ! -L "$runtime_tarball" ]] || fail
  runtime_extract_dir=$(mktemp -d)
  runtime_node="$runtime_extract_dir/node"
  tar -xOf "$runtime_tarball" 'node-v22.23.2-linux-x64/bin/node' > "$runtime_node" 2>/dev/null || fail
  chmod 0555 "$runtime_node"
else
  runtime_node=$legacy_node_runtime
fi
node_runtime_real=$(readlink -f "$runtime_node" 2>/dev/null) || fail
[[ -f "$node_runtime_real" && ! -L "$node_runtime_real" && -x "$node_runtime_real" ]] || fail

# The operator socket resolves peer credentials by spawning a packaged native
# helper at <app>/operator-peercred-helper (see defaultPeerCredentialHelperPath).
# The Nix package builds this helper; the portable artifact must carry the same
# binary or the operator CLI surface fails closed on portable installs while
# working under Nix.  Refuse to emit an artifact without it.
[[ -f "$operator_peercred_helper" && ! -L "$operator_peercred_helper" && -x "$operator_peercred_helper" ]] || fail

for command_name in cp date find git gzip mktemp readlink sha256sum sort tar; do
  command -v "$command_name" >/dev/null 2>&1 || fail
done

is_clean=$(git -C "$source_dir" status --porcelain=v1 --untracked-files=all 2>/dev/null) || fail
[[ -z "$is_clean" ]] || fail
git_commit=$(git -C "$source_dir" rev-parse --verify HEAD 2>/dev/null) || fail
[[ "$git_commit" =~ ^[0-9a-f]{40,64}$ ]] || fail

node_version=$($build_node_real --version 2>/dev/null) || fail
[[ "$node_version" == v22.23.2 ]] || fail
node_abi=$($build_node_real -p 'process.versions.modules' 2>/dev/null) || fail
[[ "$node_abi" =~ ^[0-9]+$ ]] || fail

required_paths=(
  "$source_dir/dist/nookd.js"
  "$source_dir/dist/cli.js"
  "$source_dir/dist/mcp/cli.js"
  "$source_dir/dist/provision.js"
  "$source_dir/dist/sync.js"
  "$source_dir/dist/health.js"
  "$source_dir/dist/runtime-check.js"
  "$source_dir/node_modules"
  "$source_dir/package.json"
  "$source_dir/package-lock.json"
  "$source_dir/LICENSE"
)
for required_path in "${required_paths[@]}"; do
  [[ -e "$required_path" && ! -L "$required_path" ]] || fail
done

while IFS= read -r link_path; do
  [[ -z "$link_path" ]] || fail
done < <(find "$source_dir/dist" -type l -print 2>/dev/null)
while IFS= read -r link_path; do
  [[ -z "$link_path" ]] && continue
  resolved_link=$(readlink -f "$link_path" 2>/dev/null) || fail
  case "$resolved_link" in
    "$source_dir/node_modules"/*) ;;
    *) fail ;;
  esac
done < <(find "$source_dir/node_modules" -type l -print 2>/dev/null)

package_lock_digest=$(sha256sum "$source_dir/package-lock.json" 2>/dev/null | cut -d ' ' -f1) || fail
[[ "$package_lock_digest" =~ ^[0-9a-f]{64}$ ]] || fail
build_timestamp=$(date -u -d "@$source_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || fail
release_root_name="nookbridge-v$version"

stage_dir=$(mktemp -d)
trap 'rm -rf "$stage_dir" "${runtime_extract_dir:-}"' EXIT
release_root="$stage_dir/$release_root_name"
mkdir -p "$release_root/app" "$release_root/bin" "$release_root/runtime/bin" "$release_root/licenses"

cp -a "$source_dir/dist" "$release_root/app/dist"
cp -RLp "$source_dir/node_modules" "$release_root/app/node_modules"
cp -a "$source_dir/package.json" "$release_root/app/package.json"
cp -a "$source_dir/LICENSE" "$release_root/licenses/LICENSE"
cp "$node_runtime_real" "$release_root/runtime/bin/node"
chmod 0555 "$release_root/runtime/bin/node"
cp "$operator_peercred_helper" "$release_root/app/operator-peercred-helper"
chmod 0755 "$release_root/app/operator-peercred-helper"

make_wrapper() {
  local name=$1
  local entry=$2
  local wrapper="$release_root/bin/$name"
  printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    'script_path=$(readlink -f -- "$0")' \
    'script_dir=$(CDPATH= cd -P -- "$(dirname -- "$script_path")" && pwd)' \
    "exec \"\$script_dir/../runtime/bin/node\" \"\$script_dir/../app/$entry\" \"\$@\"" \
    > "$wrapper"
  chmod 0555 "$wrapper"
}

make_wrapper nookd dist/nookd.js
make_wrapper nookctl dist/cli.js
make_wrapper nook-mcp dist/mcp/cli.js
make_wrapper nookbridge-provision dist/provision.js
make_wrapper nookbridge-provision-cli dist/provision.js
make_wrapper nookbridge-sync dist/sync.js
make_wrapper nookbridge-sync-cli dist/sync.js
make_wrapper nookbridge-health dist/health.js
make_wrapper nookbridge-runtime-check dist/runtime-check.js
chmod -R a+rX "$release_root"

(
  cd "$release_root"
  find app bin runtime licenses -type f -print | LC_ALL=C sort | while IFS= read -r relative_path; do
    sha256sum "$relative_path"
  done
) > "$release_root/SHA256SUMS"
payload_inventory_digest=$(sha256sum "$release_root/SHA256SUMS" 2>/dev/null | cut -d ' ' -f1) || fail

cat > "$release_root/release.json" <<EOF
{
  "artifactFormat": 1,
  "version": "$version",
  "gitCommit": "$git_commit",
  "dirtyTree": false,
  "target": {
    "os": "linux",
    "arch": "x86_64",
    "libc": "glibc"
  },
  "node": {
    "version": "22.23.2",
    "abi": "node-v$node_abi"
  },
  "minGlibc": "$min_glibc",
  "minLibstdcxx": "$min_libstdcxx",
  "packageLockSha256": "$package_lock_digest",
  "payloadInventorySha256": "$payload_inventory_digest",
  "stateCompatibility": "state-v1",
  "buildTimestamp": "$build_timestamp"
}
EOF
chmod 0755 "$release_root"

mkdir -p "$output_dir"
artifact="$output_dir/$release_root_name-linux-x64-gnu.tar.gz"
tar_file="$stage_dir/release.tar"
tar -cf "$tar_file" --sort=name --mtime="@$source_epoch" --owner=0 --group=0 --numeric-owner -C "$stage_dir" "$release_root_name" 2>/dev/null || fail
chmod 0700 "$release_root"
gzip -n -9 "$tar_file" 2>/dev/null || fail
mv "$tar_file.gz" "$artifact"
(
  cd "$output_dir"
  sha256sum "${artifact##*/}"
) > "$output_dir/SHA256SUMS" 2>/dev/null || fail

verifier=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/verify-linux-artifact.sh
bash "$verifier" --artifact "$artifact" --checksum-file "$output_dir/SHA256SUMS" >/dev/null 2>&1 || fail
printf '%s\n' "$OK_LINE"
