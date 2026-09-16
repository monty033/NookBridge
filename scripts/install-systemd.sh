#!/usr/bin/env bash
# Install the NookBridge package and hardened systemd unit on a Linux host that
# has Nix, but does not run NixOS. The installer owns only the paths below.
set -euo pipefail

readonly DEFAULT_SOURCE='git+https://git.montycasa.net/patrick/NookBridge?ref=main'
readonly ETC_DIR='/etc/nookbridge'
readonly SERVICE_CONFIG_PATH="${ETC_DIR}/service.json"
readonly SETTINGS_PATH="${ETC_DIR}/settings.json"
readonly DB_KEY_PATH="${ETC_DIR}/db-key"
readonly SYSTEMD_UNIT_PATH='/etc/systemd/system/nookd.service'
readonly BIN_DIR='/usr/local/bin'
readonly STATE_DIR='/var/lib/nookbridge'
readonly RUNTIME_DIR='/run/nookbridge'
readonly SERVICE_USER='nookbridge'
readonly SERVICE_PRIMARY_GROUP='nookbridge'
readonly SERVICE_GROUP='nookbridge-clients'

source_url="$DEFAULT_SOURCE"
settings_file=''
db_key_file=''
package_root=''
print_units=0
force_install=0

usage() {
  printf '%s\n' \
    'Usage: install-systemd.sh --settings-file PATH --db-key-file PATH [--source FLAKE]' \
    '' \
    'Install NookBridge from a Nix flake on a non-NixOS systemd host.' \
    '' \
    'Required:' \
    '  --settings-file PATH  root-readable NookBridge settings JSON' \
    '  --db-key-file PATH    root-readable database-key file (never printed)' \
    '' \
    'Options:' \
    '  --source FLAKE        flake reference; defaults to canonical main' \
    '  --print-units         render the unit contract without root or Nix' \
    '  --package-root PATH   package path for --print-units tests/review' \
    '  --force               replace files and links from an earlier install' \
    '  --help                show this help'
}

die() {
  printf 'install-systemd.sh: %s\n' "$1" >&2
  exit 2
}

require_absolute_path() {
  local name="$1"
  local value="$2"
  case "$value" in
    /*) ;;
    *) die "${name} must be an absolute path" ;;
  esac
  case "$value" in
    *[[:space:]]*|*$'\n'*|*$'\r'*|*$'\t'*) die "${name} contains unsupported whitespace" ;;
  esac
  case "/$value/" in
    */../*) die "${name} must not contain parent-directory traversal" ;;
  esac
}

require_existing_regular_root_file() {
  local name="$1"
  local path="$2"
  require_absolute_path "$name" "$path"
  [ ! -L "$path" ] || die "${name} must not be a symlink"
  [ -f "$path" ] || die "${name} is not a regular file"
  local owner mode
  owner="$(stat -c '%u' -- "$path")"
  mode="$(stat -c '%a' -- "$path")"
  [ "$owner" = '0' ] || die "${name} must be owned by root"
  if (( 8#$mode & 0077 )); then
    die "${name} must not be group or world writable"
  fi
  if (( ! (8#$mode & 0400) )); then
    die "${name} must be readable by root"
  fi
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die 'must be run as root'
}

require_commands() {
  local command_name
  for command_name in nix systemctl install stat getent groupadd useradd id mkdir chmod chown ln mktemp mv; do
    command -v "$command_name" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
  done
}

check_replace_allowed() {
  local destination="$1"
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    [ "$force_install" -eq 1 ] || die "refusing to replace existing path: ${destination} (use --force)"
  fi
}

check_install_destinations() {
  check_replace_allowed "$SERVICE_CONFIG_PATH"
  check_replace_allowed "$SETTINGS_PATH"
  check_replace_allowed "$DB_KEY_PATH"
  check_replace_allowed "$SYSTEMD_UNIT_PATH"
  local name
  for name in nookd nook-mcp nookctl nookbridge-provision-cli nookbridge-sync-cli nookbridge-provision nookbridge-sync; do
    check_replace_allowed "${BIN_DIR}/${name}"
  done
}

render_units() {
  local root="$1"
  local key_path="$2"
  local settings_path="$3"
  require_absolute_path 'package root' "$root"
  require_absolute_path 'database-key path' "$key_path"
  require_absolute_path 'settings path' "$settings_path"

  printf '%s\n' \
    '[Unit]' \
    'Description=NookBridge read-write Unix-socket service with settings-gated delete' \
    'After=local-fs.target' \
    'Wants=local-fs.target' \
    'Before=multi-user.target' \
    ' ' \
    '[Service]' \
    'Type=simple' \
    'User=nookbridge' \
    'Group=nookbridge-clients' \
    'WorkingDirectory=/var/lib/nookbridge' \
    'Environment=HOME=/var/lib/nookbridge' \
    "ExecStartPre=${root}/bin/nookd --check-config /etc/nookbridge/service.json" \
    "ExecStart=${root}/bin/nookd --config /etc/nookbridge/service.json" \
    "LoadCredential=nookbridge-db-key:${key_path}" \
    "LoadCredential=nookbridge-settings:${settings_path}" \
    'StateDirectory=nookbridge' \
    'StateDirectoryMode=0750' \
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
    'UMask=0007' \
    'Restart=on-failure' \
    'RestartSec=5s' \
    'TimeoutStopSec=15s' \
    ' ' \
    '[Install]' \
    'WantedBy=multi-user.target' \
    '' \
    '# Operator wrappers use systemd-run --pty with these fixed credential labels.' \
    '# The daemon unit above is the only long-running service installed.'
}

write_service_config() {
  local temporary
  check_replace_allowed "$SERVICE_CONFIG_PATH"
  temporary="$(mktemp "${SERVICE_CONFIG_PATH}.tmp.XXXXXX")"
  printf '%s\n' \
    '{' \
    '  "stateDir": "/var/lib/nookbridge",' \
    '  "socketPath": "/run/nookbridge/nookbridge.sock",' \
    '  "socketGroup": "nookbridge-clients",' \
    '  "backend": "systemd-credential",' \
    '  "credentialName": "nookbridge-db-key",' \
    '  "settingsBackend": "cli",' \
    '  "readPolicy": ["notes.search", "notes.status", "notes.list_notebooks", "notes.get", "notes.path_diagnostic", "notes.create", "notes.append", "notes.update", "notes.delete", "notes.sync"]' \
    '}' >"$temporary"
  chown root:root "$temporary"
  chmod 0644 "$temporary"
  mv -f "$temporary" "$SERVICE_CONFIG_PATH"
}

copy_protected_file() {
  local source="$1"
  local destination="$2"
  local mode="$3"
  local temporary
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    [ "$force_install" -eq 1 ] || die "refusing to replace existing file: ${destination} (use --force)"
  fi
  temporary="$(mktemp "${destination}.tmp.XXXXXX")"
  install -o root -g root -m "$mode" -- "$source" "$temporary"
  mv -f "$temporary" "$destination"
}

install_link() {
  local name="$1"
  local target="${package_root}/bin/${name}"
  local destination="${BIN_DIR}/${name}"
  [ -x "$target" ] || die "package is missing executable: ${name}"
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    [ "$force_install" -eq 1 ] || die "refusing to replace existing link: ${destination} (use --force)"
  fi
  ln -sfn "$target" "$destination"
}

write_operator_wrapper() {
  local command_name="$1"
  local gate_name="$2"
  local executable="$3"
  local destination="${BIN_DIR}/${command_name}"
  local temporary
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    [ "$force_install" -eq 1 ] || die "refusing to replace existing wrapper: ${destination} (use --force)"
  fi
  temporary="$(mktemp "${destination}.tmp.XXXXXX")"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'if [ "$(id -u)" -ne 0 ]; then' \
    "  printf '%s\\n' '${command_name}: must be run as root' >&2" \
    '  exit 77' \
    'fi' \
    'exec systemd-run --quiet --wait --collect --pty' \
    "  --unit=${gate_name}-session.service" \
    '  --uid=nookbridge --gid=nookbridge-clients' \
    '  --property=WorkingDirectory=/var/lib/nookbridge' \
    '  --property=Environment=HOME=/var/lib/nookbridge' \
    "  --property=Environment=${gate_name}=1" \
    "  --property=LoadCredential=nookbridge-db-key:${DB_KEY_PATH}" \
    '  --property=ProtectSystem=strict' \
    '  --property=ProtectHome=yes' \
    '  --property=PrivateTmp=yes' \
    '  --property=PrivateDevices=yes' \
    '  --property=NoNewPrivileges=yes' \
    '  --property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' \
    '  --property=ReadWritePaths=/var/lib/nookbridge' \
    "  ${package_root}/bin/${executable}" >"$temporary"
  chown root:root "$temporary"
  chmod 0755 "$temporary"
  mv -f "$temporary" "$destination"
}

install_systemd() {
  local source="$1"
  require_root
  require_commands
  require_existing_regular_root_file 'settings file' "$settings_file"
  require_existing_regular_root_file 'database-key file' "$db_key_file"

  package_root="$(nix build --no-link --print-out-paths "${source}#nookbridge")"
  require_absolute_path 'built package' "$package_root"
  [ -x "${package_root}/bin/nookd" ] || die 'Nix build did not produce nookd'
  check_install_destinations

  getent group "$SERVICE_PRIMARY_GROUP" >/dev/null 2>&1 || groupadd --system "$SERVICE_PRIMARY_GROUP"
  getent group "$SERVICE_GROUP" >/dev/null 2>&1 || groupadd --system "$SERVICE_GROUP"
  if ! getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin \
      --gid "$SERVICE_PRIMARY_GROUP" "$SERVICE_USER"
  fi
  mkdir -p "$ETC_DIR" "$BIN_DIR" "$STATE_DIR" "$RUNTIME_DIR"
  chown root:root "$ETC_DIR"
  chmod 0750 "$ETC_DIR"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$STATE_DIR" "$RUNTIME_DIR"
  chmod 0750 "$STATE_DIR" "$RUNTIME_DIR"

  write_service_config
  copy_protected_file "$settings_file" "$SETTINGS_PATH" 0640
  copy_protected_file "$db_key_file" "$DB_KEY_PATH" 0400
  "$package_root/bin/nookd" --check-config "$SERVICE_CONFIG_PATH" >/dev/null
  NOOKBRIDGE_SERVICE_CONFIG="$SERVICE_CONFIG_PATH" \
    NOOKBRIDGE_SETTINGS_PATH="$SETTINGS_PATH" \
    "$package_root/bin/nookctl" settings validate >/dev/null

  install_link nookd
  install_link nook-mcp
  install_link nookctl
  install_link nookbridge-provision-cli
  install_link nookbridge-sync-cli
  write_operator_wrapper nookbridge-provision NOOKBRIDGE_ENABLE_LIVE_AUTH nookbridge-provision-cli
  write_operator_wrapper nookbridge-sync NOOKBRIDGE_ENABLE_LIVE_SYNC nookbridge-sync-cli

  local temporary_unit
  check_replace_allowed "$SYSTEMD_UNIT_PATH"
  temporary_unit="$(mktemp "${SYSTEMD_UNIT_PATH}.tmp.XXXXXX")"
  render_units "$package_root" "$DB_KEY_PATH" "$SETTINGS_PATH" >"$temporary_unit"
  chown root:root "$temporary_unit"
  chmod 0644 "$temporary_unit"
  mv -f "$temporary_unit" "$SYSTEMD_UNIT_PATH"

  systemctl daemon-reload
  systemctl enable --now nookd.service
  printf '%s\n' 'NookBridge systemd installation completed.'
  printf '%s\n' 'Run `nookbridge-provision` from a protected host TTY to authenticate.'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --source)
      [ "$#" -ge 2 ] || die '--source requires a flake reference'
      source_url="$2"
      shift 2
      ;;
    --settings-file)
      [ "$#" -ge 2 ] || die '--settings-file requires a path'
      settings_file="$2"
      shift 2
      ;;
    --db-key-file)
      [ "$#" -ge 2 ] || die '--db-key-file requires a path'
      db_key_file="$2"
      shift 2
      ;;
    --package-root)
      [ "$#" -ge 2 ] || die '--package-root requires a path'
      package_root="$2"
      shift 2
      ;;
    --print-units)
      print_units=1
      shift
      ;;
    --force)
      force_install=1
      shift
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

if [ "$print_units" -eq 1 ]; then
  [ -n "$package_root" ] || die '--print-units requires --package-root'
  [ -n "$settings_file" ] || settings_file="$SETTINGS_PATH"
  [ -n "$db_key_file" ] || db_key_file="$DB_KEY_PATH"
  render_units "$package_root" "$db_key_file" "$settings_file"
  exit 0
fi

[ -n "$settings_file" ] || die '--settings-file is required'
[ -n "$db_key_file" ] || die '--db-key-file is required'
install_systemd "$source_url"
