# Native horizontal-rule fidelity

This local promotion candidate adds horizontal-rule round trips to the versioned Markdown interchange on top of current `main`. It does not promote the whole beta branch and has not been deployed.

A structural rule is an exact standalone `---` block, separated from adjacent blocks by blank lines. Literal paragraph text containing only three dashes is emitted as `\-\-\-`; an unescaped rule line inside a paragraph is refused as ambiguous.

Other HR attributes/styles accepted by the HTML parser are retained as opaque native HTML so unrelated edits do not erase their semantics; this exception is HR-only and does not alter shared attribute tolerance.

Existing revision-bound opaque-reference preservation and task-list title protections remain in effect. Canonical rules are decoded structurally where the Markdown interchange can represent their container: at document level and in supported recursive block containers such as blockquotes/callouts. An ordinary `ul`/`ol` item continuation is not representable by the current interchange writer (`item.blocks` is rejected), so the smallest writable ancestor—the containing list—is retained opaquely when it has continuation children, including a canonical rule. This does not add ordinary-list continuation syntax; unrelated edits outside that list remain possible. Live client rendering fidelity has not been verified; image/reference-node encodings remain unsupported by this candidate.
