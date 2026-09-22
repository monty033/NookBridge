# Versioning and releases

## Policy

NookBridge uses Semantic Versioning with a deliberate pre-1.0 policy. The
project is still pre-alpha, so the public release line begins at `0.1.0`, not
`1.0.0`.

The project does not use `alpha`, `beta`, or `rc` suffixes by default. A
pre-release suffix is appropriate only when there is a real staged testing
cycle that needs to distinguish candidate builds from the normal release line.

## Version meanings before 1.0

Until the project reaches `1.0.0`:

- **Patch** (`0.1.1`) means a backward-compatible bug fix, security fix,
  documentation correction, or packaging correction.
- **Minor** (`0.2.0`) means a new capability, meaningful behavior change, or
  intentional pre-1.0 contract change.
- **Major** (`1.0.0`) is reserved for the first stable public API and supported
  operational contract.

A release note must call out any compatibility or migration impact even when
SemVer permits the change under the pre-1.0 policy.

## Version sources and synchronization

The version must be synchronized across these surfaces:

1. `package.json` is the machine-readable project version.
2. `package-lock.json` repeats the root package version and must match it.
3. Git tags use the `v<VERSION>` form, such as `v0.1.0`.
4. Linux artifact names, manifests, installer pins, and release records use the
   same version.

A release is not complete if these values disagree. Local build directory names
and candidate labels are not releases and must not be presented as official
versions.

## Release rules

- Tag only a canonical merge commit on Forgejo `main`.
- Run the project checks and artifact verification before tagging.
- Do not move an existing tag to a different commit.
- Do not reuse a released version for different contents.
- Forgejo is canonical; the tag-triggered workflow publishes the corresponding
  public GitHub release and assets.
- Keep the release description focused on user-visible behavior, verification,
  known limitations, and upgrade notes.

The historical `v1.2.6` tag is outside this policy. If it is retired before
`v0.1.0`, it must not be reused or repointed. The new release line starts at
`v0.1.0` on the canonical merge commit selected for that release.

## When NookBridge reaches 1.0

`1.0.0` should wait until these conditions are true:

- the MCP and operator contracts are intentionally stable;
- supported installation, upgrade, rollback, and recovery paths are documented
  and tested;
- the sync lifecycle and mutation boundaries are operationally understood;
- release artifacts and version metadata are consistently generated and
  verified; and
- remaining production-MVP gaps are either closed or explicitly outside the
  support promise.

Until then, the `0.x` line is an honest signal that users should expect change.

## Release checklist

1. Confirm the intended version in `package.json` and `package-lock.json`.
2. Update `CHANGELOG.md` with user-visible changes and limitations.
3. Run checks, typecheck, lint, formatting, build, and artifact verification.
4. Merge the release-ready change into Forgejo `main`.
5. Create `v<VERSION>` on the canonical merge commit.
6. Push the tag and allow Forgejo Actions to build and publish the candidate.
7. Verify the artifact manifest, checksums, release assets, and installer URL.
8. Promote or announce the release only after the release gates pass.
