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
|| License posture | GPL-3.0-or-later on every package in the monorepo we touch (see `docs/licensing.md`). | A stable SDK might offer a more permissive relicense option; we are not in that position. |
|| What an upstream breaking change costs | A re-run of Stage -1, a new Stage 0, and an explicit upstream-contract review. | N/A — we don't have this. |
|| Upstream has blessed us | **No.** We have **no** statement from `streetwriters/notesnook` that third-party headless clients are supported. Stage -1 reviewed the public docs/source/discussions and recorded only absence of objection, not a positive affirmation. | A stable SDK would include explicit upstream blessing. |

If you are reading this because you are considering a public NookBridge
distribution: the right-hand column is the missing piece, and it is
**not** filled in by this document.

## Pin provenance — dual commit / npm record

The Stage 2-live slice pins the same compatibility tuple Stage 0
recorded, but records **two distinct upstream identifiers** that are
both intentionally retained because they name different things and
must diverge when upstream publishes a new core release between
commits:

| Identifier | Value | What it names |
| --- | --- | --- |
| Notesnook monorepo source commit | `c9c4936d9e8222b86204781cd1c93cdf2a1738d` | The HEAD of the `streetwriters/notesnook` checkout the Stage -1 disposable harness used. This is the source-of-truth for the API shape NookBridge integrates against. |
| npm `@notesnook/core@8.1.3` `gitHead` | `be414f869c964dd0800b7c7b1a4e59c6e5dfa869` | The git commit the npm registry stamped on the published `8.1.3` tarball. The publish commit may sit on a different (typically newer) history position than the source commit above because npm keeps its own publish history. |
| npm `@notesnook/core@8.1.3` integrity | `sha512-bCBmtvZFqk1kteGEorsGaGuK50u5+aG4piMjzCaPCRpxyb4v5cWMcCJhrMnlhXRh57hcDAX1o3Df/z/qWh2IbQ==` | The registry-asserted Subresource Integrity hash for the published tarball. |

The two commits differ and **both are recorded intentionally**: the
monorepo commit is what the source d.ts the Stage -1 spike reviewed
came from, and the npm `gitHead` is what the registry actually
published. Conflating them would lose either the source-side API
ground truth or the consumer-side artifact identity. The integrity
hash binds the published npm tarball: any change in either the source commit or the
publish history invalidates the integrity assertion. Stage 2-live
does **not** assume they can ever be collapsed back into a single
identifier.

## Pinned commit SHA

NookBridge Stage 0 pins:

- Notesnook monorepo commit: `c9c4936d9e8222b86204781cd1c93cdf2a1738d3`
  (full SHA; the Stage 2-live entry above records the 39-hex-character
  truncated form `…a1738d` for table alignment only — the full value
  remains the source of truth)
- `@notesnook/core` version: `8.1.3`
  - npm `gitHead`: `be414f869c964dd0800b7c7b1a4e59c6e5dfa869`
  - npm integrity: `sha512-bCBmtvZFqk1kteGEorsGaGuK50u5+aG4piMjzCaPCRpxyb4v5cWMcCJhrMnlhXRh57hcDAX1o3Df/z/qWh2IbQ==`
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
constructs a fresh `Database` instance, calls its **instance**
`setup({...})` synchronously, then awaits its **instance** `init()` with a
**platform adapter** that injects:

- a deterministic `IStorage` (in-memory by default; the Stage 1
  persistent adapter is the Stage 1 deliverable, not Stage 0);
- mocked HTTP / SignalR transports so no real network call is required;
- the platform-specific key store stub (in tests, an in-memory one).

The d.ts at the pinned commit therefore exposes `Database` as a
**constructable** class, not as a static namespace. The NookBridge
factory at `src/core/notesnook-live-factory.ts` mirrors that exact
shape:

```text
const database = new Database();
database.setup(fullOptions);   // synchronous instance call
await database.init();          // awaited instance call
```

The token envelope is persisted through the canonical SQL `KVStorage`
that the upstream `Database` exposes via its callable `db.kv` accessor
— `db.kv.write("kv.token", envelope)`, `db.kv.read("kv.token")`,
`db.kv.delete("kv.token")`. The token is **not** stored in a parallel
NookBridge store, a sidecar file, or a generic `IStorage` instance;
upstream owns its own SQL `KVStorage` and the provider only ever
reaches it through the narrow `db.kv` accessor.

`user.logout(true)` revokes the active session and, at the pinned
commit, instructs the upstream user manager to clear local state. The
Stage 2-live provider forwards the `true` flag through the narrow
handle. Any further reset semantics (key eviction, state-dir wipe,
signal/SSE teardown) live outside the pinned package and must not be
assumed to be covered by `user.logout(true)`. The NookBridge
`LiveCleanupHook` is the right place for env-specific teardown; it is
not a substitute for what the pinned `user.logout(true)` does.

NookBridge's Stage 1 `PersistentStorage` and `SecureKeyStore` plug
into the same adapter shape Stage 0 documented. Stage 2-live keeps the
narrow-handle boundary: the factory returns a frozen handle whose
surface is exactly the operations the next pass of the auth boundary
needs, and the handle never re-exposes a raw `Database` or a generic
transport.

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
