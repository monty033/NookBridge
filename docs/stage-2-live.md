# Stage 2-live — explicit live Notesnook auth POC

This document describes the **Stage 2-live** proof-of-concept slice: the
explicit live Notesnook authentication provider, the lazy narrow real-core
factory that produces its handle, and the opt-in live auth runner that
drives the provider from a CLI boundary.

This slice is **offline-only**. No real Notesnook account, no real
credential, and no live network was exercised while building, testing, or
documenting it. The defaults preserved from Stage 2B guard the boundary:
ordinary `nookctl auth login` still resolves to a structured `deferred`
outcome.  The explicit operator-only `nookctl auth live-login` command now
exists, but is reached only with `NOOKBRIDGE_ENABLE_LIVE_AUTH=1`, an exact
`live-login` subcommand, and a real echo-disabled TTY.

The upstream compatibility tuple this slice is pinned against is the same
one Stage 0 and Stage 2B recorded:

- Notesnook monorepo commit: `c9c4936d9e8222b86204781cd1c93cdf2a1738d3`
- `@notesnook/core` version: `8.1.3`

See `docs/upstream-contract.md` for the exact pin provenance, the dual
commit/integrity record, and the corrected static-init language.

## Scope

In scope for this slice:

- the lazy narrow real-core factory at `src/core/notesnook-live-factory.ts`
- the explicit live Notesnook auth provider at
  `src/auth/live-notesnook-auth-provider.ts`
- the opt-in live auth runner at `src/auth/live-auth-runner.ts`
- the gated operator CLI wiring at `src/auth/admin-command.ts` and
  `src/auth/live-login-runtime.ts`
- the production `createStdioPrompt` TTY boundary and local runtime cleanup
- additive exports from `src/index.ts`
- focused offline tests under `tests/stage-2-live-gate.test.ts`,
  `tests/notesnook-live-factory.test.ts`, and
  `tests/stage-2-live-auth-provider.test.ts`

Out of scope, and explicitly **not** exercised by this slice:

- a real Notesnook account, real email, real password, real MFA code, or
  real refresh token;
- the real `@notesnook/core` runtime import path (the factory uses an
  injected module seam in tests, and the dynamic `await import(...)`
  fires only when an operator opts in with the real pinned package
  available);
- a generic transport, a generic core passthrough, signup, sync, SSE,
  push, attachment, or any other unbounded upstream surface;
- a real-account exercise or live-account S2 security review.

## Lazy `@notesnook/core` factory

The factory in `src/core/notesnook-live-factory.ts` is the **only** place
that runs `await import("@notesnook/core")` in NookBridge. The dynamic
import lives inside the exported function body, so:

- ordinary `import { ... } from "nookbridge"` consumers do **not** load
  the pinned real-core package and do **not** pay its network surface;
- the test harness uses the injected `module` option on the factory so
  `npm test` and the focused factory test remain hermetic;
- the factory validates every required setup dependency up front,
  constructs `new Database()` with the resolved module, synchronously
  calls the **instance** `setup(full options)`, and then awaits the
  **instance** `init()`. The shape was previously described as a static
  `Database.setup(...)` call; the real d.ts at the pinned commit exposes
  `Database` as a **constructable** class whose instance carries the
  `setup` and `init` methods.

The factory returns a **frozen** narrow handle. The handle exposes only:

- `db.kv.read(key)` / `db.kv.write(key, value)` / `db.kv.delete(key)` —
  the canonical upstream KV accessor (the `db.kv` field is callable and
  returns the KV surface; the provider never reaches for raw SQL or a
  storage passthrough);
- `db.user.authenticateEmail` / `authenticateMultiFactorCode` /
  `authenticatePassword` / `getUser` / `logout`;
- `db.token.getToken` / `_refreshToken`;
- the injected `cleanup` hook;
- a frozen `kind` discriminator so a hostile module cannot swap the
  handle class.

The handle does **not** expose a raw `Database`, a generic request,
transport, fetch, or mutation method. There is no method-passthrough and
no signup / sync / SSE escape hatch.

The canonical token persistence path is therefore **`db.kv.write("token", envelope)`**
followed by `db.kv.read("token")` on restore and `db.kv.delete("token")`
on logout. The envelope lives in upstream's SQL `KVStorage`; NookBridge
does not own a parallel token store.

## Login order

The provider follows the exact order documented in
`docs/upstream-contract.md`:

1. `core.user.authenticateEmail(email)` — the email round is always
   first, regardless of MFA.
2. If the email response's space-separated `scope` contains
   `auth:grant_types:mfa`, the provider calls the injected MFA supplier
   and then `core.user.authenticateMultiFactorCode(code, "app")`. The
   MFA round is conditional on the scope returned by step (a); the
   provider never assumes MFA from input alone.
3. `core.user.authenticatePassword(email, password)` — the provider
   uses the runner-supplied initial password first, then the
   `LivePasswordSupplier` on rejection. The provider never caches the
   password on its instance; the supplier yields the string exactly
   once and the runner zeroizes the underlying buffer.

The MFA branch is bounded by `maxAttempts` (default 3); the password
branch is bounded the same way. The provider never persists a password,
an MFA code, or an upstream error body.

## Refresh

The refresh path is **exactly** the pinned narrow seam:

1. `core.token._refreshToken(true)` — the `true` flag is the canonical
   "force-renew" flag the upstream token manager accepts at the pinned
   commit.
2. `core.token.getToken()` — reads the rotated envelope from the
   canonical upstream KV accessor.

The provider does not expose a public `refreshToken` method; it does
not perform a generic token operation; it does not cache the envelope
on its instance. A single refresh may be in flight per provider
instance; concurrent refresh races are guarded by an operation epoch
so a stale login/restore cannot resurrect a rotated envelope.

## Logout and cleanup

The logout path is exactly:

1. `core.user.logout(true)` — the upstream user-manager call that
   revokes the active session and tells upstream to clear local
   state. The `true` flag is forwarded by the narrow handle; the
   provider does not pass any additional argument.
2. `core.kv.delete("token")` — removes only the literal `token`
   key through the canonical KV accessor. The provider does not call
   `db.reset()` or any other generic destructive operation; it does
   not touch sibling keys.
3. The injected `LiveCleanupHook` — the only hook that owns local
   cleanup beyond the canonical KV key. The provider invokes this
   hook after upstream logout and after the KV removal, regardless
   of whether the earlier steps failed. The hook is the right place
   for env-specific teardown (state-dir scrub, key-store eviction,
   etc.).

The three steps are independent. A failure in any one does not skip
the others. The provider's categorical errors carry no token bytes,
no password bytes, no MFA code bytes, no email body, no upstream
error body, and no raw `token` value.

## Narrow handle, no generic transport

The factory handle is deliberately minimal:

- no raw `Database` reference is exposed;
- no `request` / `transport` / `fetch` method is exposed;
- no `collections` / `attachments` / `monographs` / `events` /
  `settings` / `sync` / `eventManager` / `eventSource` field is
  exposed;
- no signup, password change, MFA enrollment, MFA reset, account
  recovery, or device-registration method is exposed;
- the `db.kv` accessor is callable; the provider invokes it as
  `db.kv.write("token", envelope)` etc. There is no SQL passthrough
  and no generic key-value escape hatch.

The runner does not accept a real `NotesnookDatabase` either. It accepts
only the `LiveProviderFactory` closure that produces a
`LiveNotesnookAuthProvider` over the narrow handle. A caller cannot
hand the runner a generic core module and bypass the factory.

## Prompt-only credentials and zeroization

The runner collects credentials **only** through the injected
`SecretPrompt`. It never reads `process.argv`, `process.env`, or
`process.stdin` directly. The collected `Buffer` bytes are converted
to a string only for the immediate provider call or supplier call,
and every captured buffer is zeroized in a `finally` block before the
runner returns. One-shot supplier closures consume each captured
buffer exactly once and yield `null` thereafter so the provider's
retry loop terminates deterministically.

## Opt-in / default CLI boundary

The runner is **opt-in**. The default CLI path:

```text
nookctl auth login
```

still resolves to a structured `deferred` outcome. The separate path:

```text
NOOKBRIDGE_ENABLE_LIVE_AUTH=1 nookctl auth live-login
```

is the only CLI entry point that constructs the TTY prompt, local
PersistentStorage/key-store, and real-core factory. Forbidden argv/env
credential carriers are rejected before any of those resources are
initialized. The command prints only categorical, redacted status; it does
not print an email, user ID, token, password, or MFA code.

The factory is **opt-in** in the same sense. Ordinary
`import { ... } from "nookbridge"` consumers do not load
`@notesnook/core`; the dynamic `await import("@notesnook/core")` only
fires when `createNotesnookLiveCoreFactory(...)` is called by a caller
that supplies the real pinned package (or its injected-module test
double). The offline tooling and the Stage 2A mocked path keep working
without paying the cost — or the network surface — of the live module.

## Verification evidence

This slice's verification evidence is the focused + full test runs
that exercise the gated command, production runtime seams, narrow factory,
and live provider against injected fakes. The required commands, run inside
the pinned Nix
development shell, are:

```text
npx vitest run tests/notesnook-live-factory.test.ts
npx vitest run tests/stage-2-live-auth-provider.test.ts
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
git diff --check
```

The recorded outcomes for this slice are:

- `tests/notesnook-live-factory.test.ts` — focused factory tests covering
  the lazy-import seam, the constructable `Database.setup(options)` then
  `await init()` order, the callable `db.kv` accessor, the canonical
  `token` key, the narrow-handle freeze, and hostile upstream
  normalization.
- `tests/stage-2-live-auth-provider.test.ts` — focused provider tests
  covering the exact login/MFA/password order, refresh via
  `_refreshToken(true)` then `getToken`, logout + `token` removal +
  cleanup hook ordering, refresh/restore/logout race guarding,
  malformed-envelope rejection, public `refresh_token` absence, prompt
  zeroization, EOF vs. hostile prompt handling, and categorical-error
  hygiene.
- `tests/stage-2-live-gate.test.ts` — focused gate-ordering tests covering
  the explicit flag and subcommand, forbidden argv/env carriers, non-TTY
  failure before runtime initialization, success/error cleanup, deferred
  ordinary login, and an offline injected runtime construction seam.

## Explicit offline-only statement

**No real Notesnook account, no real credential, and no live network
call was exercised while building, testing, or documenting this slice.**
The factory's dynamic `@notesnook/core` import was not executed against the
real pinned package during this work; the factory and runtime tests substitute
an injected module double. The provider tests substitute an injected fake
core handle that records calls without contacting any service. The runner
tests inject a fake `SecretPrompt` that yields runtime-generated canary
buffers.

The command wiring exists and has been exercised only with fake providers,
fake prompts, and local temporary state. **No real account has been exercised
yet.**

The live-account S2 security checkpoint — including real core
initialization, live authentication, live token revocation/refresh,
transport security, secret provisioning, and deployment isolation —
remains deferred to a separately authorized review. Passing this
offline POC is evidence only for the narrow factory/provider/runner
boundary and its in-memory transitions; it is not a live-account
security review, does not constitute upstream support, and must not be
described as proof that live Notesnook authentication is safe or
enabled.
