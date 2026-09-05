# NookBridge — licensing inventory (Stage 9 review baseline)

This is the current license inventory for the implementation plan's release
and distribution gates. It exists for two reasons:

1. To make the license posture of every dependency NookBridge pulls in
   visible at a glance.
2. To be the release-gate checklist for any future public distribution.

## Project license

NookBridge is licensed under **GPL-3.0-or-later**. The root `LICENSE`
file is the canonical text. The `package.json` `license` field and
`SPDX-License-Identifier` carry the same metadata.

The choice is deliberate: `@notesnook/core` and every other Notesnook
package NookBridge directly imports are GPL-3.0-or-later, so a permissive
NookBridge license would create a copyleft conflict downstream. Aligning
licenses removes that conflict and matches upstream's posture.

## Upstream Notesnook packages (Stage 0 / Stage 1 inventory)

The Stage -1 disposable harness validated against the
`streetwriters/notesnook` monorepo at commit
`c9c4936d9e8222b86204781cd1c93cdf2a1738d3`. Every package listed below
was verified by reading the `package.json` of that pinned checkout.

| Package | Version (at pinned commit) | License | Used by NookBridge | Notes |
|---|---|---|---|---|
| `@notesnook/core` | `8.1.3` | GPL-3.0-or-later | Stage 1 (runtime) | The pinned internal core. |
| `@notesnook/crypto` | `2.1.3` | GPL-3.0-or-later | Stage 1 (transitive via core) | libsodium wrapper; `core` depends on it via `file:../crypto`. |
| `@notesnook/intl` | `1.0.0` | GPL-3.0-or-later | Stage 1 (transitive via core) | `file:../intl` reference. |
| `@notesnook/logger` | `2.1.3` | GPL-3.0-or-later | Stage 1 (transitive via core) | `file:../logger` reference. |
| `@notesnook/sodium` | `2.1.3` | GPL-3.0-or-later | Stage 1 (transitive via core) | Used through `@notesnook/crypto`. |
| `@notesnook/streamable-fs` | `2.1.3` | GPL-3.0-or-later | Stage 1 (transitive via core) | Streamable storage helpers. |
| `@notesnook/common` | `2.1.3` | GPL-3.0-or-later | Stage 1 (transitive via core) | Common utilities. |
| `@notesnook/editor` | `2.1.3` | GPL-3.0-or-later | Stage 1+ (only if NookBridge exposes editor helpers) | Not pulled in by core; reserved for Stage 1+ consideration. |

`@notesnook/core` itself depends on a long transitive tail (see
`/tmp/nookbridge-stage-minus-1/upstream/packages/core/package.json`).
Stage 1 will run `npm ls` against the pinned core and add transitive
licenses here.

## Notesnook sync server (separate license)

The Notesnook **sync server** is not a NookBridge dependency; it is the
remote service `@notesnook/core` talks to when running sync. It lives at
`https://github.com/streetwriters/notesnook-sync-server` and is licensed
under **AGPL-3.0-or-later** at the upstream HEAD we reviewed for Stage
-1.

The distinction matters for distribution posture:

- NookBridge (this repo): **GPL-3.0-or-later**.
- `@notesnook/core` and its monorepo siblings: **GPL-3.0-or-later** at
  the pinned commit.
- Notesnook sync server: **AGPL-3.0-or-later** upstream; NookBridge does
  not bundle it and only talks to it over HTTPS as a network client.

If NookBridge ever ships its own bundled sync server (it does not
plan to at Stage 0 / Stage 1), the AGPL-3.0-or-later obligation must be
re-evaluated separately. Stage 0 explicitly rules this out.

## Direct runtime dependencies (`package.json` `dependencies`)

| Package | Version | License | Notes |
|---|---|---|---|
| `@notesnook/crypto` | `2.1.3` | GPL-3.0-or-later | Upstream Argon2id password-grant derivation used by live authentication. |
| `@modelcontextprotocol/sdk` | `1.30.0` | MIT | Hermes-facing MCP protocol implementation. |
| `@streetwriters/kysely` | `0.27.4` | MIT | Pinned database query/type support used by the client boundary. |
| `better-sqlite3-multiple-ciphers` | `11.5.0` | MIT | Encrypted SQLite driver; required by `@notesnook/core` at the pinned commit. |
| `sqlite-better-trigram` | `0.0.3` | Public Domain (per upstream `package.json`) | Trigram tokenizer for FTS5; required by `@notesnook/core`. |
| `sqlite-regex` | `0.2.4-alpha.1` | MIT OR Apache-2.0 | License field from the committed lockfile. |
| `sqlite3-fts5-html` | `0.0.4` | Public Domain | License field from the committed lockfile. |

The license fields for `sqlite-regex` and `sqlite3-fts5-html` are
recorded from the committed `package-lock.json` entries at the pinned
versions. The complete transitive tree still requires a separate
pre-distribution export and human review.

## Build / dev dependencies (`package.json` `devDependencies`)

All pinned to exact versions in `package.json`. Stage 0 does not bundle
or distribute any of them; they only run on developer machines and CI.

| Package | Version | License (per upstream) | Notes |
|---|---|---|---|
| `typescript` | `5.7.2` | Apache-2.0 | Compiles `.ts` to `.js`. |
| `vitest` | `2.1.8` | MIT | Test runner; matches `@notesnook/core`'s pinned Vitest version. |
| `eslint` | `9.17.0` | MIT | Lint. |
| `@typescript-eslint/parser` | `8.18.2` | MIT | TS parser for ESLint. |
| `@typescript-eslint/eslint-plugin` | `8.18.2` | MIT | TS rules for ESLint. |
| `eslint-config-prettier` | `9.1.0` | MIT | Disables stylistic rules that conflict with Prettier. |
| `prettier` | `3.4.2` | MIT | Formatter. |
| `@types/node` | `22.10.2` | MIT | Node typings. |

These are dev-only and do not flow into any shipped artifact.

## Pre-distribution compliance review (release gate)

Before NookBridge is distributed **publicly** — meaning a release
artifact is published to npm, a Docker registry, NixOS channels, or any
other public surface that exposes NookBridge source or binaries to a
third party — the following must be true:

1. The full transitive license tree is rendered (e.g. `npx license-checker --production --csv`)
   and reviewed against this inventory. Any license not listed here is a
   blocker until it is added.
2. Any **AGPL-3.0-or-later** transitive is treated as a forcing
   function: either remove the transitive or escalate the choice to a
   documented architectural decision.
3. The root `LICENSE` file remains GPL-3.0-or-later text.
4. `package.json` `license` and `SPDX-License-Identifier` fields remain
   GPL-3.0-or-later.
5. The `docs/upstream-contract.md` "pinned internal core vs stable SDK"
   distinction is re-evaluated against any new upstream statement.

## Stage 9 release status

The committed `package-lock.json` contains exact direct dependency versions and
license fields for the current internal Nix deployment candidate. A complete
transitive license export and human review have not yet been run, so the public
distribution gate remains **open**. NookBridge is currently `private: true`;
no public npm, Docker, or Nix channel artifact is claimed.

## Historical Stage 0 → Stage 1 deltas

Stage 1 adds `@notesnook/core` as an explicit runtime dependency in
`package.json`. When it does, this document must be updated with:

- A row in the upstream Notesnook table confirming `@notesnook/core@8.1.3`
  is now installed from the same pinned commit (likely via a
  `git+https://github.com/streetwriters/notesnook.git#<sha>` dependency
  or a vendored source).
- The full transitive license list (`npm ls --all --json | jq ...`),
  sorted by license, with any non-GPL/MIT/Public Domain entries
  highlighted as blockers.

Until Stage 1 lands, the inventory above is the Stage 0 ground truth.
