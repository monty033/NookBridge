# Stage 9 dependency and licensing evidence

Latest pass: 2026-10-24, artifact candidate `4729bd5ee25d2229e4ee0150e0125f2960dd465e`.
Earlier pass: 2026-09-05, source candidate `94ad5c0a` — lockfile-derived and
superseded, kept below for history.

## Artifact-derived production inventory — 2026-10-24

The shipped package was built with `nix build .#nookbridge` and this inventory
was derived from the artifact's own `node_modules`, not from the lockfile. The
lockfile records what was resolved; this records what actually ships.

Store path: `/nix/store/j4j6xcqxs8sdagnlcqrwvc81gq125syz-nookbridge-0.0.0-stage.0`

Command:

```text
nix develop --offline --command node scripts/verify-artifact-inventory.mjs \
  --node-modules <store>/libexec/nookbridge/node_modules \
  --inventory docs/engineering/stages/stage-9-production-licenses.csv
```

Result:

- Shipped package entries: **225**, which is **221** distinct `name@version`. The
  four extra entries are repeated nested copies: `content-type@2.1.0` appears three
  times, `ajv@8.20.0` twice, and `json-schema-traverse@1.0.0` twice.
- Entries declaring a licence: **224**.
- Missing licence field: **1** — `sqlite-regex-linux-x64@0.2.4-alpha.1`, covered by
  the owner-approved override below.
- Unlicensed after overrides: **0**.
- Checker exit: **0** — `artifact inventory ok (225 packages)`.

### Owner-approved licence override

`sqlite-regex-linux-x64@0.2.4-alpha.1` ships with no `license` field and no
LICENSE file. The parent package `sqlite-regex@0.2.4-alpha.1`, published from the
same source in the same release, declares `(MIT OR Apache-2.0)`. The repository
owner reviewed that evidence on 2026-10-24 and approved recording the licence for
the platform subpackage. The override is keyed by the exact `name@version`,
applies only when the package declares no licence of its own, and is printed with
its provenance on every checker run.

## Lockfile-derived production inventory — 2026-09-05 (superseded)

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
`docs/engineering/stages/stage-9-production-licenses.csv`, re-derived from the
2026-10-24 artifact tree (the 2026-09-05 export recorded npm display paths for
nested packages, which no longer matched the shipped tree).
SHA-256: `a6b5cdecdfa1fa928f832ca17b82b489de25bad21efa38282d6e1455b03b6e4f`.
Direct runtime license summaries remain in `docs/licensing.md`.

## Build and package checks

- `nix develop --offline --command just check`: **PASS** — 41 test files,
  1,112 tests; typecheck, lint, format, build, and diff checks pass.
- The following checks were run in the separate `nix-config` repository against
  its then-current source pin `1f433a421881031c407d84ab977ffda57d72c99c`, not
  against this source candidate: `nix flake check --no-build`,
  `nix build --no-link .#checks.x86_64-linux.nookbridge-service`, and
  `nix build --no-link .#checks.x86_64-linux.nookbridge-isolation` — **PASS**.
- Those external results must be rerun after the reviewed source is merged and
  the deployment pin is updated.

## Release status

This closes the lockfile-field inventory gap for the internal deployment
candidate. It does not authorize public distribution: the package remains
`private: true`, the package version remains `0.0.0-stage.0`, and the source
pin/deployment canary/recovery gates remain outstanding.
