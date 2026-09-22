# Changelog

All notable user-visible changes are recorded here. The project is pre-alpha;
release entries describe the supported boundary at the time of the release.

## [0.1.0] - 2026-09-22

First intentional pre-1.0 release line. This release is usable for the
recorded Linux deployment path, but the public contracts and broader production
support boundary remain subject to change.

### Added

- Narrow Unix-socket `nookd` service boundary and stdio MCP proxy.
- Credential-separated Notesnook authentication and encrypted local state.
- Bounded fetch-only read sync and read-only MCP tools.
- Approval-gated operator note browsing, search, get, create, edit, and undo.
- Fail-closed authorization, notebook-scoped policy evaluation, operation
  ownership, and categorical error handling.
- Linux artifact build, verification, systemd installation, health checks, and
  transactional release activation.
- Regression coverage and live acceptance for the notebook-membership fallback
  used by operator authorization.

### Known limitations

- The project remains pre-alpha and the API/configuration contracts may change.
- The broader production-MVP release gates are not all closed.
- Delete is intentionally not part of the bounded operator notes surface.
- Sync and mutation support remain narrowly scoped; do not infer general account
  or cross-device support from the validated scenarios.

[0.1.0]: https://git.montycasa.net/patrick/NookBridge/releases/tag/v0.1.0
