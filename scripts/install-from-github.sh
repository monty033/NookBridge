#!/usr/bin/env bash
# NookBridge one-command GitHub release installer.
#
# The release asset is published as install.sh. It downloads a version-pinned
# artifact plus the generic installer and verifier, verifies all downloaded
# files against SHA256SUMS, and then drives the existing transactional install.
# The target needs bash, curl, sha256sum, and standard POSIX utilities; it does
# not need Nix, npm, or a global Node runtime.

set -euo pipefail
umask 077

readonly INSTALLER_NAME='install-from-github.sh'
readonly RELEASE_VERSION='1.2.6'
readonly RELEASE_BASE_DEFAULT="https://github.com/monty033/NookBridge/releases/download/v${RELEASE_VERSION}"
readonly ARTIFACT_BASENAME="nookbridge-v${RELEASE_VERSION}-linux-x64-gnu.tar.gz"
readonly INSTALL_SYSTEMD_BASENAME='install-systemd.sh'
readonly VERIFY_ARTIFACT_BASENAME='verify-linux-artifact.sh'
readonly CHECKSUM_BASENAME='SHA256SUMS'
readonly SERVICE_NAME='nookd.service'
readonly SETTINGS_PATH='/etc/nookbridge/settings.json'
readonly SOCKET_PATH='/run/nookbridge/nookbridge.sock'
readonly REQUIRED_COMMANDS=(
  awk chmod curl id mktemp mkdir od rm sha256sum sleep systemctl tr wc
)

no_provision=0
no_sync=0
no_edit_settings=0
assume_yes=0
force_edit_settings=0
release_base="${NOOKBRIDGE_RELEASE_BASE:-${RELEASE_BASE_DEFAULT}}"

usage() {
  printf '%s\n' \
    'Usage: install.sh [options]' \
    '' \
    'Install the pinned NookBridge Linux release from GitHub.' \
    'The normal interactive path installs, provisions, edits policy if requested,' \
    'checks health, and offers the fetch-only sync.' \
    '' \
    'Options:' \
    '  --yes                accept yes/no prompt defaults' \
    '  --no-provision       install only; skip interactive authentication' \
    '  --no-edit-settings   skip the settings editor prompt' \
    '  --edit-settings      always run the settings editor prompt' \
    '  --no-sync            skip the final fetch-only sync prompt' \
    '  --no-fetch           alias for --no-sync' \
    '  --release-base URL   override the pinned release base URL' \
    '  --help               show this help' \
    '' \
    'Normal use:' \
    '  curl -fsSL https://github.com/monty033/NookBridge/releases/latest/download/install.sh | sudo bash'
}

die() {
  printf '%s: %s\n' "$INSTALLER_NAME" "$1" >&2
  exit 2
}

log() {
  printf '%s: %s\n' "$INSTALLER_NAME" "$1"
}

require_commands() {
  local command_name
  for command_name in "${REQUIRED_COMMANDS[@]}"; do
    command -v "$command_name" >/dev/null 2>&1 \
      || die "required command is unavailable: ${command_name}"
  done
}

require_root() {
  [ -n "${NOOKBRIDGE_FAKE_ROOT:-}" ] && return 0
  [ "$(id -u)" -eq 0 ] || die 'must be run as root'
}

tty_is_available() {
  # Test-only seam: when NOOKBRIDGE_BOOTSTRAP_FAKE_TTY points at an
  # openable file, treat that path as the controlling TTY. Production
  # never sets this; the harness uses it to verify the editor redirect
  # without needing a real /dev/tty in the test runner.
  if [ -n "${NOOKBRIDGE_FAKE_ROOT:-}" ] && [ -n "${NOOKBRIDGE_BOOTSTRAP_FAKE_TTY+x}" ]; then
    [ -n "$NOOKBRIDGE_BOOTSTRAP_FAKE_TTY" ] && [ -e "$NOOKBRIDGE_BOOTSTRAP_FAKE_TTY" ] || return 1
    ( : <"$NOOKBRIDGE_BOOTSTRAP_FAKE_TTY" ) 2>/dev/null
    return $?
  fi
  [ -e /dev/tty ] && ( : </dev/tty ) 2>/dev/null
}

tty_path() {
  if [ -n "${NOOKBRIDGE_FAKE_ROOT:-}" ] && [ -n "${NOOKBRIDGE_BOOTSTRAP_FAKE_TTY+x}" ]; then
    printf '%s\n' "$NOOKBRIDGE_BOOTSTRAP_FAKE_TTY"
    return 0
  fi
  printf '%s\n' '/dev/tty'
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help|-h) usage; exit 0 ;;
      --yes) assume_yes=1; shift ;;
      --no-provision) no_provision=1; shift ;;
      --no-edit-settings) no_edit_settings=1; shift ;;
      --edit-settings) force_edit_settings=1; shift ;;
      --no-sync|--no-fetch) no_sync=1; shift ;;
      --release-base)
        [ "$#" -ge 2 ] || die '--release-base requires a URL'
        release_base="$2"
        shift 2
        ;;
      --release-base=*) release_base="${1#--release-base=}"; shift ;;
      --) shift; break ;;
      -*) die "unknown option: $1" ;;
      *) die "unexpected positional argument: $1" ;;
    esac
  done

  case "$release_base" in
    https://*) ;;
    *) die 'release base must be an HTTPS URL' ;;
  esac
  release_base="${release_base%/}"
}

prompt_yes_no() {
  local question="$1" default="$2" reply suffix
  if [ "$assume_yes" -eq 1 ]; then
    [ "$default" = 'y' ]
    return
  fi
  case "$default" in
    y) suffix='[Y/n]' ;;
    n) suffix='[y/N]' ;;
    *) die 'invalid prompt default' ;;
  esac
  tty_is_available || return 1
  printf '%s %s ' "$question" "$suffix" >&2
  IFS= read -r reply </dev/tty || return 1
  case "$reply" in
    ''|[Yy]|[Yy][Ee][Ss]) [ "$default" = 'y' ] ;;
    [Nn]|[Nn][Oo]) [ "$default" = 'n' ] ;;
    *) [ "$default" = 'y' ] ;;
  esac
}

run_tty_command() {
  if tty_is_available; then
    "$@" </dev/tty
  else
    "$@"
  fi
}

make_default_settings() {
  local path="$1"
  printf '%s\n' \
    '{' \
    '  "version": 1,' \
    '  "defaults": { "read": true, "edit": false, "create": false, "delete": false },' \
    '  "overrides": []' \
    '}' >"$path"
  chmod 0640 "$path"
}

make_database_key() {
  local path="$1"
  od -An -vtx1 -N32 /dev/urandom | tr -d ' \n' >"$path" \
    || die 'database key generation failed'
  [ "$(wc -c <"$path")" -eq 64 ] || die 'database key generation failed'
  chmod 0400 "$path"
}

checksum_for() {
  local sums="$1" name="$2" value
  value="$(awk -v name="$name" \
    '$2 == name { if (++n > 1) exit 2; print $1 } END { if (n != 1) exit 3 }' \
    "$sums" 2>/dev/null || true)"
  [[ "$value" =~ ^[0-9a-fA-F]{64}$ ]] || die 'release checksum verification failed'
  printf '%s\n' "${value,,}"
}

verify_file() {
  local file="$1" expected="$2" actual
  actual="$(sha256sum "$file" | awk '{ print $1 }')"
  [ "$actual" = "${expected,,}" ] || die 'release checksum verification failed'
}

download_asset() {
  local name="$1" destination="$2"
  curl --fail --silent --show-error --location \
    --output "$destination" "${release_base}/${name}" \
    || die 'release download failed'
}

wait_for_health() {
  local attempt
  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if systemctl is-active --quiet "$SERVICE_NAME" >/dev/null 2>&1 \
      && nookbridge-health --socket "$SOCKET_PATH" >/dev/null 2>&1; then
      log 'nookd health: ok'
      return 0
    fi
    [ "$attempt" -lt 30 ] && sleep 1
  done
  die 'nookd health check failed'
}

parse_args "$@"
require_commands
require_root

stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/nookbridge-install.XXXXXX")"
chmod 0700 "$stage_dir"
settings_temp="${stage_dir}/settings.json"
db_key_temp="${stage_dir}/db-key"
artifact_path="${stage_dir}/${ARTIFACT_BASENAME}"
sums_path="${stage_dir}/${CHECKSUM_BASENAME}"
installer_path="${stage_dir}/${INSTALL_SYSTEMD_BASENAME}"
verifier_path="${stage_dir}/${VERIFY_ARTIFACT_BASENAME}"
cleanup() {
  rm -rf "$stage_dir"
}
trap cleanup EXIT

if [ -n "${NOOKBRIDGE_BOOTSTRAP_FAKE_INSTALLER:-}" ]; then
  # Test-only seam; production always downloads and verifies both helpers.
  installer_path="$NOOKBRIDGE_FAKE_INSTALLER"
  verifier_path="${NOOKBRIDGE_BOOTSTRAP_FAKE_VERIFIER:-$(command -v true)}"
fi

download_asset "$CHECKSUM_BASENAME" "$sums_path"
download_asset "$ARTIFACT_BASENAME" "$artifact_path"
if [ -z "${NOOKBRIDGE_BOOTSTRAP_FAKE_INSTALLER:-}" ]; then
  download_asset "$INSTALL_SYSTEMD_BASENAME" "$installer_path"
  download_asset "$VERIFY_ARTIFACT_BASENAME" "$verifier_path"
fi

verify_file "$artifact_path" "$(checksum_for "$sums_path" "$ARTIFACT_BASENAME")"
if [ -z "${NOOKBRIDGE_BOOTSTRAP_FAKE_INSTALLER:-}" ]; then
  verify_file "$installer_path" "$(checksum_for "$sums_path" "$INSTALL_SYSTEMD_BASENAME")"
  verify_file "$verifier_path" "$(checksum_for "$sums_path" "$VERIFY_ARTIFACT_BASENAME")"
  chmod 0755 "$installer_path" "$verifier_path"
  bash "$verifier_path" --artifact "$artifact_path" --checksum-file "$sums_path" \
    >/dev/null 2>&1 || die 'release artifact verification failed'
fi
log 'release verification: ok'

first_install=0
if [ -z "${NOOKBRIDGE_FAKE_ROOT:-}" ] && [ -L /opt/nookbridge/current ] && [ -f /etc/nookbridge/installer-state.json ]; then
  install_command='upgrade'
else
  first_install=1
  install_command='install'
  make_default_settings "$settings_temp"
  make_database_key "$db_key_temp"
fi

if [ "$first_install" -eq 1 ]; then
  bash "$installer_path" "$install_command" \
    --artifact "$artifact_path" \
    --checksum-file "$sums_path" \
    --settings-file "$settings_temp" \
    --db-key-file "$db_key_temp"
else
  bash "$installer_path" "$install_command" \
    --artifact "$artifact_path" \
    --checksum-file "$sums_path" \
    --force
fi

if [ "$first_install" -eq 1 ] && [ "$no_provision" -eq 0 ]; then
  if prompt_yes_no 'Provision Notesnook account now?' y; then
    log 'starting interactive provisioning'
    run_tty_command nookbridge-provision
    wait_for_health
  else
    log 'provisioning skipped'
  fi
fi

if [ "$no_edit_settings" -eq 0 ] && { [ "$force_edit_settings" -eq 1 ] || prompt_yes_no 'Edit access settings now?' n; }; then
  if ! systemctl is-active --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
    die 'settings editing requires a provisioned active service'
  fi
  # Bind the controlling TTY on stdin, stdout, and stderr so the
  # editor's prompts and output remain visible even when the bootstrap
  # itself was launched without a TTY (e.g. `curl | sudo bash`,
  # captured automation). Without this, the editor would inherit the
  # installer pipes and silently appear to hang. Fall back to the
  # inherited stdio when /dev/tty is unavailable so non-interactive
  # installs still get a deterministic exit code.
  if tty_is_available; then
    tty="$(tty_path)"
    log 'opening settings editor on the controlling TTY'
    NOOKBRIDGE_SETTINGS_PATH="$SETTINGS_PATH" nookctl settings edit \
      <"$tty" >"$tty" 2>"$tty"
  else
    log 'opening settings editor on inherited stdio (no controlling TTY)'
    NOOKBRIDGE_SETTINGS_PATH="$SETTINGS_PATH" nookctl settings edit
  fi
  wait_for_health
fi

if [ "$no_sync" -eq 0 ] && systemctl is-active --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
  if prompt_yes_no 'Run fetch-only sync now?' n; then
    log 'starting fetch-only sync'
    run_tty_command nookbridge-sync
    log 'fetch-only sync: ok'
  fi
fi

log 'installation: ok'
