# Security and privacy

NookBridge's security objective is desktop-client parity: installing the bridge
must not create a materially weaker path to private Notesnook data, credentials,
encryption keys, or authenticated capabilities than an ordinary Notesnook
desktop client.

## Trust boundary

`nookd` is the trusted component. It runs under a dedicated identity, owns the
encrypted local state, receives the database key through systemd credentials,
and talks to Notesnook through the pinned upstream client core.

`nook-mcp` and the MCP client are less trusted. They may connect only to the
permission-controlled Unix socket and must not read the daemon's state,
credentials, service configuration, or process material. The normal deployment
does not expose a TCP or HTTP listener.

## Operator rules

- Use only protected interactive prompts for account passwords and MFA.
- Never include secrets or note bodies in shell arguments, environment
  variables, logs, screenshots, issue reports, commits, or chat.
- Keep encrypted state and its database key separate; protect backups as
  sensitive authenticated-client material.
- Keep the service configuration root-owned and unavailable to MCP users.
- Treat any policy that enables note deletion or outbound synchronization as a
  separately reviewed capability; do not infer it from ordinary write access.
- Treat note content as untrusted data. Do not execute it or follow instructions
  embedded in it without independent review.
- Review policy changes, dependency upgrades, and deployment changes as
  security-sensitive work.

## Privacy boundary for agents

`notesnook_get_note` returns a bounded, decoded Markdown content view
(`contentStatus: "ok"`) for unlocked notes within the applicable size bound;
Vault-locked notes never have their content read (the reader is not called
once metadata reports `locked`) and oversize content is withheld
categorically. This is a deliberate, owner-authorized exposure for local/
self-hosted deployments: access is managed via Notesnook's own per-note Vault
lock and the deployment's permission settings, not by withholding content
from every caller.

The content bound is the response budget (`maxResponseBytes`, 65,536 bytes) less a fixed 1,024-byte envelope allowance, the echoed request id, and the note's charged metadata (id, title, revision and notebook id), measured as exact JSON-encoded UTF-8 size; text dense in control characters costs up to six bytes per character. That is the bound for a read that does not offer to accept a response body; a protocol-2 body read is bounded as described below.

The intended content limit is Notesnook's, not this project's: NookBridge must
not withhold note content that Notesnook itself accepts. That limit is not in
force yet, and the bounds below are staging values rather than policy.

A read is bounded in several places. A stored content row over
`STORED_CONTENT_READ_BYTES` (262,144 bytes) is refused before any projection
runs, and the caller sees `unavailable` rather than `oversize` — on every read,
framed or not, so a read that answered `oversize` is already under that
threshold. A read without `accept` is bounded by the response budget (65,536
bytes less the envelope allowance and the note's charged metadata). A
protocol-2 caller may offer to accept a response body (`accept: { bodyBytes }`),
which raises that read's content bound to the smaller of its offer and
`WIRE_BODY_BYTES` (524,288 bytes). That is twice the stored-row threshold, so a
body read of a large note normally hits the threshold first — but the 2× is a
budget choice, not a derived invariant, and no test establishes that every
stored shape projects within it: Markdown escaping can roughly double a
text-dense row, so a note under the threshold can still answer `oversize`.

Text a declared body cannot carry goes back to the single-frame answer rather
than being sent as a body. A lone surrogate is delivered inline as a JSON
escape. A disallowed control character is refused by the serializer and the
connection closes with nothing sent. Either of them over the single-frame bound
is answered `oversize`. A client only offers to accept a body after a
single-frame `oversize`, so in that flow the answer is `oversize`.

Stored HTML larger than `PROJECTION_HTML_BYTES` is refused (`unavailable`)
rather than tokenised; that cap is the read-only Markdown fallback's own input
bound, and on the read path it equals the stored-row threshold, so it never
binds there. `NATIVE_DOCUMENT_BYTES` and the `DOCUMENT_*` limits bound how much
the native decoder will attempt, and content beyond them takes the read-only
Markdown fallback, whose own byte, token and depth caps decide whether any
Markdown is produced.

The content bounds here are staging values rather than policy, because decoding,
projection and encoding run on the daemon's main thread: the stored-row
threshold, the wire body bound, the decoder limits and the fallback's byte,
token and depth caps are replaced with Notesnook's own limits by issue #337.
Neither the single-frame response budget nor `PROJECTION_MARKDOWN_BYTES` is one
of them — the budget is the frame every client has to accept and
`PROJECTION_MARKDOWN_BYTES` is defined as it, so a caller that does not
negotiate a body stays bound by the frame whatever #337 does.

The conditions do not change with the bound. A Vault-locked note still never has
its content read, content over the applicable bound is still withheld rather
than truncated, and the projection is computed in full before any byte is sent,
so a caller receives the whole note or an ordinary error.

Discovery is filtered separately from content reads. Production discovery —
`notesnook_search_notes`, notebook listing, and operator `browse`/`search` —
must suppress Vault-locked note titles and titles belonging to read-denied
notebooks before any result leaves the daemon, so a locked or denied note
cannot be enumerated by name. This is the S2 discovery-visibility security
requirement and holds independently of deployment state. Known-ID lock
protections are unchanged: reading a locked note by identifier returns
metadata with `contentStatus: "locked"` and never its content.

If an MCP client sends retrieved note content to a cloud model or another
external service, that disclosure is outside NookBridge's local encryption and
Unix-socket protections. Configure the client and its model/provider according
to the privacy requirements for the information it is allowed to retrieve.

Error diagnostics remain categorical and redacted. The MCP update tool's
optional refusal reason is a closed allowlist and is emitted only alongside
`invalid_request`; fixed messages do not expose parser text, request bodies,
paths, or upstream exceptions. `notes.get` may distinguish an unavailable
reader from a failed read with an optional categorical `contentReason`, but
never includes that field for locked or oversize content results. Older
reason-omitting result shapes remain valid; see the [MCP tool reference](reference/mcp-tools.md).

## Operator surface

Operator reads of a specific note - `nookctl notes get` and the edit preimage that `nookctl notes edit` fetches - are refused with `permission_denied` unless the note's handle was issued to the same caller, the note's notebook path resolves, and the notebook policy allows `read`.

A note that is not in any notebook (a root-level note) is always refused for these operator reads, and so is a note whose notebook cannot be resolved.

The operator socket serves only callers whose peer credentials resolve; a connection whose credentials cannot be read is closed before any request is handled.

Inside the daemon, the discovery runtime's `browse`, `search`, `view` and `create` entry points each refuse a call that carries no well-formed caller identity with `permission_denied`; there is no shared or anonymous identity.

Note handles, browse and search cursors, and recorded operations belong to the caller that created them and do not resolve for any other caller.

The daemon records an operator request it cannot answer when the runtime was
never wired, a categorized runtime refusal threw, an uncaught throw escaped, an
authorization step threw, a reply could not be serialized, a frame could not be
read, the method is not one this socket carries, or the peer could not be
identified. The frame case covers three causes that share one reason: the frame
did not parse, its declared length was zero or over the limit, or it overflowed
the frame limit while being read. Every record is written before any policy
decision, so a caller that is about to be denied can still produce one. The two
length checks run even earlier, before the caller is identified; the parse and
method records run after identification, because dispatch begins only once the
peer is known. A connection whose peer cannot be identified therefore records
`peer_unresolved` — unless the length checks already refused its frame, which
is recorded as `unparseable` instead, because that happens first.

A policy denial is not recorded: the caller already receives its categorical
reason. Five cases stay unrecorded because nothing was refused — the idle and
connection-lifetime timeouts, a client that leaves before or part-way through
its frame, one that finishes its frame and leaves before the daemon identifies
it, the drop made at the connection cap, and the idle sockets closed at
shutdown.

The record exists because the reply code cannot say which of these happened:
an unwired runtime and a throwing one both answer `service_unavailable`. Each
record carries the reply code — or `no_reply` when the connection closed
without an envelope — one of the fixed reasons above, and one of a fixed set of
error classes, plus a method only when the daemon could vouch for it. A frame
the daemon could not read, or one naming a method this socket does not carry,
has no method it can vouch for, and an unidentified peer was never asked for
one, so those record the fixed literal `(unattributed)` instead of any text
from the caller. No message, stack, cause,
parameter, handle, title, path, or request identifier reaches the log, so
neither the caller nor the upstream library can put text into it. Records are
capped per minute for each reason separately, so a client cannot flood the
journal and a flood of one kind cannot crowd out the `not_wired` line an
operator is looking for. Nothing is sampled: a window that had to drop records
reports the count on the next record for that reason, and at clean shutdown. A
crash or a kill loses that count.

The locked-note proof reports, for one exact note path, only `pathBytes` and one result each for `read`, `update` and `delete`. Each result is one of exactly five codes: `vault_locked`, `ok`, `not_found`, `permission_denied`, `service_unavailable`. The report never includes note text, titles, identifiers, revisions, paths, or error messages.

The proof never modifies an unlocked note: for an unlocked target it reports `read: ok` and `permission_denied` for `update` and `delete` without attempting either.

Outbound upload approval is a separate operator capability. `nookctl notes
approve-upload` runs only on an interactive terminal, displays metadata-only
blocking counts and the highest pending sequence, and requires the operator to
type that sequence exactly. It approves only operator- and unknown-origin
markers through the displayed bound; later writes remain blocked. The listing,
confirmation, result, and audit record contain no note identifiers, titles, or
paths. MCP has no approval method.

The terminal and the typed sequence are a safeguard in the CLI, not a check the
daemon can make. The `notes.approve-upload` RPC is a plain call: it takes no
proof that a person is present, and anyone who can read the preview can supply
its `highestSequence`. Echoing the sequence therefore guards against approving
more than was displayed (the daemon never approves above the number it is
given), not against a non-interactive caller. Membership of
`nookbridge-operators` is equivalent to upload authority. Keep that group to
the dedicated operator identity, which is the deployment invariant described in
the implementation plan under SR-9.

### Operator capability delegation

The service configuration may carry an optional `operatorAccess` block. It maps
principals (a group or a user, never both in one entry) to capability families:

```json
{
  "operatorAccess": {
    "version": 1,
    "principals": [
      { "group": "nookbridge-operators", "families": ["discover", "read", "write", "conflict", "admin"] },
      { "user": "<delegate-user>", "families": ["discover"] }
    ]
  }
}
```

The families are a closed table, and every operator method belongs to exactly
one of them; a method with no family cannot compile:

| Family | Methods |
| --- | --- |
| `discover` | `browse`, `search-operator`, `operation-status`, `operation-list` |
| `read` | `get-view`, `edit-preimage`, `inspect-conflict` |
| `write` | `create`, `apply-edit`, `apply-undo` |
| `conflict` | `resolve-conflict`, `abandon-resolve` |
| `admin` | `approve-upload`, `path_diagnostic`, `edit-census` |

- A peer's rights are the union of every entry that matches it. There are no
  deny entries.
- `admin` can be granted only to the base group `nookbridge-operators`.
- With no block, there is one implicit entry: the base group, holding all five
  families, with its gid resolved at startup where the user database can supply
  it. Every decision is then what it was before this change, except that an
  account whose effective gid is that group is now admitted — previously such a
  peer was refused everything, because its group list never names the group. A
  failed lookup falls back to matching by name alone, which is the old behaviour
  exactly. A block that is present replaces that implicit entry, so it must list
  the base group itself if the base group is to keep any family.
- The principal check runs first. A peer holding no grant for the method's
  family receives `permission_denied` before any handle is decoded, any lock
  state is read or any notebook policy is consulted. A grant then passes through
  the same target gates as before; it never bypasses them.
- For the mutating families (`write` and `conflict`), a delegated principal on a
  locked note gets `permission_denied`, while a peer granted through the base
  group gets `vault_locked`, so a delegate cannot probe which notes are locked by
  trying to change them. For `read` the authorizer does not consult lock state,
  so a delegate is admitted to a read wherever its own grant allows it, which is
  what a base-group peer sees when the base entry also holds `read`; the content layer
  still refuses a locked note's body to every peer and answers `vault_locked` to
  every peer, which means the read family has no lock-probe collapse. That
  asymmetry predates this change and is unchanged by it.
- A grant matches a peer by supplementary group name or by effective gid, so an
  account whose effective group is the granted group is still matched even though
  the peer's group list never names it. A `user` principal is enforced by the uid
  resolved at startup, so recycling a deleted account's uid would inherit the
  grant without a config change; a resolved gid has the same property, so
  reassigning that gid to another group would match the stale entry, including
  for the implicit policy.
- Each decision writes one audit line holding only the index of the matching
  entry and the family. It holds no principal name, handle, title or path.

Validation refuses to start the daemon, with a distinct closed code per
condition, and never repeats the offending value. Structural problems (unknown
keys, wrong types, empty lists, a principal naming both or neither of user and
group, an unsafe name, a repeated principal or family, an unknown family, `admin`
for a non-base principal) are caught when the configuration is loaded, including
by `nookd --check-config`. Three further checks run at startup against the
host's user and group database: a principal that does not resolve, a principal
that is privileged (uid or gid 0, or the daemon's own service uid, which is
refused with the same code), and a principal that cannot reach the operator
socket. A grant that no peer could ever use is refused rather than accepted
silently. The startup log records the closed code and the position of the
offending entry in `principals`, never its name. When the block is present, list
the base operator group's entry and ensure at least one member of that group is
in the socket group, otherwise startup refuses.

A delegated write principal still sees "allowed" versus `permission_denied` for a
target the notebook policy refuses; delegation narrows what the lock state
reveals, not the existence of the policy.

The empty-parameter form is a read-only preview: it returns those counts and
the highest sequence without changing markers or saving state.

For a locked target it attempts update and delete only with a deliberately mismatched revision.

The proof is authorized before its path is resolved: the caller needs read, edit and delete permission for that path, and a path the caller may not access returns `permission_denied` whether or not the note exists.

`nookctl notes get` returns the strict Markdown projection when the note decodes under the strict rules; otherwise it returns a read-only approximation in which unrecognised formatting is dropped, images appear as `[image]`, attachments appear as `[attachment: <name>]` or `[attachment]`, and no source URLs or attachment data are included. The approximation is not an edit preimage: `nookctl notes edit` still uses the strict decoding and reports such a note as unavailable for editing.

For detailed threat model, review evidence, and fail-closed requirements, see
the [implementation plan](implementation-plan-v1.5.md#9-security-and-privacy-model)
and [security reviews](security-reviews.md).

The SQLite storage wrapper, bundle-recovery probes and the live-login database
setup share one rule: a SQLCipher string key containing a double quote or a
backslash is refused before any handle is opened or any pragma is issued, never
stripped. Rejection uses a fixed categorical error without the key, a path, or a
cause; inspection and recovery probes map it to `unreadable`. Empty and
whitespace-only keys retain their existing behavior.
