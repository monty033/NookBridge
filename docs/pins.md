# NookBridge — pinned versions (Stage 0)

This file is the single human-readable record of every external version
NookBridge pins in `package.json` and `flake.nix`. It is the source of
truth for the Stage 0 compatibility-tuple gate.

**Do not edit one without editing the others.** If a value changes here,
the corresponding value in `package.json`, `flake.lock`, `src/index.ts`,
and (if upstream changes) `docs/upstream-contract.md` must change too.

## Upstream Notesnook

| Item | Value | Source of truth |
|---|---|---|
| Notesnook monorepo commit SHA | `c9c4936d9e8222b86204781cd1c93cdf2a1738d3` | `src/index.ts` (`PINNED_NOTESNOOK_MONOREPO_SHA`); see also `docs/upstream-contract.md` |
| `@notesnook/core` version | `8.1.3` | `src/index.ts` (`PINNED_NOTESNOOK_CORE_VERSION`); will be added to `package.json` in Stage 1 |
| Core license | `GPL-3.0-or-later` | `docs/licensing.md` |

The SHA above was the HEAD of the upstream `streetwriters/notesnook`
checkout used by the Stage -1 disposable harness under
`/tmp/nookbridge-stage-minus-1/upstream/`. The Stage -1 harness is
intentionally NOT part of this repository; this file records the
provenance instead.

## Runtime

| Item | Value | Source of truth |
|---|---|---|
| Node.js | `22.23.2` (engine: `>=22.23.0 <23.0.0`) | `package.json` (`engines.node`), `flake.nix` (`nodejs_22`) |
| better-sqlite3-multiple-ciphers | `11.5.0` | `package.json` (`dependencies`) |
| sqlite-better-trigram | `0.0.3` | `package.json` (`dependencies`) |
| sqlite-regex | `0.2.4-alpha.1` | `package.json` (`dependencies`) |
| sqlite3-fts5-html | `0.0.4` | `package.json` (`dependencies`) |

Versions above are taken from the `@notesnook/core@8.1.3` `devDependencies`
block, since Notesnook's own E2E test harness is the practical
integration blueprint. They were validated together in Stage -1.

## Build / tooling

| Item | Value | Source of truth |
|---|---|---|
| TypeScript | `5.7.2` | `package.json` (`devDependencies`) |
| Vitest | `2.1.8` | `package.json` (`devDependencies`) |
| ESLint | `9.17.0` | `package.json` (`devDependencies`) |
| `@typescript-eslint/parser` | `8.18.2` | `package.json` (`devDependencies`) |
| `@typescript-eslint/eslint-plugin` | `8.18.2` | `package.json` (`devDependencies`) |
| `eslint-config-prettier` | `9.1.0` | `package.json` (`devDependencies`) |
| Prettier | `3.4.2` | `package.json` (`devDependencies`) |
| `@types/node` | `22.10.2` | `package.json` (`devDependencies`) |

## Nix

| Item | Value | Source of truth |
|---|---|---|
| Nixpkgs revision | `5880666fd9eb563038431edb35c2d0aa595884e6` | `flake.nix` (`inputs.nixpkgs.url`), `flake.lock`, `src/index.ts` (`PINNED_NIXPKGS_REV`) |
| NixOS release containing this rev | `26.05.20260820.5880666` | confirmed via `nix eval github:NixOS/nixpkgs/<rev>#lib.version` |
| Reference host | `x86_64`, NixOS 26.05.20260820.5880666 | per Stage -1 brief |
| `nodejs_22` version in this rev | `22.23.2` | confirmed via `nix eval --impure '(import <nixpkgs> {}).nodejs_22.version'` |

The `flake.lock` is checked in so the devShell resolves byte-identically
across machines. `nix flake lock --refresh` is intentionally NOT run
during Stage 0; any refresh must be a deliberate, reviewed commit.

## Bridge revision

| Item | Value |
|---|---|
| NookBridge baseline version | `0.0.0-stage.0` (`STAGE_0_VERSION` in `src/index.ts`) |
| Branch | `stage-0-baseline` |
| Base merge commit | `49bd24bf69e9cf4d7a572989d331262e0ea56f4c` (the docs-bootstrap merge of PR #1 into `main`) |

The bridge does not yet have a real semver — Stage 0 is the
reproducibility baseline, not a released version.
