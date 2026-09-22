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

Create a separate read-only token that can list Actions runs for the canonical
repository, with no write or release permissions. Store it as:

```text
RELEASE_PREFLIGHT_TOKEN
```

Do not put either token in the repository, workflow YAML, a commit, or a chat
message. The publish token is used only by the tag-triggered publishing steps;
the read-only preflight token is used only to verify the prior `main` run. Pull
request and branch builds do not receive either secret, and source-controlled
build/test steps explicitly receive an empty `GITHUB_TOKEN`.

## Publishing a release

1. Merge the source change into Forgejo `main`.
2. Wait for the `main` runner-preflight workflow for that exact merge commit to
   finish successfully. Do not tag while it is queued or failed. For a
   release-sensitive workflow change before merge, use a `runner-test/<name>`
   branch first and require the same artifact-build and verifier pass.
3. Create and push the version tag selected by the [versioning and releases policy](versioning-and-releases.md), for example:

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

The workflow is idempotent for a tag: an existing GitHub release is reused and
same-named assets are replaced before the final asset-set check.

## Why the workflow is needed

Git push mirroring transfers commits, branches, and tags. Release records and
uploaded release assets are not Git objects, so they need this explicit
publisher step. The installer continues to use the public GitHub release URL.