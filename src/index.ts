/**
 * NookBridge Stage 0 source root.
 *
 * Stage 0 establishes a reproducible baseline only. It does NOT introduce
 * persistence, authentication, sync, or any @notesnook/core adapter.
 *
 * The export surface here is intentionally tiny. It exists so:
 *   1. The package builds (`tsc -p tsconfig.build.json`) and emits dist/.
 *   2. There is a documented Stage 0 boundary that future stages will
 *      extend.
 *   3. The test suite has something real to import and assert on
 *      without Stage 1 application logic.
 */

export const NOOKBRIDGE_STAGE = "stage-0-baseline" as const;

/**
 * Stage 0 version constant. Bumped by hand when the baseline changes.
 * Stage 1 will introduce a real `version.ts` derived from git tags.
 */
export const STAGE_0_VERSION = "0.0.0-stage.0" as const;

/**
 * The upstream Notesnook monorepo commit SHA that this baseline pins.
 *
 * This is the SHA the Stage -1 spike validated against and that Stage 0
 * declares in `docs/pins.md` and `docs/upstream-contract.md`. It is exported
 * as a typed constant so tests can assert the contract rather than reading
 * a markdown file.
 */
export const PINNED_NOTESNOOK_MONOREPO_SHA = "c9c4936d9e8222b86204781cd1c93cdf2a1738d3" as const;

/**
 * The pinned @notesnook/core package version this baseline is built
 * against. The actual runtime import of @notesnook/core is Stage 1 work.
 */
export const PINNED_NOTESNOOK_CORE_VERSION = "8.1.3" as const;

/**
 * The Nixpkgs revision this baseline is pinned to (see flake.lock).
 */
export const PINNED_NIXPKGS_REV = "5880666fd9eb563038431edb35c2d0aa595884e6" as const;

/**
 * Stage 0 has no application behaviour. The `baseline` object is a
 * placeholder for what Stage 1 will replace with a real client handle.
 */
export const baseline = Object.freeze({
  stage: NOOKBRIDGE_STAGE,
  version: STAGE_0_VERSION,
  notesnookMonorepoSha: PINNED_NOTESNOOK_MONOREPO_SHA,
  notesnookCoreVersion: PINNED_NOTESNOOK_CORE_VERSION,
  nixpkgsRev: PINNED_NIXPKGS_REV,
});

export default baseline;
