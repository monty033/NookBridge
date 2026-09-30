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

## Symptom-specific checks

| Symptom | Safe diagnostic | Supported next step |
| --- | --- | --- |
| Socket permission denied | Check `systemctl is-active nookd.service`, the configured socket path, and whether the client account belongs to the intended client/operator group. Do not inspect or expose state files. | Have the administrator correct deployment group/policy configuration and restart through the host's normal change process. Do not broaden socket permissions as a workaround. |
| Settings validation fails | Run `nookctl settings validate`; inspect the root-owned settings file against the [version 1 schema](configuration.md#settings-json-schema-version-1). | Correct the schema error using the deployment's authorized configuration process. Nix-managed installs must edit deployment source, not use CLI `edit`/`reset`. |
| Provisioning fails | Check service status with `systemctl status nookd.service --no-pager` and validate its configured absolute service-config path with `nookd --check-config <absolute-config-path>`; note only categorical outcomes. | Use the root-operated `notesbridge provision` wrapper from a real host TTY after configuration/credential delivery is corrected. Never pass credentials in argv, environment, or configuration. |
| Fetch-only sync fails | Check daemon state with `systemctl is-active nookd.service`; capture the wrapper's exit status and categorical output. | Resolve the reported service/configuration issue, then let an authorized operator decide whether to retry `notesbridge sync`. It is fetch-only; do not substitute generic/full sync or repeat uncertain mutations. |
| Recovery asks for approval or rollback fails | Start with `nookctl recover-local-state inspect` (read-only). Review [recovery readiness](engineering/stages/stage-9-recovery.md) before any mutation. | Reinitialization requires the exact `--approve-reinitialize` flag; rollback requires `--approve-rollback <opaque-id>`. Both are deliberate operator mutations, not routine repair. Rollback refuses an occupied destination; do not remove or replace state to bypass that refusal. |

The settings validator command is read-only. Recovery commands preserve state
by quarantine and refuse clobbering; they are not a substitute for a reviewed
recovery procedure.

## Local-state recovery

`nookctl recover-local-state inspect` provides bounded, non-destructive
inspection. Reinitialization and rollback require explicit approval flags and
should be performed only by an operator who understands the recovery procedure.
Do not delete the state directory to “fix” a problem.

See [Stage 9 recovery readiness](engineering/stages/stage-9-recovery.md) for the current recovery
evidence and remaining release gates.
