/**
 * Stage S7a-2 — whether the pinned core can list the dirty set read-only.
 *
 * Outcome NO: `@notesnook/core@8.1.3` offers no single public, complete,
 * read-only per-item dirty-set listing, so DR-S7a item 5 applies. See
 * `docs/engineering/stages/stage-s7a-dirty-set.md` for the evidence.
 */
export const DIRTY_SET_CAPABILITY = Object.freeze({
  available: false,
  coreVersion: "8.1.3",
  basis:
    "No single public read-only API lists everything a full sync would send: unsynced is @internal on notes and notebooks and omits pending file-blob uploads.",
});
