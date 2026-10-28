# Stage 9 — independent read-only security review (phase 1)

## Provenance and status

- **What this is.** An independent, read-only security review of the NookBridge source. It produced 16 findings, a "checked and found sound" record, and a list of questions it could not settle without running anything.
- **Commit reviewed:** `126e8089` (the review text gives the abbreviated form `126e8089…`; the full object name was not supplied with it). Every line number below refers to that commit, not to current `main`.
- **Reviewer model and session:** not recorded in the review text that was handed to the repository. Reviewer model: *unrecorded*. Session identifier: *unrecorded*. The reviewer is described only as an independent reviewer working in a read-only phase 1. Fill these two fields in from the originating session record; do not infer them.
- **Method.** Read-only. The reviewer wrote no files and ran no builds, tests, or network calls. Nothing in this document was reproduced by execution.
- **Standing of the findings.** The findings are accepted as **evidence to be verified**. They are not confirmed defects, and none is fixed, closed, or remediated. Each is an open item. The plan records them in [§13.24 and §13.25 of the implementation plan](../../implementation-plan-v1.5.md).
- **Line references.** A parent check of the source confirmed the line references for finding 1 (the HIGH finding), finding 4 and finding 5 only. Treat every other line reference as unverified until reproduced. A later pass also read the cited code for findings 3, 12 and 16 and saw it match their descriptions; that is a read, not a reproduction, and no test was run.
- **Fixes.** The brief for phase 1 was not to propose patches. The "Fix" lines were requested afterwards as the smallest fix for each finding. The reviewer called them rankable suggestions, not a remediation plan. The ordering and dependencies live in the plan, not here.
- **Secrets.** This document contains no credentials, keys, tokens, or note content.

## Severity index

| # | Severity | Defect (one line) |
| --- | --- | --- |
| 1 | HIGH | `notes.delete` is authorized on the caller's path, not the resolved note's notebooks |
| 2 | MEDIUM-HIGH | Multi-notebook notes are judged by one notebook, chosen by enumeration order |
| 3 | MEDIUM | `notes.update` with `patch.notebookId` writes to a destination that is never authorized |
| 4 | MEDIUM | `notes.path_diagnostic` is an unauthorized corpus oracle and ships in the default readPolicy |
| 5 | MEDIUM-LOW | The client group can use operator-socket reads that ignore the service readPolicy |
| 6 | LOW-MEDIUM | Operator capability comes from `/proc/<pid>/status` by PID, not socket credentials |
| 7 | LOW | The daemon socket answers operator methods differently from unknown methods |
| 8 | LOW, KNOWN | The upload gate works on sync markers as a whole, not per item (documented in [S7a-2](stage-s7a-dirty-set.md)) |
| 9 | LOW | Approval is gated by group membership, not by a human |
| 10 | LOW | Opaque-block placeholders are unkeyed hashes over values the client has |
| 11 | LOW | `notes.search` matches note bodies, not just titles |
| 12 | LOW | Operator `notes.create` without a notebook is evaluated with an empty-string path |
| 13 | LOW | Note-id existence can be learned without authorization |
| 14 | LOW | The operator socket accepts pipelined requests and blocks the event loop per connection |
| 15 | LOW | The SQLCipher key is changed silently |
| 16 | INFORMATIONAL | A comment contradicts the code |

The review text follows, unedited except for the headings of this document.

---

## Findings, by severity

### 1. HIGH: `notes.delete` is authorized on the path the caller sends, not on the note that gets deleted
- **Who can do it:** any MCP client, when the deployment's `custom` readPolicy includes `notes.delete`.
- **Evidence:**
  - `src/service/rpc-handler.ts:355-371` authorizes with the parsed path. `runNotesDelete` (`:1225-1257`) then resolves and deletes without checking again.
  - The resolver accepts a note through direct membership (`src/service/exact-note-path-resolver.ts:162-186`). When no direct probe is available it falls back to *recursive* membership (`:187-205`, using `notebooks.notes`, which walks sub-notebooks; core `index.mjs:6091`).
- **Why it is exploitable:**
  - Notesnook notes can sit in several notebooks. Suppose a note is directly in `A`, where delete is allowed, and also in `B`, where delete is denied. `notesnook_delete_note {path:"A/T"}` passes the check and trashes the note everywhere.
  - A note-level deny rule (a `notes` pattern on `B/T`) is bypassed the same way.
  - On the recursive fallback, `A/T` also reaches a note that lives in `A/Secret`.
  - `notes.get` already fixed this exact gap: it re-authorizes on the note's actual notebook at `rpc-handler.ts:316-324`. Delete never got the same fix.
- **Why the tests miss it:** the delete tests in `tests/stage-10-rpc-handler.test.ts:336-413` only check that a *denied parsed path* is refused before the resolver runs. The "permitted path resolves into a denied notebook" test exists only for `get` (`tests/stage-12-get-note-path.test.ts:219`).
- **Fix:** after resolving, authorize `delete` against every notebook the resolved note is directly attached to, and refuse if any of them denies.

### 2. MEDIUM-HIGH: notes in more than one notebook are judged by one notebook, chosen by enumeration order
- **Who can do it:** an MCP client using `get`, `append` or `update`. An operator-group peer using `get-view`, `edit-preimage` or `apply-edit`.
- **Evidence:**
  - `src/core/notesnook-readonly-projection.ts:325-341` returns the first notebook whose relations contain the note. `:1507-1513` surfaces the "FIRST id".
  - `noteMetadata` (`:743-753`) feeds the single settings context at `src/service/rpc-handler.ts:932-983`.
  - The operator path does the same through `src/nookd.ts:642-647`.
- **Why it is exploitable:** take a note directly in `A` (read and edit allowed) and `B` (read denied). Whenever `A` enumerates first, `notesnook_get_note {path:"A/T"}` returns the full Markdown, and append/update by id succeed. Discovery handles this correctly: it hides such notes (`src/service/discovery-visibility.ts:239-267`). The per-note paths do not, so the two disagree.
- **Why the tests miss it:** no test builds a note with two direct notebook relations.
- **Fix:** have `noteMetadata` return all direct notebook ids, and authorize against every one of them (deny wins). Alternatively, refuse notes in more than one notebook, as discovery does.

### 3. MEDIUM: `notes.update` with `patch.notebookId` writes into a notebook that is never authorized
- **Who can do it:** an MCP client with edit rights on the note's current notebook (the `readWriteNoDelete` profile is enough).
- **Evidence:**
  - Authorization only uses the source note's context (`src/service/rpc-handler.ts:423-433`).
  - The adapter then *adds* the note to the destination notebook (`src/core/notesnook-write-adapter.ts:759-788`, `notebookAddNote`). Nothing evaluates the destination.
- **Why it is exploitable:**
  - Content can be planted in a notebook where `create`/`edit` is denied. Any notebook id from `list_notebooks` works, and read-only notebooks are listed.
  - The note ends up in several notebooks, which feeds finding 2.
  - It uploads on the next MCP sync as an `mcp`-origin change, with no approval.
- **Why the tests miss it:** I found no test that pairs a `notebookId` patch with a destination-deny setting.
- **Fix:** when `patch.notebookId` is present, resolve the destination path and require `create` (or `edit`) there.

### 4. MEDIUM: `notes.path_diagnostic` is a corpus oracle with no notebook-level authorization, and it is in the default readPolicy
- **Who can do it:** any process that can reach the daemon socket (the client group). It is not an MCP tool.
- **Evidence:**
  - It is authorized with an empty context (`src/service/rpc-handler.ts:266-285`).
  - The runtime is unfiltered (`src/service/service-runtime.ts:454-584`). The content candidate is the single *global* title match, not one scoped to the requested notebook (`:530-541`, and `:811-829` in the fallback).
  - It is shipped in the default readPolicy (`scripts/install-systemd.sh:254-259`).
- **What leaks:** for read-denied notebooks and locked notes:
  - whether a title exists (`none`/`one`/`multiple`)
  - whether a notebook path exists
  - direct and recursive membership
  - whether the revision is valid
  - content-structure markers: `contentType`, `htmlPrefix`, `simpleChecklist`, `taskList`, `literalMarkdown`

  Locked notes only suppress the content markers (`notesnook-readonly-projection.ts:1613`). Title existence still leaks for them.
- **Why the tests miss it:** policy tests treat it as a "global" method. No test pairs it with a deny override.
- **Fix:** authorize it with the parsed path context and put its candidates through `discoveryVisibility`. Alternatively, drop it from the default readPolicy and make it operator-only.

### 5. MEDIUM-LOW: the client group can use operator-socket reads, which ignore the service readPolicy
- **Who can do it:** a member of the client group, which includes the MCP proxy's user and anything that compromises it.
- **Evidence:**
  - `nookbridge-clients` is an admitted group (`src/service/operator-authorizer.ts:42-45`).
  - `browse`, `search-operator`, `operation-list` and `operation-status` need no target. `get-view` and `edit-preimage` only need settings `read` (`:85-88`, `:133-140`).
  - The operator socket is created mode 0660 with no group change (`src/service/operator-socket-server.ts:22`, `:272-291`). The unit's primary group is `nookbridge-clients` and `/run/nookbridge` is 0750 (`scripts/install-systemd.sh:127`, `:135-136`), so clients can reach `operator.sock` (`src/nookd.ts:620`).
- **Why it matters:** a deployment that removes `notes.get` or `notes.search` from readPolicy, to keep note bodies away from the MCP side, is bypassed by `browse` → handle → `get-view`.
- **Fix:** take `nookbridge-clients` out of `OPERATOR_ADMITTED_GROUPS`, or tie each operator read to the matching service-policy method.

### 6. LOW-MEDIUM: operator capability comes from `/proc/<pid>/status` looked up by PID, not from the socket's credentials
- **Who can do it:** a client-group member who can win a PID-reuse race.
- **Evidence:**
  - `native/operator-peercred.c:212-254` reads `Groups:` for the PID that `SO_PEERCRED` reports. The uid/gid come from the socket, but the groups come from whichever process holds that PID now.
  - Authorization keys entirely on group names (`src/service/operator-authorizer.ts:183-189`).
  - Peer resolution uses a synchronous `spawnSync` on the event loop (`src/service/operator-socket-server.ts:87-93`, `:223-229`). An attacker can flood connections to widen the window between `connect()` and the helper's read.
- **Impact:** client → operator escalation, which gives `approve-upload` and `apply-edit`. This is hard to pull off in practice.
- **Fix:** use `getsockopt(SO_PEERGROUPS)` in the helper and resolve names from those gids.

### 7. LOW: the daemon socket answers operator methods differently from unknown methods, and the test that should catch this checks the wrong layer
- **Who can do it:** a process that can reach the daemon socket.
- **Evidence:**
  - `parseRpcFrame` accepts operator literals (`src/service/rpc-protocol.ts:1216-1244`), and the handler replies with an `invalid_request` envelope (`src/service/rpc-handler.ts:488-503`).
  - An unknown method makes the parser throw, and the connection is destroyed with no envelope (`src/service/nookd-server.ts:580-603`).
  - The audit log also disagrees with itself: `method_peek` records the `notes.search` sentinel for operator methods (`nookd-server.ts:70-99`, `:571-578`), while `rpc.request.parsed` records the real operator method name (`:605`).
- **Why the tests miss it:** `tests/stage-11-t10-mcp-non-regression.test.ts:108-123` calls `handleRpcRequest` directly and skips `parseRpcFrame`. It is a guard tested at the wrong layer.
- **Fix:** on the daemon socket, reject operator literals at parse time so they drop the connection like unknown methods, and have the peek list match.

### 8. LOW, KNOWN: the upload gate works on sync markers as a whole, not per changed item
- **Who can do it:** an MCP client with `notes.sync`.
- **Evidence:**
  - An empty marker batch passes (`src/core/notesnook-live-remote-sync.ts:71-101`). The executor then runs `syncer.start({type:"full"})` (`:216`), which uploads everything dirty.
  - Already documented in `docs/engineering/stages/stage-s7a-dirty-set.md`.
  - `notes.sync` is treated as a settings `read` (`src/service/service-policy.ts:268`).
- **What is still wrong:** any dirty item not produced through the write composition gets uploaded with no approval when an MCP client triggers sync. I did not establish whether such items exist (see "Cannot establish" below).
- **Not forgeable:** the approval state itself cannot be forged from MCP. Write-ahead intents keep blocking even when marker persistence fails (`src/core/notesnook-write-composition.ts:1520-1566`).
- **Fix:** refuse a drain when the batch is empty but `hasUnsyncedChanges()` is true, and treat `notes.sync` as `edit`.

### 9. LOW: approval is gated by group membership, not by a human
- **Who can do it:** any non-interactive process in the operator group.
- **Evidence:** `src/service/operator-upload-approval-runtime.ts:52-73`. Preview and approve are plain RPC calls with no TTY or human proof.
- **Fix:** this is a design limitation. At minimum, require approval to echo the `highestSequence` from the preview (so you approve what you saw) and document that operator-group membership is equivalent to upload authority.

### 10. LOW: opaque-block placeholders are unkeyed hashes over values the client already has
- **Who can do it:** any MCP client using `notes.get`.
- **Evidence:** the token is `sha256([noteId, revision], index, rawHTML)` (`src/core/note-document-native.ts:505-508`). It is emitted in `notes.get` Markdown (`src/core/note-document-markdown.ts:368`, `src/service/rpc-handler.ts:1721-1727`). The note id and revision are also returned.
- **Impact:** an offline way to confirm guesses about withheld opaque content, such as embed URLs or attachment hashes.
- **Forging, replay and smuggling were checked and are not possible:** the references must exactly match the trusted preimage (`note-document-markdown.ts:600-610`, `note-document-native.ts:829-830`), and payloads come only from the daemon-held context.
- **Fix:** use an HMAC with a daemon-held key derived like the operation-store key.

### 11. LOW: `notes.search` matches note bodies, not just titles
- **Evidence:**
  - Core `lookup.notes` unions `notes_fts` with `content_fts` (`node_modules/@notesnook/core/dist/index.mjs:7567-7585`).
  - The tool description says "title-only" (`src/mcp/nook-mcp-server.ts:177-179`), as does the projection comment (`notesnook-readonly-projection.ts:819-820`).
- **Impact:** hits are filtered for visibility, so this only matters under a custom policy that allows `notes.search` without `notes.get`. There, search becomes an oracle for body content.
- **Fix:** match hits against the exact title, or require `notes.get` whenever `notes.search` is allowed, and fix the description.

### 12. LOW: operator `notes.create` without a notebook is evaluated with an empty-string path
- **Who can do it:** a member of the operator group.
- **Evidence:** the path passed is `""` instead of undefined (`src/service/operator-authorization-context.ts:173-179`). The `<root>` rule only applies when the path is undefined (`src/settings/settings-evaluator.ts:441-447`), so a `<root>` create-deny never matches.
- **Fix:** pass undefined.

### 13. LOW: whether a note id exists can be learned without authorization
- **Who can do it:** an MCP client.
- **Evidence:** for id-form get/append/update, metadata is looked up before the policy check, so the reply is `not_found` vs `permission_denied` (`src/service/rpc-handler.ts:288-296`, `:423-433`).
- **Impact:** low, because ids are random 24-hex values.
- **Fix:** answer `permission_denied` for both.

### 14. LOW: the operator socket accepts several pipelined requests per connection and blocks the event loop per connection
- **Who can do it:** a member of the client group.
- **Evidence:**
  - `completed` is only set after the first dispatch finishes, and the frame-size bound resets for each frame (`src/service/operator-socket-server.ts:135-152`). The intended one-request-per-connection limit does not hold.
  - `spawnSync` on every connection (`:223-229`) lets this be used for denial of service.
- **Fix:** set `completed = true` when the first frame is taken, and use `resolvePeerAsync`.

### 15. LOW: the SQLCipher key is changed silently
- **Evidence:** `"` and `\` are stripped rather than rejected (`src/auth/live-login-runtime.ts:402-404`, `src/storage/sqlite-storage.ts:234-240`). This lowers the key's entropy and lets different keys collide.
- **Fix:** reject keys containing those characters.

### 16. INFORMATIONAL: a comment contradicts the code
- `src/service/service-policy.ts:684-697` says `notes.delete` is "structurally impossible" in a custom policy. The allow-list at `:179-191` includes it.
- The `createReadWriteNoDelete` doc comment (`:292-295`) is also stale.
- This matters because reviewers may trust the comment.

---

## Checked and found sound
- **Fetch-only boundary:** sync accepts exactly `{type:"fetch"}` as a plain own property, with no `force` (`notesnook-readonly-projection.ts:394-429`). There is no `full` or `send` on the read surface.
- **Approval state:** it can only be set by `approvePending`, which needs the operator group (`operator-authorization-context.ts:30-35`, `operator-authorizer.ts:116-131`). Daemon-socket requests for `approve-upload` are refused. Later markers start unapproved.
- **Locked notes in `notes.get`:**
  - The metadata `locked` flag stops the read before the reader is called (`rpc-handler.ts:1700-1702`).
  - If the lock state is unknown, the reader still refuses locked or cipher records (`notesnook-readonly-projection.ts:801`).
  - Path-form get re-authorizes on the note's actual notebook (but see finding 2 for notes in several notebooks).
- **Discovery filtering** (search, list_notebooks, browse): a fresh hierarchy is loaded per request, membership must be confirmed by a direct probe, and anything unresolved is hidden (`discovery-visibility.ts`).
- **Daemon socket permissions:** group, dev/ino and mode are checked before connections are accepted (`nookd-server.ts:928-956`). An existing path is never unlinked. Peer identity is used only for audit; access is controlled by the socket's mode (0770, `nookbridge-clients`).
- **Operator handles and cursors:** 144-bit random, scoped per peer, with a TTL. Undo is bound to the record's owner.
- **Error handling:** errors are reduced to categories with the cause, path and context stripped (`nookdServerError`, `serviceRuntimeError`, the fixed message table in `buildErrorEnvelope`).
- **MCP surface:**
  - There are exactly nine tools, on a closed allowlist with a forbidden-name guard. `tools/call` is replaced (`nook-mcp-server.ts:777-844`).
  - The annotations are reasonable. No read-annotated tool can cause a write or a sync.
- **Placeholders:** forging, cross-note or cross-revision replay, and smuggling are all blocked (see finding 10).
- **Credentials:**
  - The systemd credential is opened with `O_NOFOLLOW`, size-checked by `fstat`, read in one bounded read and never logged (`systemd-credential-keystore.ts:204-331`).
  - The db-key is installed root 0400 and the settings root 0640 (`install-systemd.sh:518-519`).
  - The unit uses `UMask=0077`, an empty `CapabilityBoundingSet` and `NoNewPrivileges`.
  - Database files are chmod 600 (`live-login-runtime.ts:391-400`).
  - The operation store uses an HKDF domain-separated key, AES-256-GCM, and `O_EXCL|O_NOFOLLOW` at 0600. Key buffers are zeroed.
  - Credential flags and environment variables are explicitly forbidden in argv and env (`notesnook-sync-admin.ts:129-160`).

## Open questions (could not establish without running something)

These are open questions, not findings. None has been answered.

- **Live behaviour behind findings 1 and 2.** Whether live core note records from `findNotesByTitle` carry a `notebookId`, and the order `notebooks.all` enumerates in. Probe: a live note directly in two notebooks; call delete and get through the allowed path.
- **Whether `fetch` merges or upstream migrations leave dirty items without markers** (finding 8). Probe: fetch with a conflict, then an MCP sync, then inspect what uploads.
- **Whether the operator CLI tools write without creating markers.** I did not read `notesnook-conflict-admin.ts`, `recover-local-state.ts` or `notesnook-write-admin.ts` in full.
- **Runtime ownership of `/run/nookbridge` and `operator.sock`** (finding 5). Run `stat` on the host.
- **How feasible the PID-reuse race is** (finding 6). This needs a racing harness.
- **Timing differences on the operator socket.** The authorizer does database lookups (`operator-authorizer.ts:96-115`) before the group check (`:183-186`), which may create a timing oracle. This needs measurement.
- **sops/age identity handling.** There is no sops or age code in this repo; it lives in the deployment outside it.
- **Whether the tests named under "why the tests miss it" pass or fail.** I did not run them.
