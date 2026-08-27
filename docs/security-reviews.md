# NookBridge — security reviews (Stage 1)

This document records the Stage 1 S1 security checkpoint for NookBridge:
the initial finding, the applied fix, the deterministic and independent
review evidence, the follow-ups, and the surfaces that are explicitly
deferred because they do not exist yet. It is a durable audit ledger for
the local persistence surface only. Higher-stage reviews will be added
here as additional stages ship.

The S1 checkpoint scopes **only** the Stage 1 persistence implementation:
the encrypted SQLite handle in `src/storage/sqlite-storage.ts` and its Gate 1
test surface in `tests/stage-1-gate-1.test.ts`. This follow-up PR is prepared
on `stage-1-permission-fix`, with the code/test fix plus this ledger update
staged on top of the Stage 1 merge.

The historical S1 code/test fix did not alter other documents. The findings,
follow-ups, and deferrals captured here are the ones returned by the S1
reviewers; nothing in this document extends the security claim beyond that
scope. The current PR's documentation change is provenance bookkeeping and
was not covered by those historical code/test reviews.

## Staged diff under review

| Field | Value |
| --- | --- |
| Branch | `stage-1-permission-fix` |
| Branch tip before staged PR | `db6def3` |
| Historical Stage 1 merge reference | `26fb7bc` |
| Staged files | `docs/security-reviews.md`, `src/storage/sqlite-storage.ts`, `tests/stage-1-gate-1.test.ts` |
| Staged diff SHA-256 | Final combined hash is recorded in the PR verification receipt; it is not embedded here because this file is part of that hash. |

## Chronological ledger

1. **Stage 1 merge lands (historical context).** `upstream/main` advances
   to `26fb7bc`, which merges the Stage 1 persistent-storage foundation
   (`db6def3`).
2. **S1 initial review.** A reviewer flags that the encrypted SQLite
   file inherits the process umask on creation, leaving a brand-new
   database at mode `0644` on a typical `022` umask. The encrypted-at-rest
   header is therefore readable by any local account.
3. **Historical S1 fix proposed.** A staged change on
   `stage-1-persistent-storage` adds a `chmodSync(opts.dbPath, 0o600)` call
   immediately after
   `SqliteStorage` opens the database, re-tightens the existing-DB case
   as defence in depth, surfaces a hard error only when a freshly
   created DB cannot be locked down, and ships two regression tests in
   `tests/stage-1-gate-1.test.ts` (new-DB mode `0600`; loosened-DB
   re-tightened on reopen).
4. **Historical deterministic evidence regenerated** against the two-file
   code/test snapshot (S1 harness, full vitest, flake check, typecheck,
   lint, format, build, secret scan).
5. **Historical independent xhigh review** (`deleg_60f32e50`) on the exact
   two-file code/test snapshot records **PASS** with no security or logic
   findings.
6. **Historical red-team review** (`deleg_e9fb6468`) runs 17 assertions
   against the two-file code/test snapshot, records **PASS** with zero
   unexpected successes,
   and notes a secondary probe-harness limitation (equivalent
   recursive assertions passed inside the parent S1 harness).
7. **Current follow-up PR.** On `stage-1-permission-fix`, the DB existence
   check is moved before the database open, the source comment is corrected
   to claim chmod only for the main DB path, and sidecars remain deferred.
   This ledger records the three-file staged provenance; the final combined
   staged hash is recorded in the PR verification receipt.

## Initial S1 finding

| Field | Value |
| --- | --- |
| Stage | S1 (Stage 1) |
| Surface | `src/storage/sqlite-storage.ts` — `SqliteStorage` constructor |
| Severity | Non-blocking, defence-in-depth |
| Summary | `better-sqlite3-multiple-ciphers` honours the process umask when
   creating the encrypted SQLite file. Under a typical `022` umask the
   new DB lands at mode `0644`, leaving the encrypted-at-rest header
   readable by any local account. The same hazard applies to any
   operator who loosens permissions on a legacy DB and reopens it
   without a re-tightening pass. |

## S1 fix (exact)

The constructor now imports `chmodSync` and `existsSync`, records
whether the DB path existed **before** `new Database(opts.dbPath)`, then
runs `chmodSync(opts.dbPath, 0o600)` immediately after the database opens.
The chmod applies only to the main DB path; SQLite sidecars are explicitly
deferred hardening and are not handled by this Stage 1 fix.

- **Brand-new DB (`!existedBefore`):** if `chmodSync` fails, the
  constructor closes the underlying connection and rethrows the error
  so a configuration or filesystem error cannot silently leak an `0644`
  file to production.
- **Pre-existing DB:** if `chmodSync` fails, the error is swallowed;
  the on-disk bytes are still encrypted, but the file remains at the
  looser mode. The chmod call still runs on every open so an operator
  who loosened a legacy file cannot keep it that way indefinitely.

Two regression tests were added to `tests/stage-1-gate-1.test.ts`
under the "Gate 1.5 — encrypted database file permissions (mode 0600)"
block:

1. A fresh DB opens with mode `0600` (`lstatSync.mode & 0o777` → `600`).
2. An artificially loosened existing DB (`chmod 0644`) is re-tightened
   to `600` on next open.

## Evidence

The historical evidence below was produced against the two-file code/test
snapshot SHA
`85d6350a64b74661b765c150dee1899a32d85f83994e64bac6d8bf2d9433780a` on
branch `stage-1-persistent-storage`. That hash is preserved as a historical
code/test-only receipt; it is not the hash of the current three-file PR and
the historical reviews did not cover this documentation file. Receipts are
stored outside this repository and are referenced for audit only; this
document is the canonical, durable summary. The final combined staged hash
for the current `stage-1-permission-fix` PR is recorded in the PR
verification receipt rather than embedded here.

### Deterministic harness and project gates

The recorded project-gate commands and results are:

```text
nix flake check --no-build  PASS
npm test                  PASS: 29/29
npm run typecheck         PASS
npm run lint              PASS
npm run format:check      PASS
npm run build             PASS
```

The S1 deterministic harness and static secret scan were parent-controlled
checks rather than package scripts. Their recorded results are included
below; no unreproducible command line is invented here.

| Check | Result |
| --- | --- |
| S1 deterministic harness (cross-process lock, restart persistence, wrong-key behaviour, logger redaction, doctor redaction, no plaintext mirror, state `0700`, key `0600`, DB `0600`) | PASS |
| Full vitest suite | PASS: 29/29 |
| Flake check | PASS |
| TypeScript typecheck | PASS |
| ESLint | PASS |
| Prettier format | PASS |
| Build | PASS |
| Secret scan | PASS |

The S1 harness exercises the encrypted DB under umask `022` so the
brand-new-DB `0644` hazard is reproducible from a parent-controlled
process; the no-plaintext mirror assertion walks the on-disk DB bytes
and confirms the absence of known plaintext canaries without copying
them into test output.

### Historical independent xhigh review (permission fix)

| Field | Value |
| --- | --- |
| Review mode | Independent xhigh review |
| Delegation ID | `deleg_60f32e50` |
| Reviewed SHA-256 | `85d6350a64b74661b765c150dee1899a32d85f83994e64bac6d8bf2d9433780a` |
| Decision | PASS |
| Blocking security concerns | none |
| Logic errors | none |
| Non-blocking follow-ups | see [Findings and follow-ups](#findings-and-follow-ups) |

The xhigh review re-ran the deterministic gates above against the
exact historical two-file code/test diff and confirmed the new + existing-DB chmod calls and
their regression tests land cleanly. Receipt is stored at
`/var/lib/hermes/workspace/nookbridge-stage-1-s1-fix-review.json` outside this repo (audit
artifact only; not required at runtime).

### Historical red-team review (RT-1 / RT-2)

| Field | Value |
| --- | --- |
| Delegation ID | `deleg_e9fb6468` |
| Assertions | 17 |
| Unexpected successes | 0 |
| Decision | PASS |

Covered surfaces:

- encrypted DB mode under umask `022`;
- loosened-DB re-tightening on reopen;
- plaintext canary absence in raw DB bytes;
- wrong-key denial;
- development-key mode and `productionSafe=false`;
- state directory and lock permissions;
- system-path rejection;
- logger redaction;
- doctor output redaction.

Receipt is stored at `/var/lib/hermes/workspace/nookbridge-stage-1-s1-review.json` outside this
repo (audit artifact only; not required at runtime).

#### RT-2 limitation, labelled

The red-team harness includes a secondary recursive probe script. Due
to a bug in the probe harness, that script did not execute for this
run. The same recursive plaintext and permission assertions that the
secondary probe was meant to exercise ran (and passed) inside the
parent-controlled S1 deterministic harness. The RT-2 verdict is still
PASS; this limitation is recorded explicitly so the secondary harness
can be repaired before the next checkpoint rather than carrying the
silent-pass risk forward.

## Findings and follow-ups

All items below are non-blocking for Stage 1; they are recorded as
Stage 5 hardening work.

1. **Surface existing-DB chmod failures.** Today, `chmodSync` failures
   on a pre-existing DB are swallowed so the on-disk bytes (still
   encrypted) remain usable. Stage 5 should surface them via the
   diagnostic surface (`doctor`) at minimum, and decide per-error
   whether to fail closed.
2. **SQLite sidecars.** Stage 1 chmods only the main DB path. `better-sqlite3`
   may open sibling files (`-journal`, `-wal`, `-shm`) that are not covered
   by the `chmodSync(opts.dbPath, 0o600)` call. Stage 5 must either tighten
   those sidecars explicitly or document a service-umask /
   state-directory defence that covers them.
3. **Negative-path chmod tests.** The current Gate 1.5 block covers
   the happy path (new DB at `0600`) and the relaxed-then-retightened
   path (existing DB). Negative-path coverage — for example, an
   unwritable path or a chmod that fails on a fresh DB and must
   propagate — is a Stage 5 follow-up.
4. **Service-user, symlink, and systemd hardening.** Stage 5 should
   add a service-user regression that runs the S1 harness under a
   dedicated low-privilege account, plus symlink/`O_NOFOLLOW`
   hardening on the state directory and the DB path, plus systemd
   hardening.
5. **Small open-before-chmod window.** The current fix runs
   `chmodSync` immediately after `new Database(...)`; that window is
   non-zero. Stage 5 should consider a service-umask model and
   additional symlink/open hardening to reduce or eliminate the gap.

## Deferred surfaces

The following surfaces are explicitly **out of scope** for S1 because
they do not exist in Stage 1. They will be reviewed when those
surfaces land, not before.

- RT-1 service-user / credential-boundary checks (no dedicated
  service in Stage 1).
- RT-3 through RT-10 checks for the future headless daemon, RPC,
  MCP, authentication, authorisation, resource-abuse, sync, and
  attachment surfaces (none of those surfaces exist in Stage 1).

Each of these will get its own checkpoint entry above when it ships.

## Review ledger

| Review | Scope | Result | Evidence | Status |
| --- | --- | --- | --- | --- |
| Historical S1 deterministic harness | Encrypted SQLite handle (new + existing DB), state dir, lock file, key file, no-plaintext mirror, logger redaction, doctor redaction, cross-process lock, restart persistence, wrong-key behaviour | PASS | Local run, audit-only external log | Closed |
| Historical project gates (full tests, flake, typecheck, lint, format, build, secret scan) | Repository-wide | PASS: 29/29 tests; remaining gates pass | Local validation | Closed |
| Historical independent xhigh permission-fix review | Two-file code/test snapshot only (`SqliteStorage` constructor + Gate 1.5 tests), SHA `85d635…`; documentation file not covered | PASS, no security or logic findings | `deleg_60f32e50`, receipt `/var/lib/hermes/workspace/nookbridge-stage-1-s1-fix-review.json` | Closed |
| Historical independent red-team RT-1 / RT-2 review | Two-file code/test snapshot + surrounding Stage 1 surface, SHA `85d635…`, 17 assertions, 0 unexpected successes; documentation file not covered | PASS | `deleg_e9fb6468`, receipt `/var/lib/hermes/workspace/nookbridge-stage-1-s1-review.json` | Closed |
| Current follow-up PR provenance | `stage-1-permission-fix`; three-file staged diff including this ledger | Final combined staged hash recorded in the PR verification receipt; pending current PR verification | This documentation update is not covered by the historical reviews | Open |

## Notes on durability

- Review receipts are stored as audit artifacts outside the
  repository; they are not consumed by any runtime or build step, and
  this document does not depend on them.
- This file does not contain credentials, raw reviewer transcripts,
  plaintext canaries, secret values, or temporary probe scripts.
- Follow-ups and deferred surfaces above mirror the reviewers'
  outputs; the historical reviews apply only to the identified two-file
  code/test snapshot, while the current three-file PR is identified by the
  PR verification receipt.

## Chronological ledger — Stage 2B-live offline provider slice (2026-08-26)

This entry covers the complete staged Stage 2B-live offline auth slice: the
mocked Notesnook authentication provider, the administrative command and public
CLI boundaries, additive exports, runtime-generated fake-core fixture, focused
contract tests, Stage 2B regression tests, and both associated documentation
files. It does not cover a live account, real `@notesnook/core` runtime,
network transport, or deployment credentials. The live-account S2 checkpoint
remains explicitly deferred.

- **Scope:** `docs/security-reviews.md`, `docs/stage-2b-live.md`,
  `src/auth/admin-command.ts`, `src/auth/coordinator.ts`,
  `src/auth/notesnook-auth-provider.ts`, `src/auth/secret-input.ts`,
  `src/auth/types.ts`, `src/cli.ts`, `src/index.ts`,
  `tests/fixtures/notesnook-auth-fixture.ts`,
  `tests/stage-2b-live-auth.test.ts`, `tests/stage-2b.test.ts`,
  `tests/stage-2a.test.ts`.
  The scope includes every affected file carrying this slice's behavior or
  its hash-scoped security provenance; no live-account or network claim is
  made.
- **Contract tested:** pinned `@notesnook/core@8.1.3` shape at monorepo commit
  `c9c4936d9e8222b86204781cd1c93cdf2a1738d3`; exact mocked login/MFA/password
  order, `_refreshToken(true)` refresh seam, validate-before-persist, restart,
  bounded retries, concurrency, deferred-write supersession, typed EOF versus
  hostile prompt errors, logger failure normalization, logout cleanup, and
  credential hygiene.
- **Focused evidence:**
  `nix develop --command npx vitest run tests/stage-2b-live-auth.test.ts` —
  PASS, 50/50 tests.
- **Full repository evidence and gates (final run after the
  source/test/documentation edits):**
  focused Vitest PASS (50/50); `npm test` PASS (138/138 across 7 files);
  `npm run typecheck` PASS; `npm run lint` PASS;
  `npm run format:check` PASS; `npm run build` PASS; and
  `nix develop --command git diff --check` PASS.
  Independent security review is **pending** for the new exact hash; this
  ledger does not claim an independent review pass.
- **Deferral:** live-account S2, including real core initialization, live
  authentication, live token revocation/refresh, transport security, secret
  provisioning, and deployment isolation, remains deferred to a separately
  authorized review.
