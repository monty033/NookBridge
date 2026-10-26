# D6-1: opaque-block editing

D6-1 records the resolved decision that notes containing images, attachments or
embeds remain editable. The Markdown editor exposes one bounded opaque
placeholder per preserved native block; it never exposes the block's source,
attachment data, or path.

Opaque placeholders are revision-bound. The native decoder derives each
sentinel from the note binding, the depth-first traversal index, and the stored
block bytes. A traversal-order change therefore silently invalidates every
live preimage and turns an ordinary edit into `invalid_request`. The operator
edit path compares the complete ordered sentinel set against the trusted
preimage before it creates an operation record or calls the content writer.
Moved, deleted, duplicated, altered, forged, and stale placeholders therefore
fail with the existing `invalid_request` category and leave the note and
operation store unchanged.

When only ordinary text changes, the native serializer restores every trusted
opaque block from its private context exactly as stored. The placeholder shape
and projection schema remain unchanged, but sentinels are now revision-scoped;
the placeholder node-type label is not a separate component of the native hash,
but it remains part of the ordered structural preimage comparison, so changing
`img` to `embed` is refused. `notes.get` and `notes.get-view` use the same
`[noteId, revision]` binding when strict decoding succeeds; their tolerant
read-only fallback emits no opaque sentinels and is not apply-ready. A note
carrying any attribute outside the strict allowlist cannot be edited through
this surface; the operator must inspect it directly or re-apply the change by
hand after correcting the unsupported content. If the stored content is
available only through that tolerant decoder, the operator write path reports
`service_unavailable` before any mutation. Undo uses the durable native
preimage and restores those bytes exactly; `apply-undo` takes no Markdown, so
there are no sentinels to revalidate. An unresolved operation is permanently
inert and cannot be undone: the note remains at its last known state, and the
operator's only recourse is to inspect state directly or re-apply the change by
hand.
The read-only `notes.get-view` route retains its bounded projection shape, and
no MCP schema is changed by this slice.

The operator-runtime regression coverage is in
`tests/stage-9-notes-operator-write-runtime.test.ts`; the read-only projection
coverage is in `tests/stage-3-read-only-sync.test.ts` and
`tests/stage-11-operator-discovery-runtime.test.ts`. The
baseline test is named `baseline: edits text while preserving image,
attachment, and embed blocks byte-for-byte`.

Notes containing images, attachments or embeds are editable, and their preserved blocks are kept exactly as stored.
