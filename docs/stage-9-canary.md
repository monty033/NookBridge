# Stage 9 canary evidence

Status: **PASS WITH FOLLOW-UP — release blocked**

Date: 2026-09-05
Source under review: `ef5f53d040f5791a37e3761a09c5e42d9e4a4889`
Deployment source currently pinned: `9df0c341` before the separate pin PR

## Clean-VM canary

Command:

```text
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

The clean-VM result is insufficient for release approval until the target-host
canary is run against the reviewed source pin.
