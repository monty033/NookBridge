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
| `notesnook_get_note` | Retrieve bounded note metadata, plus a bounded decoded Markdown content view when available. | Requires exactly one target form: an opaque note identifier (`id`); an exact `path` (`"Notebook/Sub/Title"`, or a bare title for a note in no notebook); or `notebookPath` + `noteTitle`. Path forms resolve through the same exact-path resolver as `notesnook_delete_note`, are authorized against the path's notebook before any read, and map ambiguous or malformed paths to `invalid_request`. When settings overrides are configured, the resolved note's actual notebook is authorized as well; a note in no notebook is evaluated under the reserved `<root>` notebook context (see below), for both `id` and path reads. A note is treated as outside every notebook only when that is positively confirmed (the relations lookup is available, the notebook list was not truncated, and every notebook probe answered no); if confirmation is unavailable the note stays `not_found`. Response includes `contentStatus`: `"ok"` (content attached as `markdown`/`markdownBytes`), `"locked"` (note is Vault-locked; metadata returned, content withheld, reader never invoked), `"oversize"` (content exceeds the response size bound; withheld), or `"unavailable"` (no content reader, or content could not be decoded). Attachments remain excluded. |
| `notesnook_create_note` | Create one bounded note. | Requires title and content; optional notebook identifier. Authorization required. |
| `notesnook_append_note` | Append bounded Markdown. | Requires note identifier and expected revision. Authorization required. |
| `notesnook_update_note` | Update selected note fields. | Requires note identifier, expected revision, and a non-empty closed patch. Authorization required. |
| `notesnook_delete_note` | Move one exact-path note to trash. | Destructive, policy-controlled operation. It is not included in `readWriteNoDelete`. |
| `notesnook_sync` | Request outbound synchronization. | Explicit, policy-controlled operation; no caller-selected sync mode. |

The Markdown returned by `notesnook_get_note` is a bounded, read-only projection and may be approximate: decoration is dropped and attachments may be represented by placeholders. It is not an edit preimage.

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

## Settings: the reserved `<root>` notebook context

`<root>` is simply the name of the notebook context that holds notes in no notebook. Treat it like any other notebook in permission rules: put it in an override's `notebooks` list, and apply the same read, edit, delete, and create permissions, defaults fallback, and specificity/precedence rules used for any notebook name. In particular, an explicit `<root>` rule beats `*`, just as an explicit notebook-name rule does. For read, edit, and delete, `*` matches confirmed root notes just as it matches notes in any notebook.

The differences are limited to these details:

- `<root>` is a reserved name, so it never matches a real notebook titled `<root>`.
- `*` does not match a create request that specifies no notebook.
- A note is treated as root only when its absence from every notebook is confirmed; otherwise it remains `not_found`.
- The loader accepts only exact `<root>` in `notebooks` lists. It rejects look-alikes such as `<ROOT>` and `<root>/x`, and rejects `<root>` in `notes` lists.
- A Vault-locked root note still returns `contentStatus: "locked"` with no content.
- Previously, evaluator rules always refused root notes. As a result, existing `*` allow rules now also reach confirmed root notes.
