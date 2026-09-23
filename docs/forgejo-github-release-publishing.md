# Forgejo-to-GitHub release publishing

Forgejo is the canonical NookBridge repository. GitHub is the public
distribution mirror because the Forgejo instance is not publicly reachable by
end users.

## One-time setup

Create a GitHub fine-grained token restricted to the
`monty033/NookBridge` repository with **Contents: Read and write** permission.
Store it in the Forgejo repository secret:

```text
RELEASE_PUBLISH_TOKEN
```

The preflight lookup needs no secret. The Actions API of a public repository is
readable anonymously, and the workflow deliberately sets no token for that step, so
no credential is reachable by code from the tag being released. A read that is
refused is an error rather than an empty result, so the gate still fails closed.

This means the workflow requires an anonymously readable Actions API on the canonical
host. If that API is private, a tag-triggered release cannot perform its preflight and
will fail with a message saying so. The checker accepts `PREFLIGHT_READ_TOKEN` from the
environment for that case, and the operator command reads it, so the supported answer
is to run the preflight locally before pushing the tag rather than to hand a read
token to a step that executes code from the tag being released.

Do not put a token in the repository, workflow YAML, a commit, or a chat message.
The publish token is used only by the tag-triggered publishing step, which runs the
runner's own tools over a data file and executes no script from the released
revision. Pull request and branch builds do not receive the secret, and the
source-controlled build, test, and verification steps explicitly receive an empty
`GITHUB_TOKEN`.

## Publishing a release

1. Merge the source change into Forgejo `main`.
2. Wait for the `main` runner-preflight workflow for that exact merge commit to
   finish successfully. Do not tag while it is queued or failed. For a
   release-sensitive workflow change before merge, use a `runner-test/<name>`
   branch first and require the same artifact-build and verifier pass.
3. Create and push the version tag selected by the [versioning and releases policy](versioning-and-releases.md). Use the release command, which re-checks the
   version surfaces, the existing tags, and this preflight before it pushes:

   ```bash
   just release-status   # read-only: confirm the release is ready
   just release          # tag, push, wait for the candidate run
   ```

   The equivalent manual steps are:

   ```bash
   git tag -a v0.1.0 -m 'NookBridge v0.1.0' <canonical-merge-sha>
   git push upstream v0.1.0
   ```

4. Forgejo Actions runs `.forgejo/workflows/linux-artifact.yml`.
5. The workflow runs the full build/test gate, builds and verifies the Linux
   artifact, creates the matching GitHub release, and uploads:

   - `install.sh`
   - `install-systemd.sh`
   - `verify-linux-artifact.sh`
   - `SHA256SUMS`
   - `nookbridge-v<VERSION>-linux-x64-gnu.tar.gz`

The workflow is recoverable for a tag. A run that fails partway through its uploads
leaves a partial candidate, and the tag cannot be moved to another version, so a
re-run deletes that candidate and recreates it from its own build before uploading:
retrying is the documented recovery. An existing release is only touched when it is
the matching candidate for this tag — same commit, still a prerelease, not a draft —
and the run ends by reading the release back and asserting its exact asset set.

## Why the workflow is needed

Git push mirroring transfers commits, branches, and tags. Release records and
uploaded release assets are not Git objects, so they need this explicit
publisher step. The installer continues to use the public GitHub release URL.