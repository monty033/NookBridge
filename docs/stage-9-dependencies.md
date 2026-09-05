# Stage 9 dependency and licensing evidence

Date: 2026-09-05
Source revision: `ef5f53d040f5791a37e3761a09c5e42d9e4a4889`

## Lockfile-derived production inventory

The committed `package-lock.json` was parsed offline with Node. The inventory
includes every package entry that is not marked `dev`, `optional`, or `link`.

Command shape:

```text
node -e 'read package-lock.json; filter production entries; emit package/version/license'
```

Result:

- Production package entries: **221**
- Entries with a license field: **221**
- Missing license fields: **0**
- External scanner: not required for this lockfile-derived evidence; no unpinned
  package metadata was fetched during the run.

The complete CSV export is committed at
`docs/stage-9-production-licenses.csv`.
SHA-256: `9dff251210ed329a09d4966cee0739f995e3793b916ef4315a7d69a9bdf42735`.
Direct runtime license summaries remain in `docs/licensing.md`.

## Build and package checks

- `nix develop --offline --command just check`: **PASS** — 41 test files,
  1,112 tests; typecheck, lint, format, build, and diff checks pass.
- `nix flake check --no-build`: **PASS**.
- `nix build --no-link .#checks.x86_64-linux.nookbridge-service`: **PASS**.
- `nix build --no-link .#checks.x86_64-linux.nookbridge-isolation`: **PASS**.

## Release status

This closes the lockfile-field inventory gap for the internal deployment
candidate. It does not authorize public distribution: the package remains
`private: true`, the package version remains `0.0.0-stage.0`, and the source
pin/deployment canary/recovery gates remain outstanding.
