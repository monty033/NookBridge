# MCP tool reference

`nook-mcp` is a stdio proxy for the local `nookd` Unix socket. It has no
Notesnook credentials, database key, or state-directory access. The compiled
tool set is closed: it contains no generic RPC dispatcher, filesystem access,
authentication, Vault unlock, prompts, or resources.

Availability is determined by the root-owned daemon policy. A listed tool is
not automatically authorized for every deployed client.

| Tool | Purpose | Important constraints |
| --- | --- | --- |
| `notesnook_search_notes` | Search local note titles. | Non-empty query; optional `limit` 1–64 is currently accepted but not applied by the service. Returns title-only hits. |
| `notesnook_status` | Report bounded sync status. | No input; no credentials, paths, or note content. |
| `notesnook_list_notebooks` | List local notebooks. | No input; returns bounded identifiers, titles, and selected metadata. |
| `notesnook_get_note` | Retrieve bounded note metadata. | Requires an opaque note identifier; note body and attachments are excluded. |
| `notesnook_create_note` | Create one bounded note. | Requires title and content; optional notebook identifier. Authorization required. |
| `notesnook_append_note` | Append bounded Markdown. | Requires note identifier and expected revision. Authorization required. |
| `notesnook_update_note` | Update selected note fields. | Requires note identifier, expected revision, and a non-empty closed patch. Authorization required. |
| `notesnook_delete_note` | Move one exact-path note to trash. | Destructive, policy-controlled operation. It is not included in `readWriteNoDelete`. |
| `notesnook_sync` | Request outbound synchronization. | Explicit, policy-controlled operation; no caller-selected sync mode. |

## Bounds and failures

Inputs have fixed size and shape limits. The proxy validates before opening a
socket request, and the service validates again at its policy boundary. It
returns categorical errors rather than raw socket failures, upstream messages,
paths, credentials, revisions, or note content.

Write operations use optimistic revision checks. A stale revision, conflict,
locked Vault, unavailable service, or failed synchronization is an outcome to
handle explicitly; the proxy does not automatically resolve conflicts or retry
an unsafe operation.

The historical Stage 6 read-only contract is recorded in
[the MCP proxy record](../engineering/stages/stage-6-mcp-proxy.md). This reference describes the
current compiled tool definitions; keep both records accurate as the interface
changes.
