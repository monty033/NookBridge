#!/usr/bin/env bash
# Install and transact a prebuilt NookBridge Linux artifact on a systemd host.
# The target needs systemd, tar, core utilities, and root; it does not need Nix,
# npm, or a global Node installation.
set -euo pipefail

readonly SERVICE_NAME='nookd.service'
readonly SERVICE_USER='nookbridge'
readonly SERVICE_GROUP='nookbridge-clients'
readonly PRIVATE_GROUP='nookbridge'
readonly SOCKET_PATH='/run/nookbridge/nookbridge.sock'

OPT_DIR="${NOOKBRIDGE_OPT_DIR:-/opt/nookbridge}"
RELEASES_DIR="${NOOKBRIDGE_RELEASES_DIR:-${OPT_DIR}/releases}"
CURRENT_LINK="${OPT_DIR}/current"
ETC_DIR="${NOOKBRIDGE_ETC_DIR:-/etc/nookbridge}"
STATE_DIR="${NOOKBRIDGE_STATE_DIR:-/var/lib/nookbridge}"
RUNTIME_DIR="${NOOKBRIDGE_RUNTIME_DIR:-/run/nookbridge}"
SYSTEMD_DIR="${NOOKBRIDGE_SYSTEMD_DIR:-/etc/systemd/system}"
USR_LOCAL_BIN="${NOOKBRIDGE_USR_LOCAL_BIN:-/usr/local/bin}"
INSTALLER_STATE="${NOOKBRIDGE_INSTALLER_STATE:-${ETC_DIR}/installer-state.json}"
LOCK_PATH="${NOOKBRIDGE_INSTALLER_LOCK:-${STATE_DIR}/installer.lock}"
UNIT_PATH="${SYSTEMD_DIR}/${SERVICE_NAME}"

command_name=''
artifact=''
checksum_file=''
manifest_file=''
settings_file=''
db_key_file=''
rollback_target=''
prune_keep=''
force_install=0

usage() {
  printf '%s\n' \
    'Usage: install-systemd.sh <install|upgrade|rollback|prune> [options]' \
    '' \
    'Install or transact a prebuilt NookBridge Linux artifact on a systemd host.' \
    'The target does not require Nix, npm, or a global Node installation.' \
    '' \
    'Commands:' \
    '  install                 install and activate a release artifact' \
    '  upgrade                 install and health-check a new release artifact' \
    '  rollback --to VERSION   activate a managed release already under releases/' \
    '  prune --keep N           retain current, previous, and N additional releases' \
    '' \
    'Artifact options:' \
    '  --artifact PATH         release .tar.gz artifact' \
    '  --checksum-file PATH    basename-only SHA256SUMS file' \
    '  --manifest PATH         optional preflight manifest JSON' \
    '  --settings-file PATH    root-readable settings JSON' \
    '  --db-key-file PATH      root-readable database-key file' \
    '  --force                 allow replacement of managed files' \
    '' \
    'Review options:' \
    '  --render-units          render the generic current-symlink unit' \
    '  --print-units           render a unit using an explicit package root' \
    '  --package-root PATH    compatibility package root for --print-units' \
    '  --help                  show this help'
}

die() {
  printf 'install-systemd.sh: %s\n' "$1" >&2
  exit 2
}

require_absolute_path() {
  local name="$1" value="$2"
  case "$value" in
    /*) ;;
    *) die "${name} must be an absolute path" ;;
  esac
  case "/$value/" in
    */../*) die "${name} must not contain parent-directory traversal" ;;
  esac
}

require_root() {
  if [ -n "${NOOKBRIDGE_FAKE_ROOT:-}" ]; then
    return
  fi
  [ "$(id -u)" -eq 0 ] || die 'must be run as root'
}

require_commands() {
  local name
  for name in awk chown cut date dirname find flock getent grep groupadd install ln mkdir mktemp mv readlink rm sha256sum sed sort stat systemctl tar useradd; do
    command -v "$name" >/dev/null 2>&1 || die "required command is unavailable: ${name}"
  done
}

ensure_service_identity() {
  [ -n "${NOOKBRIDGE_FAKE_ROOT:-}" ] && return
  getent group "$PRIVATE_GROUP" >/dev/null 2>&1 || groupadd --system "$PRIVATE_GROUP"
  getent group "$SERVICE_GROUP" >/dev/null 2>&1 || groupadd --system "$SERVICE_GROUP"
  if ! getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$STATE_DIR" --no-create-home \
      --shell /usr/sbin/nologin --gid "$PRIVATE_GROUP" "$SERVICE_USER"
  fi
}

render_unit() {
  local package_root="$1"
  printf '%s\n' \
    '[Unit]' \
    'Description=NookBridge read-write Unix-socket service with settings-gated delete' \
    'After=local-fs.target' \
    'Wants=local-fs.target' \
    'Before=multi-user.target' \
    '' \
    '[Service]' \
    'Type=simple' \
    "ExecStart=${package_root}/bin/nookd --config /etc/nookbridge/service.json" \
    'User=nookbridge' \
    'Group=nookbridge-clients' \
    'SupplementaryGroups=nookbridge' \
    'WorkingDirectory=/var/lib/nookbridge' \
    'Environment=HOME=/var/lib/nookbridge' \
    'LoadCredential=nookbridge-db-key:/etc/nookbridge/db-key' \
    'LoadCredential=nookbridge-settings:/etc/nookbridge/settings.json' \
    'StateDirectory=nookbridge' \
    'StateDirectoryMode=0700' \
    'RuntimeDirectory=nookbridge' \
    'RuntimeDirectoryMode=0750' \
    'ProtectSystem=strict' \
    'ProtectHome=yes' \
    'PrivateTmp=yes' \
    'PrivateDevices=yes' \
    'NoNewPrivileges=yes' \
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' \
    'RestrictNamespaces=yes' \
    'ProtectKernelTunables=yes' \
    'ProtectKernelModules=yes' \
    'ProtectControlGroups=yes' \
    'LockPersonality=yes' \
    'RestrictRealtime=yes' \
    'RestrictSUIDSGID=yes' \
    'CapabilityBoundingSet=' \
    'AmbientCapabilities=' \
    'SystemCallArchitectures=native' \
    'ReadWritePaths=/var/lib/nookbridge /run/nookbridge' \
    'UMask=0077' \
    'LimitCORE=0' \
    'Restart=on-failure' \
    'RestartSec=5s' \
    'TimeoutStopSec=15s' \
    '' \
    '[Install]' \
    'WantedBy=multi-user.target' \
    '' \
    '# Operator wrappers use systemd-run --pty with fixed credential labels.'
}

render_legacy_unit() {
  local package_root="$1" key_path="$2" settings_path="$3"
  require_absolute_path 'package root' "$package_root"
  require_absolute_path 'database-key path' "$key_path"
  require_absolute_path 'settings path' "$settings_path"
  render_unit "$package_root" | sed \
    -e "s#LoadCredential=nookbridge-db-key:/etc/nookbridge/db-key#LoadCredential=nookbridge-db-key:${key_path}#" \
    -e "s#LoadCredential=nookbridge-settings:/etc/nookbridge/settings.json#LoadCredential=nookbridge-settings:${settings_path}#"
}

json_top_level_string() {
  local key="$1" file="$2" line
  line="$(grep -E "^  \"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$file" 2>/dev/null || true)"
  [ -n "$line" ] || return 1
  printf '%s\n' "$line" | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/'
}

validate_manifest_file() {
  local file="$1" version target
  [ -f "$file" ] || die "manifest file is missing: ${file}"
  version="$(json_top_level_string version "$file" || true)"
  target="$(json_top_level_string target "$file" || true)"
  [[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$ ]] || die "invalid version pattern: ${version:-missing}"
  [ "$target" = 'linux-x64-gnu' ] || die "invalid artifact target: ${target:-missing}"
}

archive_top_level() {
  local archive="$1" members first
  members="$(tar -tzf "$archive" 2>/dev/null)" || return 1
  first="${members%%$'\n'*}"
  first="${first%/}"
  printf '%s\n' "${first%%/*}"
}

artifact_version() {
  local archive="$1" top manifest version
  top="$(archive_top_level "$archive")" || return 1
  manifest="$(mktemp)"
  trap 'rm -f "$manifest"' RETURN
  tar -xOzf "$archive" "${top}/release.json" >"$manifest" 2>/dev/null || return 1
  version="$(json_top_level_string version "$manifest" || true)"
  [[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$ ]] || return 1
  printf '%s\n' "$version"
}

verify_checksum_preflight() {
  local file="$1" sums="$2" name line expected actual
  name="${file##*/}"
  [ -f "$sums" ] || die "checksum file is missing: ${sums}"
  [ -f "$file" ] || die "checksum mismatch for ${name}"
  line="$(awk -v name="$name" '$2 == name { if (++n > 1) exit 2; print } END { if (n != 1) exit 3 }' "$sums" 2>/dev/null || true)"
  expected="${line%%[[:space:]]*}"
  [[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || die "checksum mismatch for ${name}"
  actual="$(sha256sum "$file" | cut -d' ' -f1)"
  [ "$actual" = "${expected,,}" ] || die "checksum mismatch for ${name}"
}

check_unmanaged_unit() {
  if [ -e "$UNIT_PATH" ] || [ -L "$UNIT_PATH" ]; then
    grep -q '^# Managed-by: nookbridge-artifact-installer$' "$UNIT_PATH" 2>/dev/null \
      || die "unmanaged nookd.service at ${UNIT_PATH}"
  fi
}

write_unit() {
  local temporary
  mkdir -p "$SYSTEMD_DIR"
  temporary="$(mktemp "${SYSTEMD_DIR}/nookd.service.tmp.XXXXXX")"
  {
    printf '%s\n' '# Managed-by: nookbridge-artifact-installer'
    render_unit "$CURRENT_LINK"
  } >"$temporary"
  chmod 0644 "$temporary"
  mv -f "$temporary" "$UNIT_PATH"
}

write_service_config() {
  local temporary
  mkdir -p "$ETC_DIR"
  temporary="$(mktemp "${ETC_DIR}/service.json.tmp.XXXXXX")"
  printf '%s\n' \
    '{' \
    '  "stateDir": "/var/lib/nookbridge",' \
    '  "socketPath": "/run/nookbridge/nookbridge.sock",' \
    '  "socketGroup": "nookbridge-clients",' \
    '  "backend": "systemd-credential",' \
    '  "credentialName": "nookbridge-db-key",' \
    '  "settingsBackend": "cli"' \
    '}' >"$temporary"
  chmod 0644 "$temporary"
  mv -f "$temporary" "${ETC_DIR}/service.json"
}

copy_protected_input() {
  local name="$1" source="$2" destination="$3" mode="$4" temporary
  require_absolute_path "$name" "$source"
  [ ! -L "$source" ] || die "${name} must not be a symlink"
  [ -f "$source" ] || die "${name} is not a regular file"
  mkdir -p "$(dirname "$destination")"
  temporary="$(mktemp "${destination}.tmp.XXXXXX")"
  install -m "$mode" -- "$source" "$temporary"
  mv -f "$temporary" "$destination"
}

write_ledger() {
  local version="$1" digest="$2" timestamp previous
  previous=''
  if [ -f "$INSTALLER_STATE" ]; then
    previous="$(json_top_level_string version "$INSTALLER_STATE" || true)"
  fi
  mkdir -p "$(dirname "$INSTALLER_STATE")"
  printf '{\n  "version": "%s",\n  "artifactSha256": "%s",\n  "previousVersion": "%s",\n  "timestamp": "%s"\n}\n' \
    "$version" "$digest" "$previous" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$INSTALLER_STATE"
  chmod 0640 "$INSTALLER_STATE"
}

activate_release() {
  local version="$1" release_dir="$2" next_link
  mkdir -p "$OPT_DIR" "$RELEASES_DIR"
  [ -d "$release_dir" ] || die "release directory is missing: ${release_dir}"
  next_link="${OPT_DIR}/.current.$$"
  rm -f "$next_link"
  ln -s "releases/${version}" "$next_link"
  mv -Tf "$next_link" "$CURRENT_LINK"
}

transaction_previous_target=''
transaction_activated=0
transaction_committed=0

restore_previous_release() {
  local rollback_link
  rollback_link="${OPT_DIR}/.rollback.$$"
  rm -f "$rollback_link"
  if [ -n "$transaction_previous_target" ]; then
    ln -s "$transaction_previous_target" "$rollback_link"
    mv -Tf "$rollback_link" "$CURRENT_LINK"
    systemctl restart "$SERVICE_NAME" >/dev/null 2>&1 || true
  else
    rm -f "$CURRENT_LINK"
  fi
}

transaction_exit() {
  local status="$?"
  if [ "$transaction_activated" -eq 1 ] && [ "$transaction_committed" -eq 0 ]; then
    restore_previous_release
    printf '%s\n' 'health check failed; rollback restored previous release' >&2
  fi
  trap - EXIT
  exit "$status"
}

install_wrappers() {
  local name
  # Stable nookd wrapper target: current/bin/
  mkdir -p "$USR_LOCAL_BIN"
  for name in nookd nook-mcp nookctl nookbridge-provision-cli nookbridge-sync-cli nookbridge-provision nookbridge-sync nookbridge-health nookbridge-runtime-check; do
    [ -x "${CURRENT_LINK}/bin/${name}" ] || continue
    ln -sfn "${CURRENT_LINK}/bin/${name}" "${USR_LOCAL_BIN}/${name}"
  done
}

run_health_gate() {
  local fake_bin="${NOOKBRIDGE_FAKE_BIN:-}"
  if [ -n "$fake_bin" ] && [ -x "${fake_bin}/nookbridge-health" ]; then
    PATH="${fake_bin}:$PATH" nookbridge-health --socket "$SOCKET_PATH" >/dev/null 2>&1 \
      || die 'health check failed; rollback restored previous release'
  elif command -v nookbridge-health >/dev/null 2>&1; then
    nookbridge-health --socket "$SOCKET_PATH" >/dev/null 2>&1 \
      || die 'health check failed; rollback restored previous release'
  fi
}

install_artifact() {
  local lock_fd version top digest stage release_dir
  require_root
  require_commands
  printf 'installer state: %s\n' "$INSTALLER_STATE"
  mkdir -p "$(dirname "$LOCK_PATH")"
  eval "exec {lock_fd}>\"$LOCK_PATH\""
  flock -n "$lock_fd" || die 'flock: installer already locked'
  printf '%s\n' 'flock: installer transaction acquired'

  transaction_previous_target=''
  if [ -L "$CURRENT_LINK" ]; then
    transaction_previous_target="$(readlink "$CURRENT_LINK")"
  fi
  transaction_activated=0
  transaction_committed=0
  trap transaction_exit EXIT

  if [ -n "$manifest_file" ]; then
    validate_manifest_file "$manifest_file"
  fi
  check_unmanaged_unit
  if [ -n "$checksum_file" ]; then
    verify_checksum_preflight "$artifact" "$checksum_file"
  elif [ ! -f "$artifact" ]; then
    die "artifact preflight archive check failed: artifact not found: ${artifact}; health check and rollback are gated until verification succeeds"
  fi
  [ -f "$artifact" ] || die "artifact preflight archive check failed: artifact not found: ${artifact}"
  [ -n "$checksum_file" ] || die 'checksum mismatch: --checksum-file is required'
  version="$(artifact_version "$artifact" || true)"
  [ -n "$version" ] || die 'archive manifest verification failed'
  stage="$(mktemp -d "${OPT_DIR}.stage.XXXXXX")"
  trap 'rm -rf "$stage"' RETURN
  bash "$(dirname "$0")/verify-linux-artifact.sh" --artifact "$artifact" --checksum-file "$checksum_file" >/dev/null 2>&1 \
    || die 'archive verification failed'
  top="$(archive_top_level "$artifact")"
  tar -xzf "$artifact" -C "$stage" 2>/dev/null || die 'archive extraction failed'
  release_dir="${RELEASES_DIR}/${version}"
  if [ -e "$release_dir" ] && [ "$force_install" -ne 1 ]; then
    die "release already exists: ${version}"
  fi
  rm -rf "$release_dir"
  mv "${stage}/${top}" "$release_dir"
  digest="$(sha256sum "$artifact" | cut -d' ' -f1)"
  ensure_service_identity
  mkdir -p "$ETC_DIR" "$STATE_DIR" "$RUNTIME_DIR"
  if [ -z "${NOOKBRIDGE_FAKE_ROOT:-}" ]; then
    chown "$SERVICE_USER:$PRIVATE_GROUP" "$STATE_DIR" "$RUNTIME_DIR"
    chmod 0750 "$STATE_DIR" "$RUNTIME_DIR"
  fi
  activate_release "$version" "$release_dir"
  transaction_activated=1
  write_service_config
  [ -z "$settings_file" ] || copy_protected_input 'settings file' "$settings_file" "${ETC_DIR}/settings.json" 0640
  [ -z "$db_key_file" ] || copy_protected_input 'database-key file' "$db_key_file" "${ETC_DIR}/db-key" 0400
  write_unit
  install_wrappers
  systemctl daemon-reload >/dev/null 2>&1
  systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1
  run_health_gate
  write_ledger "$version" "$digest"
  transaction_committed=1
  trap - EXIT
  printf '%s\n' 'nookbridge artifact install ok'
}

rollback_release() {
  local target="$1" path
  case "$target" in
    ''|*/*|*..*|*[!A-Za-z0-9._+-]*) die 'rollback target must remain inside managed releases' ;;
  esac
  path="${RELEASES_DIR}/${target}"
  [ -d "$path" ] || die 'rollback target is not a managed release'
  activate_release "$target" "$path"
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME" >/dev/null 2>&1 || true
  run_health_gate
  printf 'nookbridge rollback ok: %s\n' "$target"
}

prune_releases() {
  local keep="$1" current_version previous_version version keep_file kept
  [[ "$keep" =~ ^[0-9]+$ ]] || die 'prune --keep must be a non-negative integer'
  [ "$keep" -ge 2 ] || die 'prune refuses to remove current or immediate previous release; retain at least 2'
  keep_file="$(mktemp)"
  current_version=''
  previous_version=''
  if [ -L "$CURRENT_LINK" ]; then
    current_version="$(basename "$(readlink "$CURRENT_LINK")")"
    printf '%s\n' "$current_version" >>"$keep_file"
  fi
  if [ -f "$INSTALLER_STATE" ]; then
    previous_version="$(json_top_level_string previousVersion "$INSTALLER_STATE" || true)"
    if [ -n "$previous_version" ] && ! grep -Fxq "$previous_version" "$keep_file"; then
      printf '%s\n' "$previous_version" >>"$keep_file"
    fi
  fi
  kept="$(wc -l <"$keep_file")"
  while IFS= read -r version; do
    [ "$kept" -ge "$keep" ] && break
    if ! grep -Fxq "$version" "$keep_file"; then
      printf '%s\n' "$version" >>"$keep_file"
      kept=$((kept + 1))
    fi
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort -Vr)
  while IFS= read -r version; do
    [ -n "$version" ] || continue
    if ! grep -Fxq "$version" "$keep_file"; then
      rm -rf "${RELEASES_DIR}/${version}"
    fi
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null)
  rm -f "$keep_file"
  printf 'nookbridge prune retain %s releases\n' "$keep"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --render-units) command_name='render'; shift ;;
    --print-units) command_name='print'; shift ;;
    --package-root) [ "$#" -ge 2 ] || die '--package-root requires a path'; package_root="$2"; shift 2 ;;
    --artifact) [ "$#" -ge 2 ] || die '--artifact requires a path'; artifact="$2"; shift 2 ;;
    --checksum-file) [ "$#" -ge 2 ] || die '--checksum-file requires a path'; checksum_file="$2"; shift 2 ;;
    --manifest) [ "$#" -ge 2 ] || die '--manifest requires a path'; manifest_file="$2"; shift 2 ;;
    --settings-file) [ "$#" -ge 2 ] || die '--settings-file requires a path'; settings_file="$2"; shift 2 ;;
    --db-key-file) [ "$#" -ge 2 ] || die '--db-key-file requires a path'; db_key_file="$2"; shift 2 ;;
    --to) [ "$#" -ge 2 ] || die '--to requires a version'; rollback_target="$2"; shift 2 ;;
    --keep) [ "$#" -ge 2 ] || die '--keep requires a count'; prune_keep="$2"; shift 2 ;;
    --force) force_install=1; shift ;;
    install|upgrade|rollback|prune) [ -z "$command_name" ] || die 'command must precede render options'; command_name="$1"; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$command_name" in
  render)
    render_unit "$CURRENT_LINK"
    ;;
  print)
    [ -n "${package_root:-}" ] || die '--print-units requires --package-root'
    render_legacy_unit "$package_root" "${db_key_file:-/etc/nookbridge/db-key}" "${settings_file:-/etc/nookbridge/settings.json}"
    ;;
  install|upgrade)
    [ -n "$artifact" ] || die '--artifact is required'
    install_artifact
    ;;
  rollback)
    [ -n "$rollback_target" ] || die 'rollback requires --to VERSION'
    rollback_release "$rollback_target"
    ;;
  prune)
    [ -n "$prune_keep" ] || die 'prune requires --keep N'
    prune_releases "$prune_keep"
    ;;
  *)
    if [ -n "$artifact" ]; then install_artifact; else die 'a transaction command is required'; fi
    ;;
esac
