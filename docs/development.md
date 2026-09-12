# Development

NookBridge uses a pinned Nix development shell. Run project checks inside it:

```bash
nix develop --offline --command just check
nix develop --offline --command just stage3-test
```

`package.json` is the canonical script layer; the `Justfile` provides thin
shortcuts. Keep `main` clean, branch from current upstream, and review the
exact diff before proposing changes.

The source checkout's administrative CLI is `dist/cli.js` after a build:

```bash
nix develop --offline --command npm run build
nix develop --offline --command node dist/cli.js help
```

The `nookctl` command name belongs to the deployment/package wrapper and is not
assumed to exist in an unbuilt checkout.

Do not inspect, commit, or share generated `var/` state. Do not use real
Notesnook credentials, MFA material, tokens, database keys, or note contents in
tests, fixtures, command arguments, environment snapshots, logs, or reviews.

For design intent and staged acceptance gates, see the
[implementation plan](implementation-plan-v1.5.md). For the pinned upstream
dependency assumptions, see the [upstream contract](upstream-contract.md).
