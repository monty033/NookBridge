# Stage 2B — offline credential boundary

Stage 2B ships the interactive secret-input boundary and the
`nookctl auth <subcommand>` plumbing on top of Stage 1 / Stage 2A.
It is a **fully offline slice**: no live Notesnook network call, no
`@notesnook/core` runtime import, no credential persistence, and no
real account login.

## Scope of this slice

- `src/auth/secret-input.ts` exposes `collectEmail`, `collectPassword`,
  `collectMfaCode`, and the `SecretPrompt` seam.
- `src/auth/admin-command.ts` exposes `parseAuthCommand`,
  `formatAuthHelp`, and `runAuthCommand`. Every auth subcommand in this
  slice resolves to a structured **`deferred` outcome** with no
  credential handling and no PersistentStorage write.
- `src/cli.ts` adds the `nookctl auth <subcommand>` dispatcher on top
  of the existing `doctor` command. The doctor surface is unchanged
  and the `--state-dir` / `--endpoint` flags still work as before.

The CLI surface added in this slice:

```
nookctl auth login                 collect credentials interactively (deferred)
nookctl auth status                show local auth state          (deferred)
nookctl auth logout                clear local auth state          (deferred)
nookctl auth reset-local-client    wipe local auth state           (deferred)
nookctl auth help                  show this help
```

## Hard offline boundary

The following invariants are enforced in code **and** tested in
`tests/stage-2b.test.ts`. Any future reviewer who violates one of
them must update both the code and the test.

### 1. TTY requirement (fail-closed)

`createStdioPrompt()` THROWS when `process.stdin.isTTY !== true`.
The default prompt is never silently wired to a non-TTY pipe. Tests
inject a fake `SecretPrompt` instead — they never rely on a real TTY.

On non-POSIX platforms (currently anything other than `linux`,
`darwin`, `freebsd`) the prompt refuses to read at all, even if the
caller hands it a TTY-like stream. The message is categorical, no
fallback to a no-op echo strategy is attempted.

### 2. Terminal echo control (fail-closed POSIX strategy)

The Stage 2A draft of `secret-input.ts` mapped `setRawMode(false)` to
the secret-read path. That mapping is **not** a valid echo-disable on
POSIX terminals: raw mode and echo are independent `termios`
attributes, and `setRawMode(false)` leaves echo enabled. The corrected
implementation uses POSIX `stty`:

1. `stty -g` is invoked against the captured stdin fd to capture the
   *current* terminal state as a restore token (e.g.
   `2505:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0`).
   If `stty -g` fails or returns an empty token, the helper throws
   *before* any read is attempted. There is no "no-op fallback".
2. `stty -echo` is then invoked against the same fd. If it exits
   non-zero, the helper throws *before* any read is attempted. A
   broken or detached tty never silently falls through to an echo-on
   read.
3. After the read completes (success, EOF, or thrown error), echo is
   restored by passing the captured token back to `stty` so the
   terminal returns to exactly its prior state. Restoration runs in a
   `finally` block so the original error is never masked. Restoration
   failures are swallowed (we are already in finally) but surfaced
   through the audit sink registered via `setEchoAuditSink(…)` for
   operator diagnostics. The messages emitted to the audit sink are
   categorical ("echo restoration failed") and contain no secret bytes.

`child_process.spawnSync` is imported as
`import { spawnSync } from "node:child_process"` — ESM named import,
no `require`.

The terminal operations are bound to the captured stream's fd and
the captured `process.platform` value at prompt-construction time.
The constructor captures the stream, the stdout, the platform
identifier, and the `spawnSync` primitive **exactly once** and the
returned prompt NEVER re-reads `process.stdin`, `process.stdout`,
`process.platform`, or any global after returning — that is the seam
that keeps the test surface deterministic and the production code
audit-closed.
The public `SecretPrompt` seam remains narrow: a `writeLine` and a
`readSecretLine`, both pure functions over the seam's contract.

### 3. Non-TTY safety net

The runner in `admin-command.ts` (and the dispatcher in `cli.ts`)
**never** constructs a real TTY prompt for `auth help`, `auth status`,
`auth logout`, `auth reset-local-client`, the deferred `auth login`
branch, or parse-error paths. The prompt is only consulted when the
caller opts in to `exerciseLoginPipeline: true` — a test-only flag
that the production CLI never sets.

That means every non-login admin subcommand works in non-TTY contexts
(CI, scripts, containers, sshd-without-tty) and never touches
persistent state. Non-login admin commands are read-only with respect
to `PersistentStorage` and the on-disk key store.

### 4. Argv and env rejection

`parseAuthCommand` rejects any attempt to supply a credential through:

- CLI flags: `--password`, `--passwd`, `--mfa`, `--totp`, `--secret`,
  `--stdin-secret`, `--token`.
- Environment variables: `NOOKBRIDGE_PASSWORD`, `NOOKBRIDGE_PASSWD`,
  `NOOKBRIDGE_MFA`, `NOOKBRIDGE_TOTP`, `NOOKBRIDGE_SECRET`,
  `NOOKCTL_PASSWORD`, `NOOKCTL_MFA`.

The presence of any of these is a **hard error** (exit code 2), not a
silent ignore. Silent ignore would let the secret leak somewhere the
runner cannot see.

### 5. Zeroization and the JS string limitation

`SecretPrompt.readSecretLine` returns a `Buffer`. The returned buffer
is wrapped in a `CollectedSecret` that exposes a `zero()` method which
overwrites the buffer bytes with `0x00`. The helper zeroizes every
temporary buffer before the next iteration begins (or before
throwing, on failure paths):

- Password / MFA: the caller is responsible for `zero()`-ing the
  returned `CollectedSecret`. `runAuthCommand` does this for every
  secret it captures, in reverse order, before returning.
- Email: the temporary buffer is zeroed on **every** iteration —
  including the successful return path — because the caller receives
  the trimmed *string* rather than the buffer reference. The string
  representation cannot be erased; only the temporary buffer can.
- On `maxAttempts` exhaustion: every previously captured secret is
  zeroed in the runner before the iteration loop terminates. If
  `collectMfaCode` throws a non-EOF error mid-pipeline, the runner
  zeros the password before re-throwing.

**Important limitation.** JavaScript strings are immutable. Anywhere
the captured bytes pass through a `toString("utf8")` (the email
collector does this to return the user identifier), a copy of the
bytes lives on the V8 heap until the next garbage collection. The
`Buffer.fill(0)` mitigation is therefore a **best-effort** wipe of
the captured buffer, not a cryptographic erasure. The
`docs/engineering/stages/stage-2b.md` header comments and `CollectedSecret.zero()`
JSDoc reflect this honestly; the module does not claim stronger
guarantees.

### 6. Error hygiene

All thrown errors are **categorical**. They never include the
captured secret bytes, the prompt text, the typed-in line, or any
prefix that could carry the secret. Examples:

- `"password input ended before a value was entered"`
- `"password attempt 2 of 3 was empty"`
- `"failed to disable terminal echo (stty -echo exited with status 1): refusing to read a secret"`

The CLI dispatcher writes outcome messages to stdout/stderr using the
structured `DeferredAuthOutcome` payload, never the secret.

## Deferred to a later slice

The following items are explicitly **out of scope** for Stage 2B.
They will land in a later reviewed slice that wires the upstream
Notesnook core login API.

- Real account login via the upstream `@notesnook/core` `UserManager`
  and `TokenManager` contracts (mocked first, then live behind a
  feature flag and an additional security review).
- Real credential verification against `api.notesnook.com`.
- MFA / TOTP enrollment and challenge response.
- Token persistence and refresh against an account.
- Real `logout` / `reset-local-client` that mutates
  `PersistentStorage`.
- Real `status` that reads a session record out of `PersistentStorage`.

The runner today returns a `DeferredAuthOutcome` with a categorical
message for each of these subcommands so that the CLI surface, the
help text, and the parser behaviour are all stable and reviewable
**before** any live authentication is wired in.

## Test surface (`tests/stage-2b.test.ts`)

The Stage 2B test suite is **fully offline**:

- It does not spawn a real TTY.
- It does not call `stty` (every shell-out is routed through the
  `__setSpawnSyncForTest` seam).
- It does not read `process.env` in any meaningful way.
- It does not import `@notesnook/core` or open a `PersistentStorage`.
- It uses a `createFakePrompt` helper with a queue of pre-canned
  `Buffer | null` entries so every read is deterministic.
- Credential labels in the test file are **generated at runtime** and
  labelled `stage-2b-test-password-N`, `stage-2b-test-mfa-N`,
  `stage-2b-user-N@example.test`. They are diagnostic tokens, not
  real secrets. We deliberately do not commit a literal canary to
  source so the repository's scanner policy cannot flag the file.

The tests cover:

- Echo control: capture / disable / restore on success, EOF, and
  read-time failure. Fail-closed on `stty -g` non-zero exit, empty
  `stty -g` token, `stty -echo` non-zero exit, and on non-POSIX
  platforms.
- Echo-restore failures are surfaced through the audit sink.
- Constructor-seam regression (captured stream / fd / restore):
  the prompt reads from the injected `PassThrough` even if
  `process.stdin` is later swapped to a different stream; all three
  `stty` calls receive `stdio = [capturedFd, "pipe", "pipe"]`;
  echo is restored after both EOF and a read-time error; the audit
  sink emits a categorical message with no runtime secret-like
  bytes, fd number, or test label in it.
- Secret collection: success, retry-on-empty, retry exhaustion, EOF,
  malformed email, and zeroization on every iteration.
- Runner plumbing: `parseAuthCommand` rejects `--password` and the
  forbidden env vars; `runAuthCommand` returns the deferred outcome
  for `status`, `logout`, `reset-local-client`, and the default
  `login` branch without touching a prompt.
- `exerciseLoginPipeline` collects email + password + optional MFA,
  zeroes everything before returning, handles MFA EOF gracefully,
  and zeroes the password if MFA fails for a non-EOF reason.
- Stdout / stderr never contain the captured password or MFA label.
- CLI dispatcher: `auth help`, `auth status`, `auth logout`,
  `auth reset-local-client` all run without a TTY prompt, do not
  touch persistent state, and emit exit code 0 / 2 / 2 / 2 for the
  success / unknown-subcommand / forbidden-flag cases.
- Doctor regression: `nookctl doctor --state-dir …` continues to
  work exactly as before.

## Backwards compatibility

Stage 1 and Stage 2A surfaces are unchanged:

- `nookctl doctor [--state-dir <path>] [--endpoint <url>]` still
  works and still produces the same exit-code semantics.
- All exports from `src/index.ts` that existed before this slice
  remain exported with the same names and types.
- The `baseline` object, the version constants, and the `IStorage`
  adapter seam are untouched.

The new exports (`createStdioPrompt`, `collectEmail`,
`collectPassword`, `collectMfaCode`, `parseAuthCommand`,
`formatAuthHelp`, `runAuthCommand`, and their associated types) are
additive. No existing import path has changed.

## Next slice (Stage 2B-live)

The next slice will land the real account login pathway:

1. Add a mocked `UserManager` / `TokenManager` boundary (mirroring
   the upstream `@notesnook/core` shape) under
   `src/auth/upstream/`.
2. Wire `runAuthCommand`'s `login` branch to call the mocked
   boundary instead of returning `deferred`. Add a feature flag and
   an additional security review checklist.
3. Once the mocked boundary is stable and reviewed, switch to the
   real `@notesnook/core` import path. Update `docs/engineering/stages/stage-2b-live.md`
   to describe the new boundary.
4. Land `auth status`, `auth logout`, `auth reset-local-client` as
   thin wrappers over `PersistentStorage` reads and writes.

Until that slice lands, **no real Notesnook credentials are accepted,
processed, transmitted, or persisted** by NookBridge.
