# Exact Steam-App-ID Correlation (replacing fuzzy title matching)

Status: Draft — approved for planning
Date: 2026-07-22

## Summary

Replace SteamUReady's fuzzy game-name correlation with exact Steam-App-ID
matching, now that EmuReady's Steam-App-ID endpoints work again (EmuReady PR
[#342](https://github.com/Producdevity/EmuReady/pull/342), merged 2026-05-07).
This is a fix to the **already-deployed** app's correlation layer, and it is
sequenced **before** the three planned feature specs (accounts, Steam import,
email alerts) because it corrects the data flow they all build on.

## Background — why fuzzy matching existed

Correlation (matching an EmuReady game to a store deal) has been **fuzzy
name matching since the first commit**, through two rewrites:

- Initial release: `Fuse.js` fuzzy matching of EmuReady `game.title` against
  Steam game names (via a since-deleted `services/steam.js`), with an
  `isValidMatch()` guard and a `matchScore`.
- ITAD switch (`13c5129`): deleted the Fuse.js path, replaced it with ITAD's
  fuzzy title lookup (`/lookup/id/title/v1`). Still name-based, still fuzzy —
  the fuzziness just moved to ITAD's server. Steam App IDs were then derived
  *secondhand* from the matched ITAD UUID (`/lookup/shop/61/id/v1`).

The exact key — **Steam App ID** — was never usable for correlation because
EmuReady's `games.getBestSteamAppId` / `games.batchBySteamAppIds` endpoints
returned empty on every request. Root cause (fixed by PR #342): Valve removed
`ISteamApps/GetAppList/v2` (now HTTP 404), and EmuReady's silent catch left
its Steam-games cache perpetually empty. PR #342 migrated EmuReady to
`IStoreService/GetAppList/v1` (needs a `STEAM_API_KEY` on *EmuReady's* side,
not ours) and the endpoints now work.

Verified live during this design (2026-07-22):
- `games.getBestSteamAppId({gameName})` returns exact App IDs — e.g.
  `"Hollow Knight" → {found:true, appId:"367520"}`. Across 21 real EmuReady
  Windows titles, 20 resolved (95%); the one miss was a bracketed-edition
  title (`Need for Speed: Carbon [Collector's Edition]`) that also breaks
  ITAD's title matcher.
- `games.batchBySteamAppIds({steamAppIds})` returns, per game,
  `matchStrategy:"exact"`, the full game record, and nested `listings` with
  device+SoC, emulator, and performance rank — filtered to our emulators.

## Scope

- **Rework the main (forward) correlation flow** in `services/store.js` and
  `services/emuready.js` to be exact.
- **Delete the fuzzy title-matching path** as the primary mechanism (kept only
  as a fallback for games with no resolvable Steam App ID).
- **Make `steam_app_id` authoritative** (sourced from EmuReady) instead of
  derived secondhand from ITAD.
- **Out of scope here:** the reverse library-compatibility feature powered by
  `batchBySteamAppIds` — that belongs to the Steam-import spec (this rework
  only adds the `batchBySteamAppIds` wrapper if convenient; the feature itself
  is specced there). The main correlation stays **forward** because the
  EmuReady catalog (~2–3k games) is the small bounded set, whereas enumerating
  all ITAD Steam deals is ~12k+ games even in a non-sale week (measured), so
  reverse correlation would cost ~150–400 ITAD calls + minutes of enumeration
  per refresh versus ~15 today, and would lose server-side device filtering.

## Direction decision (forward, not reverse)

`batchBySteamAppIds` maps Steam App IDs → EmuReady games, so it needs App IDs
as input and cannot *discover* the catalog. Discovery must come from
EmuReady's `listings.get` regardless (it also provides server-side
device/SoC filtering). Therefore the main flow resolves the bounded EmuReady
catalog **forward** (title → App ID → exact ITAD match). `batchBySteamAppIds`
is reserved for the reverse case where the App IDs are already known and
bounded — the user's own Steam library, in the Steam-import spec.

Measured basis for this decision (2026-07-22):
- ITAD `/deals/v2` (Steam, US) returned **>12,000** current deals in a
  non-sale week (paged 200 at a time, ~1.5s/page ≈ 98s for 12k, and more
  remained); a major sale is 30–40k+.
- ITAD deal items are keyed by ITAD UUID, **not** Steam App ID, so reverse
  would also need ~75–200 extra batched UUID→App-ID lookups before even
  calling `batchBySteamAppIds`.
- `listings.get`'s game object has **no** `steamAppId` field (confirmed), so
  the forward flow still needs a per-title resolver — `getBestSteamAppId` —
  which is why that step remains.

## New data flow (`services/store.js` `resolveTitlesBatch`)

Per uncached title (results cached permanently in `game_titles`, so only
brand-new titles ever hit these calls):

1. **`title → games.getBestSteamAppId(title)`** → authoritative
   `steam_app_id` (EmuReady-curated, ~95%). *(new — replaces the fuzzy ITAD
   title lookup as the primary path)*
2. **`steam_app_id → itad_id`** via ITAD `/lookup/id/shop/61/v1` (exact,
   batched 200 per call). *(replaces deriving the App ID secondhand from a
   fuzzily-matched ITAD UUID)*
3. **Fallback** for games where step 1 returns `found:false` (the ~5% + any
   Epic/GOG-exclusive with no Steam presence): the existing
   `title → ITAD /lookup/id/title/v1` fuzzy lookup → `itad_id`, with
   `steam_app_id` left null. These still appear if they have an Epic/GOG deal.
4. **Image**: prefer EmuReady's `boxartUrl`/`imageUrl` (already present on
   listings) or the Steam header derived from the now-authoritative App ID.

Everything downstream of resolution is unchanged: ITAD `/games/overview/v2`
for prices by `itad_id` (~15 batched calls for the bounded catalog), Epic
free-games merge, dedupe by App ID, device/SoC/performance/emulator/price
filters, sort, paginate. The `getCorrelationMap` structure and its per
device/SoC/region/shop Redis caching are unchanged.

## Data model

`game_titles` keeps its shape and stays keyed on `title_lower` (the EmuReady
title we start each request from — it remains the natural cache lookup key).
One column is added:

```sql
ALTER TABLE game_titles ADD COLUMN resolved_via TEXT;  -- 'steam' | 'title'
```

- `resolved_via = 'steam'` — resolved via `getBestSteamAppId` (exact;
  `steam_app_id` is authoritative).
- `resolved_via = 'title'` — resolved via the ITAD title fallback
  (`steam_app_id` may be null).
- Lets us later retry the `'title'` rows through `getBestSteamAppId` (e.g.
  after an EmuReady catalog update) to upgrade them to exact, without
  re-touching the exact ones.

`steam_app_id` remains the column it is today, but its **meaning changes**
from "derived from ITAD" to "authoritative from EmuReady (or null)."

No other tables change. In particular `itad_id` stays the key for deals,
`wishlist_items`, and `owned_games`, so the three written feature specs'
data models are unaffected.

## Migration / re-warm

Existing `game_titles.steam_app_id` values are ITAD-derived and may be wrong;
`controller_support` and `igdb_mappings` are keyed on `steam_app_id`, so rows
built from a wrong App ID describe the wrong game.

- **One-time re-resolution**: clear `game_titles.steam_app_id` /
  `resolved_via` (or truncate `game_titles`) and let the existing background
  warm (`warmCaches` in `server.js`) repopulate via the new flow. This is the
  same warm path that already exists; it just resolves via `getBestSteamAppId`
  now.
- **Controller/IGDB re-warm**: after re-resolution, corrected `steam_app_id`s
  drive fresh `controller_support` (`warmMissing`) and `igdb_ratings` fetches.
  Rows in those tables keyed on stale App IDs become harmless orphans (never
  looked up again); they can be left in place or cleaned up opportunistically.
- **Warm cost**: `getBestSteamAppId` is one-at-a-time (no batch name→App-ID
  endpoint exists), ~2–3k unique catalog titles at ~120ms ≈ 3–6 min one-time,
  comparable to the existing controller-support warm, then only incremental
  for new titles. Acceptable for a background warm.

## Impact on the three written specs

- **Accounts spec/plan**: unaffected. `store.getDealsForItadIds` /
  `buildItadIdEntry` still key on `itad_id`; they read
  `game_titles.steam_app_id` (now more accurate). No schema or plan change —
  worth a one-line note that `steam_app_id` is now authoritative.
- **Steam-import spec/plan**: gains the reverse **library-compatibility**
  feature via `batchBySteamAppIds` (specced there, not here). The existing
  owned/wishlist deal-tracking import is unaffected.
- **Email-alerts spec/plan**: unaffected.

## Testing

- **`getBestSteamAppId` wrapper** (`services/emuready.js`): the pure
  parse/shape logic (extracting `appId`/`found` from the tRPC envelope) is
  unit-tested against a captured response; the live call is verified manually
  (consistent with the codebase's existing pattern of automated pure-logic +
  manual live-network).
- **Resolution flow** (`services/store.js`): the pure assembly of a
  `game_titles` row from a synthetic `getBestSteamAppId` result + ITAD
  shop-lookup result is unit-testable without live calls (factor the
  row-building into a pure helper, mirroring `buildItadIdEntry` from the
  accounts plan). The fallback branch (App-ID miss → title lookup) is covered
  the same way.
- **End-to-end match quality**: manually verified by running the warm against
  the live catalog and spot-checking that `resolved_via='steam'` covers the
  large majority, and that a few known games map to the correct App ID /
  controller-support entry.
- **Note**: this repo currently has **no** test framework; the accounts plan's
  Task 1 introduces `node:test` + `supertest`. If this correlation rework is
  implemented *before* the accounts plan (it is sequenced first), its plan
  must stand up `node:test` itself (a trimmed version of that Task 1 — no
  `supertest` needed, since there are no HTTP routes here, just service-level
  unit tests).
