# NookBridge command shortcuts.
# All Node commands run inside the pinned offline Nix development shell.

set shell := ["bash", "-euo", "pipefail", "-c"]
# Recipe arguments must reach the shell as positional parameters, never
# interpolated into the command text: `{{ARGS}}` would let shell metacharacters
# in an argument run before the release command can validate them.
set positional-arguments

nix := "nix develop --offline --command"
live-state := "var/state/stage-3-live-crypto-poc"
default: check

# Full repository validation used before commits.
check:
    {{nix}} npm test
    {{nix}} npm run typecheck
    {{nix}} npm run lint
    {{nix}} npm run format:check
    {{nix}} npm run build
    git diff --check
    git diff --cached --check

# Run the complete test suite.
test:
    {{nix}} npm test

# Run the focused Stage 3 read-only sync tests.
stage3-test:
    {{nix}} npx vitest run tests/stage-3-read-only-sync.test.ts

# Offline pre-flight for the Stage 4 operator write gate. The gate is
# intentionally absent here: this proves default-off behavior without opening
# live state or contacting Notesnook.
check-stage4-operator-gate:
    env -u NOOKBRIDGE_ENABLE_LIVE_SYNC {{nix}} npx vitest run tests/stage-4-write-operator.test.ts
    {{nix}} npm run typecheck

# Compile the distributable output.
build:
    {{nix}} npm run build

# Format the repository.
format:
    {{nix}} npm run format

# Show the administrative CLI help without opening live state.
cli-help:
    {{nix}} node dist/cli.js help

# Read-only release state: version, canonical commit, preflight, tags, mirror.
release-status:
    {{nix}} npm run release:status

# Tag and push the canonical version, then wait for the release workflow.
# Extra arguments are passed through, for example: just release --no-watch
release *ARGS:
    {{nix}} npm run release:tag -- "$@"

# Promote an accepted candidate release onto the public install path.
# Extra arguments are passed through, for example: just release-promote 0.1.2
release-promote *ARGS:
    {{nix}} npm run release:promote -- "$@"

# Interactive live login. Credentials and MFA stay in the TTY.
# Use a fresh disposable state directory for proof work.
live-login:
    NOOKBRIDGE_ENABLE_LIVE_AUTH=1 NOOKBRIDGE_STATE_DIR="{{live-state}}" {{nix}} node dist/cli.js auth live-login

# Gated read-only fetch proof against an already authenticated state.
live-status:
    NOOKBRIDGE_ENABLE_LIVE_SYNC=1 NOOKBRIDGE_STATE_DIR="{{live-state}}" {{nix}} node dist/cli.js sync status

live-sync:
    NOOKBRIDGE_ENABLE_LIVE_SYNC=1 NOOKBRIDGE_STATE_DIR="{{live-state}}" {{nix}} node dist/cli.js sync read-only

# Gated live Stage 4 canary: local write only; remote stays pending until `live-write-sync`.
live-write-create:
    NOOKBRIDGE_ENABLE_LIVE_SYNC=1 NOOKBRIDGE_STATE_DIR="{{live-state}}" {{nix}} node dist/cli.js write create --title "NookBridge Stage 4 live canary"

# Explicit remote synchronization for the pending Stage 4 canary.
live-write-sync:
    NOOKBRIDGE_ENABLE_LIVE_SYNC=1 NOOKBRIDGE_STATE_DIR="{{live-state}}" {{nix}} node dist/cli.js write sync
