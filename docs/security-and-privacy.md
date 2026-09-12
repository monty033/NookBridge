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

If an MCP client sends retrieved note content to a cloud model or another
external service, that disclosure is outside NookBridge's local encryption and
Unix-socket protections. Configure the client and its model/provider according
to the privacy requirements for the information it is allowed to retrieve.

For detailed threat model, review evidence, and fail-closed requirements, see
the [implementation plan](implementation-plan-v1.5.md#9-security-and-privacy-model)
and [security reviews](security-reviews.md).
