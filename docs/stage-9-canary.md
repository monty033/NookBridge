# Stage 9 canary evidence

Status: **Historical baseline — superseded by current-pin evidence below**

Date: 2026-09-05
Source candidate under review: `94ad5c0a`
Deployment/source used by the external VM baseline: `1f433a421881031c407d84ab977ffda57d72c99c`

The VM evidence below was produced from `/var/lib/hermes/workspace/nix-config`
on the separate pin branch, not from this source repository. It is baseline
evidence only and does not substantiate the source candidate until the pin is
updated and the checks are rerun.

## Historical external clean-VM baseline (2026-09-05)

Command:

```text
cd /var/lib/hermes/workspace/nix-config
nix build --no-link .#checks.x86_64-linux.nookbridge-isolation
```

Result: **PASS**.

The VM test asserts:

- `nookd.service` reaches active/running;
- service identity is `nookbridge:nookbridge-clients`;
- state and runtime directory ownership/modes are restricted;
- socket ownership is `nookbridge:nookbridge-clients`, mode `0770`;
- a `nookbridge-clients` member connects;
- an outsider is denied;
- client users cannot read service state or the root-only credential;
- the runtime-generated fixture is absent from the built package output.

The fixture is generated from `/dev/urandom` at VM boot and is never embedded
in Nix expressions, derivations, logs, or this report.

## Historical target-host canary checklist (superseded by current-pin evidence below)

Status: **NOT RUN**.

The target host requires the Nix source-pin change and a user-authorized
`nixos-rebuild switch` handoff. No rebuild, service restart, or live write was
performed during this review.

Required target-host receipt:

1. verify the deployed derivation resolves to the reviewed source revision;
2. verify `nookd.service` active state and the socket owner/group/mode;
3. run bounded read-only MCP/RPC smoke calls with explicit timeouts;
4. verify outsider denial and state/credential non-readability;
5. run the controlled plaintext-canary scan without printing the canary;
6. record rollback/restart state before any write-policy change.

## Historical baseline decision (2026-09-05)

The external baseline result was insufficient for release approval until the
source pin was updated, the VM check was rerun against the reviewed candidate,
and the target-host canary was run against that same pin.

## Current deployed-pin evidence (2026-09-07)

Status: **PASS WITH FOLLOW-UP — Stage 9 release remains blocked**.

- **Source/pin:** NookBridge `9260c6c507db02555046a905d8e7d77ad74865f0`, consumed by nix-config PR #302 merge `1ec85850aad321fe339fe215b8d0b18e20f5e701` (pin-change head `fe951b6aabde4bcb8d8a7d4a0c843002cb98a8b9`).
- **Isolation VM:** `nix build --no-link .#checks.x86_64-linux.nookbridge-isolation` passed against the current merged pin.
- **Runtime:** `nookd`, `hermes-agent`, and `hermes-dashboard` are active on the `gsg2b1` NookBridge derivation; the installed service config passes; the socket is owned by `nookbridge:nookbridge-clients` with mode `0770`.
- **MCP smoke:** the deployed `nook-mcp` completed initialize, `tools/list`, and bounded tool calls through the Unix socket.
- **Remote-deletion canary:** the agent-created title `NookBridge phone deletion canary 2026-09-07T18:01:06Z` was deleted on the phone. Explicit `notesnook_sync` returned `synced`, `pendingSync:false`, `attempts:1`; an exact-title search returned **0 hits**.

This is fresh target-host operational evidence for the deployed pin. It does
not claim the full Stage 9 gate: the current red-team suite still lacks
coverage for outbound sync/reconcile under the deployed `readWriteNoDelete`
policy; RT-4 resource soak, RT-6/RT-9 plaintext-canary scans, and RT-8
outsider/state/credential recheck remain open; and the recovery drill and
license review remain open.
