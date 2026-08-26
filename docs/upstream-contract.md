# NookBridge — upstream contract (Stage 0)

This document records what NookBridge assumes about its upstream dependency
(the Notesnook monorepo and `@notesnook/core`) and what it does **not**
assume. It exists so that anyone reading the code or considering a public
distribution can distinguish "this is how it works today" from "this is a
guarantee we have from upstream".

## Two distinct things — do not conflate them

NookBridge consumes `@notesnook/core` as an **internal, pinned, source-of-truth
library** that Notesnook's own test harness and CLI binaries also import.
It does **not** consume `@notesnook/core` as a **stable, supported,
third-party SDK**. Conflating the two would be a security-and-correctness
bug.

| | Pinned internal core (what we have) | Stable supported SDK (what we do NOT have) |
|---|---|---|
| Semver compatibility promise | **No.** NookBridge is locked to a specific upstream commit SHA and the matching `@notesnook/core` version. Bumping either requires a new Stage 0 evaluation. | A stable SDK would publish a SemVer API contract and migration notes. |
| Compatibility scope | Single pinned commit (`c9c4936d9e8222b86204781cd1c93cdf2a1738d3`, `@notesnook/core@8.1.3`). | A stable SDK would promise compatibility across a version range. |
| API surface we depend on | Whatever `Database.setup(...)`, `init()`, content helpers, and sync coordinator internals happen to look like at that commit. | A stable SDK would document the public API. |
| License posture | GPL-3.0-or-later on every package in the monorepo we touch (see `docs/licensing.md`). | A stable SDK might offer a more permissive relicense option; we are not in that position. |
| What an upstream breaking change costs | A re-run of Stage -1, a new Stage 0, and an explicit upstream-contract review. | N/A — we don't have this. |
| Upstream has blessed us | **No.** We have **no** statement from `streetwriters/notesnook` that third-party headless clients are supported. Stage -1 reviewed the public docs/source/discussions and recorded only absence of objection, not a positive affirmation. | A stable SDK would include explicit upstream blessing. |

If you are reading this because you are considering a public NookBridge
distribution: the right-hand column is the missing piece, and it is
**not** filled in by this document.

## Pinned commit SHA

NookBridge Stage 0 pins:

- Notesnook monorepo commit: `c9c4936d9e8222b86204781cd1c93cdf2a1738d3`
- `@notesnook/core` version: `8.1.3`
- Nixpkgs revision: `5880666fd9eb563038431edb35c2d0aa595884e6`

These values are exported as typed constants from `src/index.ts` and
asserted by `tests/index.test.ts`. Changing them without re-running Stage
-1's native-runtime spike is a known-bad pattern.

## What upstream contract NookBridge relies on

1. **Internal import shape.** `@notesnook/core` exposes `Database`,
   `setup()`, `init()`, content helpers, and a sync coordinator in the
   shape they have at the pinned commit. Stage 1 will exercise this; the
   shape lives in upstream's own `packages/core` and is the integration
   blueprint.
2. **Encrypted SQLite contract.** The encrypted-SQLite behavior that
   `@notesnook/core` expects (sqlcipher, `cipher='sqlcipher'` +
   `key="..."` pragmas, FTS5 trigram/regex/html extensions loadable via
   `db.loadExtension`) is the same contract Stage -1 proved works under
   the pinned Nix devShell.
3. **License posture.** Every Notesnook package we touch is
   `GPL-3.0-or-later`. See `docs/licensing.md` for the inventory.
4. **No new upstream stability statement.** As of the pinned commit,
   upstream has not (to the best of our public-source review) issued a
   third-party SDK stability promise. Stage 0 records this explicitly.

## What NookBridge does **not** assume

- We do **not** assume `@notesnook/core` will continue to expose its
  current API in future releases.
- We do **not** assume any upstream support channel exists for
  NookBridge's headless usage pattern.
- We do **not** assume any upstream commitment to keep the FTS5
  extensions (`sqlite-better-trigram`, `sqlite3-fts5-html`,
  `sqlite-regex`) loadable forever.
- We do **not** assume that the upstream license posture will remain
  GPL-3.0-or-later (a future relicensing would require re-evaluating
  this whole baseline).

## Core init pattern upstream uses in E2E tests

Upstream's `@notesnook/core` E2E test harness (`packages/core/tests/...`)
drives `Database.setup({...}).init()` with a **platform adapter** that
injects:

- a deterministic `IStorage` (in-memory by default; the Stage 1
  persistent adapter is the Stage 1 deliverable, not Stage 0);
- mocked HTTP / SignalR transports so no real network call is required;
- the platform-specific key store stub (in tests, an in-memory one).

NookBridge's Stage 1 `PersistentStorage` and `SecureKeyStore` will plug
into the same adapter shape. Stage 0 only documents this; Stage 1
implements it.

## When this contract must be re-evaluated

Re-run Stage -1 and re-write this file if **any** of the following
changes:

- Notesnook monorepo upstream SHA advances.
- `@notesnook/core` version advances.
- Nixpkgs rev pinned in `flake.nix` advances.
- Any of the pinned native dependency versions (`better-sqlite3-multiple-ciphers`,
  `sqlite-better-trigram`, `sqlite-regex`, `sqlite3-fts5-html`) advances.
- Upstream ships a public third-party-SDK statement.

Until then, the values in `src/index.ts` and `docs/pins.md` are the
ground truth.
