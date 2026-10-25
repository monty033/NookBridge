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
(`contentStatus: "ok"`) for unlocked notes within the response size bound;
Vault-locked notes never have their content read (the reader is not called
once metadata reports `locked`) and oversize content is withheld
categorically. This is a deliberate, owner-authorized exposure for local/
self-hosted deployments: access is managed via Notesnook's own per-note Vault
lock and the deployment's permission settings, not by withholding content
from every caller.

The content bound is the response budget (`maxResponseBytes`, 65,536 bytes) less a fixed 1,024-byte envelope allowance and the note's metadata, measured as exact JSON-encoded UTF-8 size; text dense in control characters costs up to six bytes per character.

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

The locked-note proof reports, for one exact note path, only `pathBytes` and one result each for `read`, `update` and `delete`. Each result is one of exactly five codes: `vault_locked`, `ok`, `not_found`, `permission_denied`, `service_unavailable`. The report never includes note text, titles, identifiers, revisions, paths, or error messages.

The proof never modifies an unlocked note: for an unlocked target it reports `read: ok` and `permission_denied` for `update` and `delete` without attempting either.

For a locked target it attempts update and delete only with a deliberately mismatched revision.

The proof is authorized before its path is resolved: the caller needs read, edit and delete permission for that path, and a path the caller may not access returns `permission_denied` whether or not the note exists.

`nookctl notes get` returns the strict Markdown projection when the note decodes under the strict rules; otherwise it returns a read-only approximation in which unrecognised formatting is dropped, images appear as `[image]`, attachments appear as `[attachment: <name>]` or `[attachment]`, and no source URLs or attachment data are included. The approximation is not an edit preimage: `nookctl notes edit` still uses the strict decoding and reports such a note as unavailable for editing.

For detailed threat model, review evidence, and fail-closed requirements, see
the [implementation plan](implementation-plan-v1.5.md#9-security-and-privacy-model)
and [security reviews](security-reviews.md).
