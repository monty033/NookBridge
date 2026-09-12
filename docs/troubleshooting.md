# Troubleshooting and recovery

## Start with categorical diagnostics

Use the deployed command's help (or `node dist/cli.js` in a built source
checkout) and safe inspection commands before changing state:

```text
nookd --check-config <absolute-config-path>
nookctl doctor
nookctl settings validate
```

These commands are designed to avoid printing credentials, note contents, and
raw upstream failures. Record only their categorical outcome when seeking help.

## Common operating rules

| Situation | Safe response |
| --- | --- |
| Daemon cannot start | Check root-owned configuration and systemd credential delivery; do not add a plaintext fallback or generate a replacement key. |
| MCP client cannot connect | Confirm its account belongs to the approved socket group and that it has no direct state-directory access. |
| Authentication needs renewal | Re-run root-operated interactive provisioning from a real TTY; never provide credentials through MCP. |
| State appears damaged | Stop the service, preserve the directory and metadata, then investigate through an approved root-operator procedure. |

## Local-state recovery

`nookctl recover-local-state inspect` provides bounded, non-destructive
inspection. Reinitialization and rollback require explicit approval flags and
should be performed only by an operator who understands the recovery procedure.
Do not delete the state directory to “fix” a problem.

See [Stage 9 recovery readiness](engineering/stages/stage-9-recovery.md) for the current recovery
evidence and remaining release gates.
