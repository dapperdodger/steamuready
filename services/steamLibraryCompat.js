const cache = require('./cache');
const { pool } = require('./db');
const emuready = require('./emuready');

const CACHE_TTL_MS = 5 * 60 * 1000; // matches EmuReady's own ~5 min cache on batchBySteamAppIds

function pickBestListing(listings, preferredDeviceIds = [], preferredSocIds = []) {
  if (!listings || !listings.length) return null;
  const deviceSet = new Set(preferredDeviceIds);
  const socSet = new Set(preferredSocIds);
  const preferred = listings.filter(l => deviceSet.has(l.device?.id) || socSet.has(l.device?.soc?.id));
  const candidates = preferred.length ? preferred : listings;
  return candidates.reduce((best, l) => {
    const rank = l.performance?.rank ?? Infinity;
    const bestRank = best?.performance?.rank ?? Infinity;
    return rank < bestRank ? l : best;
  }, null);
}

// Builds a display entry for a game the user already owns. Unlike the old
// Library Compatibility view's buildCompatEntry, this NEVER returns null —
// "My Games" shows every owned game regardless of whether EmuReady has
// anything on it; compatibility fields are simply left empty when there's
// no (Windows-capable) listing, and buildCompatCard on the frontend already
// renders those as absent rather than placeholder text.
function buildOwnedCompatEntry(itadId, titleRow, batchResult, preferredDeviceIds, preferredSocIds) {
  const listings = (batchResult?.game?.listings ?? []).filter(emuready.isAllowedEmulator);
  const best = pickBestListing(listings, preferredDeviceIds, preferredSocIds);
  const steamAppId = titleRow?.steam_app_id ?? null;

  return {
    itadId,
    gameName: titleRow?.match_title || batchResult?.game?.title || '',
    // Steam's own CDN when we know the Steam App ID (CSP-allowed, matches
    // store.js's buildExactEntry convention); otherwise whatever image_url
    // game_titles already has on file (e.g. resolved via the ITAD title
    // fallback, which has no Steam App ID to build a CDN URL from).
    imageUrl: steamAppId
      ? `https://cdn.akamai.steamstatic.com/steam/apps/${steamAppId}/header.jpg`
      : (titleRow?.image_url || ''),
    listingId: best?.id ?? null,
    compatibility: best ? {
      rank: best.performance?.rank ?? null,
      label: best.performance?.label ?? '',
      deviceName: best.device?.modelName ?? '',
      socName: best.device?.soc?.name ?? '',
      emulatorName: best.emulator?.name ?? '',
    } : null,
  };
}

// Compatibility info for a user's owned games (all sources — manual and
// Steam-imported alike), sourced from this app's own DB rather than a live
// Steam API call (unlike the old Library Compatibility view, which read
// straight from Steam's API). Games with no known Steam App ID (e.g.
// resolved only via the ITAD title-lookup fallback) simply get no
// compatibility data, same as one EmuReady has never heard of.
async function getOwnedGamesCompat(userId, itadIds) {
  if (!itadIds.length) return [];

  const cacheKey = `owned-games-compat:${userId}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const [titleRes, userRes] = await Promise.all([
    pool.query(
      'SELECT itad_id, steam_app_id, match_title, image_url FROM game_titles WHERE itad_id = ANY($1)',
      [itadIds]
    ),
    pool.query('SELECT preferences FROM users WHERE id = $1', [userId]),
  ]);

  const titleByItadId = new Map(titleRes.rows.map(r => [r.itad_id, r]));
  const preferences = userRes.rows[0]?.preferences ?? {};
  const preferredDeviceIds = preferences.deviceIds ?? [];
  const preferredSocIds = preferences.socIds ?? [];

  const steamAppIds = [...new Set(titleRes.rows.map(r => r.steam_app_id).filter(Boolean))];
  const batchResults = steamAppIds.length ? await emuready.batchBySteamAppIds(steamAppIds) : [];
  const resultBySteamAppId = new Map(batchResults.map(r => [r.steamAppId, r]));

  const games = itadIds.map(itadId => {
    const titleRow = titleByItadId.get(itadId) ?? null;
    const batchResult = titleRow?.steam_app_id ? resultBySteamAppId.get(titleRow.steam_app_id) : null;
    return buildOwnedCompatEntry(itadId, titleRow, batchResult, preferredDeviceIds, preferredSocIds);
  });

  await cache.set(cacheKey, games, CACHE_TTL_MS);
  return games;
}

// Non-fatal by design — callers (preference changes, Steam unlink/relink)
// should never let a cache-delete failure block the action that triggered
// it. Centralized here (rather than each caller hardcoding the key) so the
// cache key only lives in one place.
async function clearOwnedGamesCompatCache(userId) {
  try {
    await cache.redis.del(`owned-games-compat:${userId}`);
  } catch (e) {
    console.error('[steamLibraryCompat] failed to clear owned-games-compat cache:', e.message);
  }
}

module.exports = { pickBestListing, buildOwnedCompatEntry, getOwnedGamesCompat, clearOwnedGamesCompatCache };
