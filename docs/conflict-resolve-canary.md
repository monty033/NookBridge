# Stage 1 keep-both conflict resolve: live canary plan

Status: **plan only. Nothing in this document has been run against a live vault.**
It is the operator procedure that proves Stage 1 (`notes.resolve-conflict`, operator
CLI `nookctl notes resolve-conflict`) on a real conflicted note. It sits beside
`docs/implementation-plan-v1.5.md`, which remains the acceptance-gate source of truth.

Ordering rule: a **disposable canary note runs first**. The real conflicted backlog
is touched only after the canary passes every assertion in §5 and the owner signs off.

Ground rules for every step:

- Every command is run by the operator, by hand. Nothing here is automated.
- Note titles, bodies, handles, and bindings are never pasted into chat, tickets, or
  logs. Record the captured text in a private file with mode `0600`.
- Nothing is deleted or trashed at any point (see §8).

---

## 0. Preconditions

1. Stage 1 gates are green on the commit under test (`nix develop --offline --command just check`).
2. The operator daemon is running and answers on `/run/nookbridge/operator.sock`.
3. Two Notesnook clients share the account:
   - **bridge-local**: the device whose local database the bridge reads and writes.
   - **remote**: the second client the owner edits from (desktop or phone).
4. The canary note exists only for this test. Title it `CANARY keep-both <nonce>`, where
   `<nonce>` is a random 8-character string chosen now. Put it in a notebook named
   `Canary` and tag it `canary`. Use no real content.

## 1. Two-owner conflict setup

The goal is one note edited on both clients before either side has seen the other's edit.

| # | Where | Action | Check before moving on |
|---|---|---|---|
| 1.1 | both | Let the canary sync to both clients. Both hold the same text. | Both clients show identical text. |
| 1.2 | bridge-local | Record the baseline count: `nookctl conflicts list`. | Record the count. Call it `C0`. |
| 1.3 | bridge-local | Stop the bridge's sync so it cannot receive the remote edit. The method is operator-chosen; record it. | Sync is stopped and the remote edit cannot arrive. |
| 1.4 | remote | Append the line `REMOTE-EDIT <nonce>` and let it sync to the server. | The server holds the remote text. |
| 1.5 | bridge-local | Append the line `LOCAL-EDIT <nonce>` with `nookctl notes edit --handle <h> --approve-edit`, in `$EDITOR`. | The local text now differs from the remote text. |
| 1.6 | bridge-local | Restart sync so the bridge pulls the remote edit. | The conflict marker appears locally. |
| 1.7 | bridge-local | Run `nookctl conflicts list`. | Count is `C0 + 1`. |
| 1.8 | bridge-local | Run `nookctl conflicts inspect --title "CANARY keep-both <nonce>"`. | Output starts `nookctl conflicts inspect: inspected`. |

**Capture before resolving** (private file, mode `0600`):

- The remote text, copied from the remote client, byte for byte as shown.
- The bridge-local text, from `nookctl notes get --handle <h>`.

Expected from step 1.8: `sides-equal: no`, `remote-has-attachments: no`. If either
differs from this, **stop** (see §6).

## 2. Before-resolve checks

1. Find the handle: `nookctl notes search --stdin` with the query `<nonce>`. The query
   arrives on stdin only. Note the one handle returned for the canary.
2. Record the pending-upload baseline: `nookctl notes approve-upload`. Record the `total` shown,
   then decline at the confirmation prompt with an empty line. The check is exact equality
   against the typed sequence, so any other answer also declines. Nothing is uploaded.
3. Confirm the conflict count is still `C0 + 1`.

## 3. The resolve

Run `nookctl notes resolve-conflict --handle <h>` on the bridge-local device.

The CLI prompts for the typed phrase and sends it to the daemon as `confirmation`. The
daemon accepts only the exact phrase `KEEP BOTH`. It refuses anything else, including a
missing phrase, a different case, or extra whitespace, before it looks up the handle or
writes anything.

This check is an **intent guard, not a security boundary**. It stops a mistyped or
scripted invocation from resolving by accident. Anyone who can reach the operator socket
can send the phrase directly. The operator socket remains the trust boundary.

Expected output, in order:

```text
nookctl notes resolve-conflict: inspected
sides-equal: no
remote-has-attachments: no
binding: <64 lowercase hex characters>
plan: the original adopts the remote side; a copy keeps the bridge-local side
Type KEEP BOTH to keep both, or press Enter to cancel: KEEP BOTH
nookctl notes resolve-conflict: resolved
original: CANARY keep-both <nonce>
copy: CANARY keep-both <nonce> (bridge copy)
uploaded: no
```

- The `binding` must equal the binding from step 1.8. If it does not, **stop**.
- Typing anything other than `KEEP BOTH` must print `cancelled` and change nothing.
  Run that negative check once before the real resolve, and record that it passed.
- The copy title is the original title with ` (bridge copy)` appended. The title
  may be shortened to the title bound.

## 4. After-resolve checks (still before any upload)

| # | Command or check | Expected |
|---|---|---|
| 4.1 | `nookctl conflicts list` | Count is `C0`. The canary is no longer counted. |
| 4.2 | `nookctl conflicts inspect --title "CANARY keep-both <nonce>"` | `nookctl conflicts inspect: not-conflicted`. |
| 4.3 | `nookctl notes get --handle <original handle>` | Markdown equals the **remote** text captured in §1. |
| 4.4 | `nookctl notes search --stdin` with `<nonce>` | Two handles: the original and the copy. |
| 4.5 | `nookctl notes get --handle <copy handle>` | Markdown equals the **bridge-local** text captured in §1. |
| 4.6 | `nookctl notes approve-upload` | The preview shows a `total` above the step-2 baseline, and the operator-origin count reflects the resolve. Decline with an empty line. Nothing uploads. |

Step 4.3 and 4.5 compare **Markdown**, not raw bytes. The CLI does not print raw
bytes. Byte-exact equality is established by the daemon's own read-back
(`verifyOriginal` for the original, and the copy read-back in the resolver), and §5
lists the read-back fields. Treat a byte mismatch that the daemon did not report as
a stop.

**Findable by notebook and tag.** The CLI does not show notebook or tag membership.
The daemon reads the copy's memberships back before it writes the copy's content. If
any notebook or tag the original holds is missing from the copy, it refuses with
`relation_failed` before the content write. The copy is still only local until the
explicit upload, so confirm its notebook and tag on the remote client after upload.

## 5. Read-back assertions that could differ on real core

The daemon checks these fields after every write. The canary confirms they hold on the
real core.

| Field | Where | Expected | Code reference |
|---|---|---|---|
| `conflicted` on the content row | content row, original | **absent, `null`, or `false`**. Each means cleared. | `src/core/notesnook-conflict-resolve-wiring.ts` (`verifyOriginal`, through `isClearedContentMarker`) |
| `conflicted` on the note | note metadata, original | **`false`** after the flag clear | same file, the `field(note, "conflicted") !== false` check |
| `dateResolved` on the content row | content row, original | equals the remote date | `verifyOriginal` |
| `id` on the content row | content row, original | equals the content id the note metadata names | `verifyOriginal` |
| `noteId` on the content row | content row, original | equals the note id | `verifyOriginal` |
| copy identity | copy note | the copy id is a valid id that differs from the original's, and the copy's title equals the derived copy title | the copy checks in `src/core/notesnook-conflict-resolve-wiring.ts` |
| copy text | content row, copy | equals the bridge-local text byte for byte, and the row's `noteId` is the copy's id | the copy read-back in the resolver |
| memberships | copy | every notebook and tag the original holds is present on the copy, read back before the content write | `copyCarriesMemberships`, through the read-only `noteRelations` seam. A miss is `relation_failed` |

### The `conflicted` null, absent, or false question

On the content row, the cleared marker may read back as **`null`**, as **absent**
(`undefined`), or as **`false`**. The daemon accepts all three as cleared, through
`isClearedContentMarker`. Any other present value, such as `true` or a string, still
fails the check, and that is a stop.

- The note's own `conflicted` flag stays strict: it must read back as exactly `false`.
- `dateResolved` and the content `data` remain byte-exact checks, unchanged.
- **Disposition: decided.** Absent, `null`, and `false` count as cleared. The canary
  still records which shape core returns, so the owner can see it.

## 6. What "stop" looks like

Stop immediately, with no further commands, no retries, and no upload, if any of these
happen:

- Any outcome other than `resolved`.
- `resolved`, but a title differs from the expected title.
- `binding` differs from the inspection.
- `sides-equal: yes` or `remote-has-attachments: yes`. The owner decides these.
- Any read-back in §4 or §5 differs, including a content-row `conflicted` value other than
  absent, `null`, or `false`, or a note `conflicted` value other than `false`.
- `conflicts list` changes by anything other than the expected amount.
- Any note other than the canary changes.
- The process crashes or is killed mid-resolve (see Known gaps, item 1).
- The command prints `service_unavailable`, `invalid_response`, or `unreadable`.
- The daemon refuses with `invalid_request` after you typed `KEEP BOTH`. The CLI and
  the daemon disagree about the phrase, so this is not a retry.
- The daemon reports `relation_failed` or `copy_unverified`. The original is untouched
  in both cases, but a copy note may already exist locally from this attempt. Do not
  delete it and do not upload it. Stop and do not retry.

On stop: **nothing is deleted, trashed, or uploaded.** Both notes stay where they are.
Save the complete terminal output to the private file, and report to the owner.

## 7. The real backlog

Only after the canary passes all of §3–§5, and the owner signs off:

1. Work one conflicted note at a time. Never batch.
2. For each note, run in order: `conflicts inspect` → read the facts → `resolve-conflict`
   → the §4 checks → an explicit upload decision by the owner.
3. Upload is a separate step. Run `nookctl notes approve-upload` and enter the typed
   sequence only after reviewing the count. Then run the explicit sync path. Use the
   command named in `docs/reference/cli.md` for it, and confirm the exact step there
   before running.
4. Stop at the first divergence (§6).

## 8. Rollback position

Nothing is trashed or deleted at any step, so **undo means uploading nothing and leaving
both notes in place**:

- The original stays on the remote text, and the copy stays on the bridge-local text.
- The copy and the resolve stay pending locally until the owner decides. The
  pending state is not removed by any command.
- `nookctl notes undo` does **not** reverse a resolve. It reverses edits by
  operation handle, and a resolve creates no undo operation. See Known gaps, item 8.

---

## Known gaps and their decisions

Each item states what the operator should do, or that the disposition is undecided
and needs the owner. None of these has a destructive recovery action, and none is
invented here.

### 1. A crash before the content write leaves the operation in `committing`

If the process dies after the resolve starts and before the content write, the operation
stays in `committing`. A later `resolve-conflict` for that note is blocked with
`service_unavailable`, and nothing recovers it automatically.

- **Operator action**: do not retry, and do not edit state files. Record the output.
  Check the operation with `nookctl notes undo --status` (item 2). Then stop.
- **Disposition: undecided, needs the owner.** Recovery needs a daemon-side decision
  about whether the content write happened. That is not in this slice.

### 2. Unresolved operations are visible only through `notes.operation-list`

Unresolved operations are visible only through the `notes.operation-list` method. The
operator sees them with `nookctl notes undo --status`, which calls that method. No
resolve-specific status view exists.

- **Operator action**: after any crash or stop, run `nookctl notes undo --status` and
  record the output.
- **Disposition: accepted for the canary.** Whether a resolve-specific status view is
  needed is undecided, and the owner decides.

### 3. Live `notes.add` and `content.add` behaviour is unverified against real core

The copy is created with core's verbatim note create (`notes.add`). The content
write goes through core's `content.add`, with `dateResolved` set. Neither has been
checked against the real core. The unit tests use stubs.

- **Operator action**: the canary is the verification. If any §5 check fails, stop (§6).
- **Disposition: the canary is the gate.** It is not accepted until §5 passes on real core.

### 4. The factory builds the capability through its exported builders, not a full factory construction

The live capability is constructed through its exported builders. The full production
factory is not exercised end to end in tests.

- **Operator action**: before §3, confirm the capability is present. If it is absent,
  the daemon refuses `notes.resolve-conflict` before any content change. Such a refusal
  is a stop, not a retry.
- **Disposition: the canary is the check.** Full factory coverage is undecided and
  needs the owner.

### 5. The `conflicted` null, absent, or false read-back

Covered in §5. Absent, `null`, and `false` on the content row count as cleared. Any
other present value is a stop.

- **Disposition: decided.** The canary records which shape core returns.

### 6. No inspection source exists for the operator CLI

The operator socket has no read-only conflict inspection method. The CLI therefore
refuses with `inspection unavailable` and makes no write, until an inspection source is
wired. This is a real blocker for the live canary, not a documentation gap.

The two options are:

- (a) A read-only daemon method that returns the categorical inspection facts. It is
  new daemon logic, and it is the option this plan recommends.
- (b) The CLI runs the local `nookctl conflicts inspect` path. That opens the encrypted
  database from the operator CLI, which breaks the client-only boundary.

- **Disposition: undecided, needs the owner.** The owner chooses (a) or (b), in a
  separate slice.

### 7. The binding is printed to the operator

The binding is a SHA-256 derivation over the note id, the content id, and each side's
digest. The CLI prints it to the operator's terminal. The operator-facing rule against
printing digests covers content digests, not this binding.

The owner approved printing the binding, for these reasons:

- It is an opaque, one-way digest over the ids and the side digests. It is not
  reversible into note content.
- It is the token that proves the operator acted on the state they inspected. The
  daemon captures against it and refuses any mismatch before a write.

- **Operator action**: check that the printed binding matches the inspection output.
  Do not paste the binding into chat, tickets, or logs. The terminal is the only place
  it appears.
- **Disposition: decided.** The owner approved printing the binding to the operator's
  terminal.

### 8. There is no undo for a resolve

A resolve creates no undo operation. `nookctl notes undo` does not reverse it, and no
command removes its pending marker.

- **Operator action**: the rollback is §8, which means do not upload.
- **Disposition: decided for Stage 1.** Undoing a resolve is not supported, and a
  reversal would need its own design.

### 10. The copy is checked at three points, not held

The copy's id and a digest of its local side are recorded in the operation before the
original is touched. The copy is re-read before the original's content write, and again
before recovery clears the flag. A copy that was edited or deleted while the operation
was unresolved is refused, not reported as resolved.

A window remains between the last copy read-back and the content write. The copy row is
not locked, so a change inside that window is not caught.

- **Operator action**: after any `resolved` result, check the copy's title and text
  match the local side you inspected. Do not rely on the copy surviving untouched.
- **Disposition: undecided, needs the owner.** Closing the window needs a store-level
  copy lock or a second confirmation read, which is a design choice.

### 9. Titles cross the operator socket and print to the terminal

The `resolved` result carries the original title and the copy title. The CLI prints
them. Titles that are not safe to print (too long, or containing control characters)
are withheld, and the output says `titles: withheld`.

- **Operator action**: treat terminal scrollback as sensitive when the titles are private.
- **Disposition: accepted, the owner may revisit.**
