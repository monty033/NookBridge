# Stage S7a-2 — Can the pinned core list the dirty set read-only?

## Conclusion

**Outcome NO.** Public read-only per-item queries do exist in `@notesnook/core@8.1.3`: `unsynced(chunkSize)` on nine managers and `attachments.pending.items()`. What is missing is a single public, complete one that returns item identities for everything `syncer.start({type:"full"})` would send. In that sense there is no read-only dirty-set API, and **DR-S7a item 5 applies** (DR-S7a item 4 cannot be built on upstream). `DIRTY_SET_CAPABILITY` in `src/core/notesnook-dirty-set.ts` records `available: false`. No probe, mechanism or database access was built.

## Scope

- Core version: `@notesnook/core` **8.1.3** (`package.json` dependency and installed `node_modules/@notesnook/core/package.json` both read `8.1.3`).
- Searched: `node_modules/@notesnook/core/dist/index.d.ts` (2153 lines; the only declaration file the typed entry `types` field names. Its imports are third-party packages and not part of the core surface). `dist/index.js` was read only to verify behaviour of candidates.
- Criteria (all must hold):
  1. public typed surface reachable from `Database`;
  2. not sql/kysely/raw/underscore/private/`@internal`/`syncer`/`SyncCollector`/collector internals;
  3. returns item identities;
  4. covers every item a `full` sync would send, **including file-blob uploads** (not only every entry of the collector's collection map);
  5. no mutation, no network.

## Search terms and hits (`dist/index.d.ts`)

| Term | Hits | Verdict |
|---|---|---|
| `getUnsynced` | none | no candidate |
| `dirty` | none | no candidate |
| `SyncCollector` | none in the declarations (only a logger scope string in `index.js`) | no candidate |
| `hasUnsyncedChanges` | `index.d.ts:1272` (`Collector`), `index.d.ts:2108` (`Database`) | `Promise<boolean>`: **fails 3** (no identities). `:1272` also fails 2 (collector internals) |
| `pending` | `index.d.ts:893` (`private pending`), `index.d.ts:1718` (`Attachments.pending: FilteredSelector<Attachment>`) | `:893` fails 2 (private). `:1718` is a public getter (no `@internal` tag) and read-only, but covers attachments only: **fails 4** alone |
| `localOnly` | `index.d.ts:126, 212, 280, 288, 309, 320` (item fields), `1140` (`Notes.localOnly(state, ...ids)`, a mutator), `1179`, `1704` (`localOnly` parameters) | item flag / mutator, not a dirty-set listing: **fails 3**; `:1140` also mutates (**fails 5**) |
| `collect` | `index.d.ts:1273` (`Collector.collect(...)`: async generator of encrypted `SyncTransferItem`s), plus unrelated `Collections`/`collection` hits (`29, 52, 53, 469-494, 1049-1864`, …) | `:1273` fails 2 (collector internals) and 5 (its implementation sets `synced: true` after yielding) |
| `synced` | `index.d.ts:93, 383` (the optional `synced?: boolean` column), `549, 2105-2106` (`lastSynced`, `setLastSynced`) | `synced` column: **fails 2**; `lastSynced` is a timestamp: fails 3 |
| `unsynced` / `unsyncedCount` | `index.d.ts:503, 508` (`DatabaseCollection` interface), `1070, 1071` (`SQLCollection`), `1821, 1823` (`SQLCachedCollection`) | `unsyncedCount()` is a number: **fails 3**. `unsynced`: see "Closest candidate" |

## Collector collection list (declarations)

`index.d.ts:1250-1262` (`SYNC_COLLECTIONS_MAP`), consumed by the `Collector` class at `index.d.ts:1268`. Collected item types and their collections:

`settingitem→settings`, `attachment→attachments`, `content→content`, `notebook→notebooks`, `shortcut→shortcuts`, `reminder→reminders`, `relation→relations`, `tag→tags`, `color→colors`, `note→notes`, `vault→vaults`.

## Closest candidate: `database.<manager>.collection.unsynced(chunkSize)`

`unsynced` is declared at `index.d.ts:1071` (SQL collections) and `index.d.ts:1821` (cached `settings`/`shortcuts`). It is the same call `Collector.collect` makes. Criterion by criterion:

1. **Reachable from `Database`: partly.** Every manager is a `Database` member and has a `collection`.
2. **Fails (hard).** The `collection` members of `Notes` (`index.d.ts:1117-1120`) and `Notebooks` (`index.d.ts:1192-1195`) are tagged `@internal`. Only nine of the eleven collected collections (`settings`, `attachments`, `content`, `shortcuts`, `reminders`, `relations`, `tags`, `colors`, `vaults`) are reachable without an `@internal` member, and notes and notebooks are the two that matter most. Covering all eleven would require an `@internal` read.
3. **Passes.** Rows are the stored items and carry an `id`; the collection is known from the manager.
4. **Fails at item level.** All 11 entries of the collector map expose `unsynced`, so the collection-map reading passes. But a `full` sync also runs `uploadAttachments()` (`dist/index.js`, `SyncManager.send`), which queues file-blob uploads from `db.attachments.pending` (`dateUploaded` falsy and not deleted). `attachments.collection.unsynced` keeps only `dateUploaded > 0` or deleted rows, so it excludes exactly those. No single API lists every item a `full` sync would send, and joining `unsynced` with `attachments.pending` would be a composition across 11 managers, two of which are `@internal`.
5. **Passes.** `unsynced` is a plain select chain (`dist/index.js:1397-1418`; the cached collections read an in-memory cache at `dist/index.js:9834-9846`). It does not mutate and makes no network call. Criterion 5 is not a reason for the NO.

The NO therefore rests on criterion 2 (two `@internal` collections) and on criterion 4 at item level (the pending-attachment gap). A wrong YES would let unapproved items upload; a wrong NO only falls back to the stricter item 5.

## Consequence

DR-S7a item 5 applies: upstream offers no single public, complete, per-item dirty-set listing, so the upload boundary is enforced wholesale rather than per item. S7a-4 must not build on a probe. The drift guard in `tests/stage-7-dirty-set.test.ts` fails if the installed core version changes, which forces this finding to be re-evaluated for DR-S7a items 4 and 5.
