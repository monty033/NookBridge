# NookBridge command shortcuts.
# All Node commands run inside the pinned offline Nix development shell.

set shell := ["bash", "-euo", "pipefail", "-c"]

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

# Compile the distributable output.
build:
    {{nix}} npm run build

# Format the repository.
format:
    {{nix}} npm run format

# Show the administrative CLI help without opening live state.
cli-help:
    {{nix}} node dist/cli.js help

# Interactive live login. Credentials and MFA stay in the TTY.
# Use a fresh disposable state directory for proof work.
live-login:
    NOOKBRIDGE_ENABLE_LIVE_AUTH=1 NOOKBRIDGE_STATE_DIR="{{live-state}}" {{nix}} node dist/cli.js auth live-login

# Gated read-only fetch proof against an already authenticated state.
live-status:
    NOOKBRIDGE_ENABLE_LIVE_SYNC=1 NOOKBRIDGE_STATE_DIR="{{live-state}}" {{nix}} node dist/cli.js sync status

live-sync:
    NOOKBRIDGE_ENABLE_LIVE_SYNC=1 NOOKBRIDGE_STATE_DIR="{{live-state}}" {{nix}} node dist/cli.js sync read-only
