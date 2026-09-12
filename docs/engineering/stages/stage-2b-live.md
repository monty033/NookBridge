# Stage 2B-live — offline Notesnook authentication provider

This document describes the Stage 2B-live **offline provider slice**. It does
not enable live Notesnook authentication. The implementation uses an injected
structural fake of the pinned Notesnook core boundary and a local `IStorage`
implementation; it never imports `@notesnook/core`, opens a socket, contacts a
Notesnook account, or accepts a real account credential through the CLI.

## Scope and pinned upstream boundary

The provider is checked against the upstream compatibility tuple already pinned
by NookBridge:

- Notesnook monorepo commit:
  `c9c4936d9e8222b86204781cd1c93cdf2a1738d3`
- `@notesnook/core`: `8.1.3`

The production-facing seam is deliberately narrow. `createNotesnookAuthProvider`
accepts only an injected `NotesnookDatabaseHandle` with these structural paths:

- `core.user.authenticateEmail(email)`
- `core.user.authenticateMultiFactorCode(code, "app")`
- `core.user.authenticatePassword(email, password)`
- `core.user.getUser()` and `core.user.logout(clearLocal)` as part of the
  validated upstream user-manager shape
- `core.tokenManager.getToken()` and the exact private upstream refresh seam
  `core.tokenManager._refreshToken(forceRenew)` as part of the validated
  token-manager shape
- a required `clearLocalState()` seam, supplied by the caller and invoked only
  after upstream logout and removal of `kv.token`; construction fails closed if
  this destructive boundary is absent

There is no generic request, transport, method-passthrough, signup, sync, or
live-core escape hatch. The test fixture implements these methods in memory and
records calls without contacting any service.

## Exact mocked call sequences

The provider preserves the pinned authentication order:

1. **Login without MFA**
   `core.user.authenticateEmail(email)` →
   `core.user.authenticatePassword(email, password)`.
2. **Login with MFA**
   `core.user.authenticateEmail(email)` →
   `core.user.authenticateMultiFactorCode(code, "app")` →
   `core.user.authenticatePassword(email, password)`.
   The email response's space-separated `scope` controls this branch; the
   `auth:grant_types:mfa` scope marker requires the MFA call. MFA input is
   bounded to the configured maximum (three by default), and password retry is
   likewise bounded.
3. **Refresh**
   `core.tokenManager._refreshToken(true)`. This is the exact narrow seam; the
   public provider does not expose a `refreshToken` method or generic token
   operation. Only one refresh may be in flight per provider instance; a
   competing call is rejected rather than queued.
4. **Restore after restart**
   `storage.read("kv.token")` followed by local envelope validation and
   translation. Restore does not perform a fresh login or an upstream call.
5. **Logout**
   `core.user.logout(true)` is attempted first. Regardless of whether that
   upstream call fails, the provider then attempts `storage.remove("kv.token")`
   and then attempts the required injected `clearLocalState` hook. Cleanup attempts are
   independent, and categorical provider errors never include upstream error
   text or secret values.

## Persistence and translation boundary

A successful upstream auth or refresh response must be a complete token
envelope with `access_token`, numeric positive `t`, positive `expires_in`,
string `scope`, and non-empty `refresh_token`. The provider validates and
translates it **before** calling `storage.write("kv.token", envelope)`. A
malformed or already-expired response therefore cannot overwrite the prior
persisted envelope.

The encrypted storage boundary is the sole persistence location for the
refresh-capable upstream envelope, under the exact key `kv.token`. Passwords,
MFA codes, and upstream response/error bodies are never written there. The
provider has no instance password cache.

The public `AuthSession` returned to `AuthCoordinator` contains only:

- an opaque `accessToken`;
- `userId` derived without exposing token fields;
- `issuedAt`; and
- `expiresAt`.

It intentionally contains no `refresh_token`. Upstream errors are normalized to
categorical messages, and provider log records contain only status and opaque
session identifiers. The injected provider clock is used for expiry checks, so
offline tests do not depend on wall-clock time.

## Restart, refresh, and logout semantics

A restart is modelled by constructing a new provider and new fake core handle
over the same encrypted `IStorage`. `restoreSession()` rehydrates and strictly
validates the envelope from `kv.token`; it returns `null` only when the key is
absent. Present malformed or expired local state fails with a stable categorical
validation error. When the injected clock is past the restored session deadline,
the caller can invoke `refresh()`, which rotates the envelope through the mocked
`_refreshToken(true)` path and persists only after validation.

A failed refresh is fail-safe: it returns a categorical error and leaves the
last persisted envelope untouched. Concurrent refreshes have a single
Login and refresh persistence carries a provider-local operation epoch:
login captures its generation before its initial logout wait, and every
subsequent upstream/MFA/password await checks that generation before the next
authentication step. Starting logout therefore cancels a login before it can
continue authentication or persistence. The critical-section guard
serializes writes/removal, checks the epoch both before and after the awaited
write, and removes a value written by an invalidated operation before
releasing the lock; logout then performs its own idempotent cleanup. Restore
likewise captures its generation synchronously before its initial wait and
returns `null` for any stale read/validation rather than rehydrating a session.
Thus logout cannot be followed by a stale `kv.token` write, authenticated
restore result, or successful stale auth result. `AuthCoordinator` generation/
race semantics remain owned by `AuthCoordinator`; this provider does not alter
them.

Logout is also fail-safe for local state. The provider attempts upstream
revocation, removes `kv.token` even if revocation fails, and attempts the local
clear hook even if either earlier operation failed. `AuthCoordinator` clears
its in-memory state before awaiting provider logout, so a provider failure does
not leave an authenticated coordinator state behind.

## Offline test scope and gates

`tests/stage-2b-live-auth.test.ts` uses runtime-generated synthetic values and a
fake in-memory or encrypted `PersistentStorage` fixture. It currently contains
50 tests and covers the exact
login/MFA/password order, bounded retries, expiry under injected clocks,
refresh failure and concurrency, restart rehydration, logout cleanup,
deferred-write and pre-wait supersession, deferred restore/logout cleanup,
throwing-logger normalization, malformed
handle/envelope rejection, public refresh-token absence, and credential/log
hygiene. The CLI `auth login` path remains a structured `deferred` outcome.

The required verification is run inside the pinned Nix development shell, in
this order:

```text
nix develop --command npx vitest run tests/stage-2b-live-auth.test.ts
nix develop --command npm test
nix develop --command npm run typecheck
nix develop --command npm run lint
nix develop --command npm run format:check
nix develop --command npm run build
git diff --check
```

## Explicit live deferrals

This slice does **not** prove or enable any live-account behavior. The
following remain deferred to a separately authorized and independently reviewed
live stage (including account S2):

- importing and initializing the real `@notesnook/core` runtime;
- constructing its real platform/storage/key-store adapters;
- real Notesnook endpoint, TLS, redirect, and transport behavior;
- live email/password/MFA verification and token rotation;
- live token revocation and account logout behavior;
- production secret provisioning, service isolation, and deployment wiring;
- CLI wiring that accepts or processes real account credentials.

Passing this offline slice is evidence only for the mocked provider boundary and
its local state transitions. It is not a live-account security review, does not
constitute upstream support, and must not be described as proof that live
Notesnook authentication is safe or enabled.
