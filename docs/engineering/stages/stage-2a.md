# Stage 2A — offline authentication and core adapter seam

Stage 2A is a bounded, offline-only vertical slice. It adds the plumbing
needed to exercise authentication state and the Notesnook core initialization
boundary without an account, credentials, network transport, or a runtime
`@notesnook/core` dependency.

## Included

- `AuthCoordinator` models `signed-out`, `authenticated`, and `expired`
  states, with login, status/expiry detection, refresh, and logout transitions.
- `MockAuthProvider` is explicitly a deterministic test provider. It accepts
  non-empty mock credentials, does not retain them, and issues clearly labeled
  fake sessions. It has no HTTP, account, MFA, or token-persistence behavior.
- `NotesnookCoreAdapter` accepts an injected upstream-compatible module or
  factory plus the existing `IStorage` implementation. Its only operation is
  the documented `Database.setup({ storage }).init()` sequence. The adapter
  itself performs no network calls, but the injected, caller-controlled core
  implementation may have side effects (including network access).

## Security and offline invariants

Credentials and session tokens are memory-only values in this slice. The auth
boundary has no storage dependency and never writes credentials or tokens to
`PersistentStorage`. Auth log records contain only event/status metadata and a
stable mock user identifier; they do not contain passwords or session tokens.
The adapter imports neither `@notesnook/core` nor any live Notesnook service,
and its tests use a fake core and a fake storage implementation. No network
call is made by the adapter itself or required by its contract. Callers are
responsible for ensuring an injected core implementation is offline-safe when
offline behavior is required; injected `setup`/`init` code remains caller-
controlled and may have side effects.

The mock provider is not suitable for production authentication. The
`offline-mock` names are intentional so it cannot be mistaken for an account
provider.

## Deferred to Stage 2B

Real interactive account login, MFA/TOTP, credential handling, token
persistence and refresh against an account, logout/relogin with real
credentials, and all live Notesnook network calls remain deferred to Stage 2B.
Those capabilities require a separate security and upstream-contract review.
