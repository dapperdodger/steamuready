const { pool } = require('./db');
const steamApi = require('./steamApi');
const store = require('./store');
const emuready = require('./emuready');
const { addOwned, listOwnedItadIds } = require('./wishlist');

// The exact-correlation plan already implements and manually-verifies this
// exact ITAD /lookup/id/shop/61/v1 call in services/store.js — reused here
// under the name this file's callers expect, rather than duplicated. Uses
// the strict variant: an incomplete ITAD response must abort the import
// rather than being treated as "these Steam App IDs don't exist," which
// would wipe previously-imported rows on the next resync (same reasoning
// as batchBySteamAppIdsStrict below).
const resolveAppIdsToItadIds = store.resolveSteamAppIdsToItadIdsStrict;

// Pure: keep only EmuReady batch results that have at least one
// Windows-capable-emulator listing (games with no listing anywhere this
// app can show aren't worth wishlisting/marking owned).
function filterImportableResults(batchResults, isAllowedEmulatorFn) {
  return batchResults.filter(r => r.game && r.game.listings?.some(isAllowedEmulatorFn));
}

async function resyncOwnedFromSteam(userId, itadIds) {
  const idSet = new Set(itadIds);
  const { rows } = await pool.query(
    "SELECT itad_id FROM owned_games WHERE user_id = $1 AND source = 'steam'",
    [userId]
  );
  const stale = rows.map(r => r.itad_id).filter(id => !idSet.has(id));
  if (stale.length) {
    await pool.query(
      "DELETE FROM owned_games WHERE user_id = $1 AND source = 'steam' AND itad_id = ANY($2)",
      [userId, stale]
    );
  }
  for (const itadId of itadIds) {
    // addOwned handles insert (ON CONFLICT DO NOTHING) and clears both the
    // wishlist and hidden_games entries for this game (accounts plan's rule).
    await addOwned(userId, itadId, 'steam');
  }
}

async function resyncWishlistFromSteam(userId, itadIds, ownedItadIds) {
  const ownedSet = new Set(ownedItadIds);
  const idSet = new Set(itadIds.filter(id => !ownedSet.has(id)));
  const { rows } = await pool.query(
    "SELECT itad_id FROM wishlist_items WHERE user_id = $1 AND source = 'steam'",
    [userId]
  );
  const stale = rows.map(r => r.itad_id).filter(id => !idSet.has(id));
  if (stale.length) {
    await pool.query(
      "DELETE FROM wishlist_items WHERE user_id = $1 AND source = 'steam' AND itad_id = ANY($2)",
      [userId, stale]
    );
  }
  for (const itadId of idSet) {
    await pool.query(
      `INSERT INTO wishlist_items (user_id, itad_id, source) VALUES ($1, $2, 'steam')
       ON CONFLICT (user_id, itad_id) DO NOTHING`,
      [userId, itadId]
    );
  }
}

// A Steam profile can go from "public and imported" to "empty response" for
// reasons that have nothing to do with actually owning/wishlisting nothing
// (game-details or wishlist privacy flipped to non-Public, an account
// issue, etc.) — Steam's API returns HTTP 200 with an empty body in that
// case, indistinguishable from a genuinely empty library. Treating that as
// "resync to empty" would silently delete previously-imported data. Refuse
// to proceed if Steam reports nothing AND we already have steam-sourced
// rows on file — but a genuinely first-time empty import (no existing rows)
// is unremarkable and must still be allowed to succeed. Checked
// independently per table since game-details and wishlist privacy are
// separate Steam settings.
async function assertSafeToResync(userId, ownedAppIds, wishlistAppIds) {
  if (ownedAppIds.length === 0) {
    const { rows } = await pool.query(
      "SELECT 1 FROM owned_games WHERE user_id = $1 AND source = 'steam' LIMIT 1",
      [userId]
    );
    if (rows.length) {
      const err = new Error("Steam reported no owned games, which would delete your previously-imported library — check that your Steam profile's game-details privacy is still set to Public, then try again.");
      err.steamPrivacyGuard = true; // known, actionable condition — routes/steam.js surfaces this message directly instead of the generic 500
      throw err;
    }
  }
  if (wishlistAppIds.length === 0) {
    const { rows } = await pool.query(
      "SELECT 1 FROM wishlist_items WHERE user_id = $1 AND source = 'steam' LIMIT 1",
      [userId]
    );
    if (rows.length) {
      const err = new Error("Steam reported an empty wishlist, which would delete your previously-imported wishlist — check that your Steam profile's wishlist privacy is still set to Public, then try again.");
      err.steamPrivacyGuard = true;
      throw err;
    }
  }
}

// The resyncs are actually driven by ownedItadIds/wishlistItadIds, not the
// raw Steam App IDs directly — those are derived via two more network hops
// (EmuReady's batchBySteamAppIdsStrict, then ITAD's
// resolveSteamAppIdsToItadIdsStrict). Both can return a successful-looking
// HTTP 200 (a tRPC error envelope at 200, an unexpected response shape, a
// WAF/interstitial page, etc.) that the existing parse functions silently
// coerce to []/an empty Map — collapsing a full, non-empty set of Steam App
// IDs down to an empty derived set without ever throwing, so the *Strict
// variants never get a chance to fire. assertSafeToResync (above) only
// checks the raw Steam-layer inputs and can't see this. Same reasoning,
// checked independently per collection at the derived layer instead: refuse
// to resync-to-empty if we already have steam-sourced rows on file. Unlike
// assertSafeToResync, this is an EmuReady/ITAD data-quality problem, not a
// Steam privacy setting — there's nothing the user can fix on their end, so
// this deliberately does NOT set steamPrivacyGuard and falls through to the
// generic 500 in routes/steam.js instead of surfacing a privacy-specific
// message.
async function assertResyncSetsNotSuspiciouslyEmpty(userId, ownedItadIds, wishlistItadIds) {
  if (ownedItadIds.length === 0) {
    const { rows } = await pool.query(
      "SELECT 1 FROM owned_games WHERE user_id = $1 AND source = 'steam' LIMIT 1",
      [userId]
    );
    if (rows.length) {
      throw new Error("The game-compatibility service returned incomplete data for this import, which would have deleted your previously-imported library — please try again later.");
    }
  }
  if (wishlistItadIds.length === 0) {
    const { rows } = await pool.query(
      "SELECT 1 FROM wishlist_items WHERE user_id = $1 AND source = 'steam' LIMIT 1",
      [userId]
    );
    if (rows.length) {
      throw new Error("The game-compatibility service returned incomplete data for this import, which would have deleted your previously-imported wishlist — please try again later.");
    }
  }
}

async function runImport(userId, steamId) {
  const [ownedAppIds, wishlistAppIds] = await Promise.all([
    steamApi.getOwnedGameAppIds(steamId),
    steamApi.getWishlistAppIds(steamId),
  ]);
  await assertSafeToResync(userId, ownedAppIds, wishlistAppIds);
  const allAppIds = [...new Set([...ownedAppIds, ...wishlistAppIds])];
  const batchResults = allAppIds.length ? await emuready.batchBySteamAppIdsStrict(allAppIds) : [];
  const importable = filterImportableResults(batchResults, emuready.isAllowedEmulator);
  const importableAppIds = importable.map(r => r.steamAppId);

  const itadMap = await resolveAppIdsToItadIds(importableAppIds);

  // Persist game_titles for every game we're about to import — same shape
  // and image-URL convention buildExactEntry already uses for the deals
  // path, so imported games render with real names/images (no separate
  // backfill job needed; see Fix C in the final-review batch).
  const titleEntries = {};
  for (const r of importable) {
    const itadId = itadMap.get(r.steamAppId);
    if (!itadId) continue; // ITAD didn't recognize this Steam App ID either
    if (!r.game.title) continue; // Defensive: EmuReady result with a game but no title
    const entry = store.buildExactEntry(r.game.title, r.steamAppId, itadId);
    if (entry) titleEntries[r.game.title.toLowerCase()] = entry;
  }
  if (Object.keys(titleEntries).length) await store.persistGameTitles(titleEntries);

  const ownedItadIds = [...new Set(ownedAppIds.map(id => itadMap.get(id)).filter(Boolean))];
  const wishlistItadIds = [...new Set(wishlistAppIds.map(id => itadMap.get(id)).filter(Boolean))];

  await assertResyncSetsNotSuspiciouslyEmpty(userId, ownedItadIds, wishlistItadIds);

  await resyncOwnedFromSteam(userId, ownedItadIds);
  // Use the full owned set (all sources), not just Steam's, so a game owned
  // via another source never gets re-added to the wishlist by this resync.
  const allOwnedItadIds = await listOwnedItadIds(userId);
  await resyncWishlistFromSteam(userId, wishlistItadIds, allOwnedItadIds);

  const { rows: ownedRows } = await pool.query('SELECT COUNT(*) FROM owned_games WHERE user_id = $1', [userId]);
  const { rows: wishlistRows } = await pool.query('SELECT COUNT(*) FROM wishlist_items WHERE user_id = $1', [userId]);
  return { ownedCount: Number(ownedRows[0].count), wishlistCount: Number(wishlistRows[0].count) };
}

module.exports = { resolveAppIdsToItadIds, resyncOwnedFromSteam, resyncWishlistFromSteam, assertSafeToResync, assertResyncSetsNotSuspiciouslyEmpty, runImport, filterImportableResults };
