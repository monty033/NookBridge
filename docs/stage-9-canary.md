# Stage 9 canary evidence

Status: **PASS WITH FOLLOW-UP — release blocked**

Date: 2026-09-05
Source candidate under review: `94ad5c0a`
Deployment/source used by the external VM baseline: `1f433a421881031c407d84ab977ffda57d72c99c`

The VM evidence below was produced from `/var/lib/hermes/workspace/nix-config`
on the separate pin branch, not from this source repository. It is baseline
evidence only and does not substantiate the source candidate until the pin is
updated and the checks are rerun.

## External clean-VM baseline

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

## Target-host canary

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

## Decision

The external baseline result is insufficient for release approval until the
source pin is updated, the VM check is rerun against the reviewed candidate,
and the target-host canary is run against that same pin.
