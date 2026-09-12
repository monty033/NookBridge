# Documentation maintenance

## Source-of-truth hierarchy

1. The implementation and tests define the current executable behavior.
2. User guides in `docs/` describe supported operator and MCP workflows.
3. Stage records, the implementation plan, security reviews, and upstream
   contract preserve decisions, evidence, and historical acceptance gates.

When these disagree, do not silently choose the more permissive claim. Correct
the user guide to the verified behavior and update or annotate the historical
record with the scope/date of the change.

## Change checklist

Update the documentation in the same change whenever modifying:

- the MCP tool allowlist, input/output boundary, or service policy;
- an operator command, approval gate, credential carrier, or recovery path;
- the NixOS deployment/secret/configuration contract;
- a supported-platform or release-status claim; or
- a privacy, logging, storage, or network boundary.

Keep the README concise and route detail through the guide pages. Never place
secrets, state contents, production account details, or raw diagnostic output
in documentation, examples, screenshots, or release notes.

## Review

Before merging documentation changes, check local Markdown links, run
`git diff --check`, and have a maintainer familiar with the relevant security
boundary review operational instructions. Run the normal project checks when a
documentation change accompanies code or configuration changes.
