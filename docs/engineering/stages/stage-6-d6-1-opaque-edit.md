# D6-1: opaque-block editing

D6-1 records the resolved decision that notes containing images, attachments or
embeds remain editable. The Markdown editor exposes one bounded opaque
placeholder per preserved native block; it never exposes the block's source,
attachment data, or path.

Opaque placeholders are revision-bound. The native decoder derives each
sentinel from the note binding, block position, and stored block bytes. The
operator edit path compares the complete ordered sentinel set against the
trusted preimage before it creates an operation record or calls the content
writer. Moved, deleted, duplicated, altered, forged, and stale placeholders
therefore fail with the existing `invalid_request` category and leave the note
and operation store unchanged.

When only ordinary text changes, the native serializer restores every trusted
opaque block from its private context exactly as stored. Undo uses the durable
native preimage and restores those bytes exactly. The read-only `notes.get-view`
projection remains unchanged and no MCP schema is changed by this slice.

The operator-runtime regression coverage is in
`tests/stage-9-notes-operator-write-runtime.test.ts`; the read-only projection
coverage is in `tests/stage-11-operator-discovery-runtime.test.ts`. The
baseline test is named `baseline: edits text while preserving image,
attachment, and embed blocks byte-for-byte`.

Notes containing images, attachments or embeds are editable, and their preserved blocks are kept exactly as stored.
