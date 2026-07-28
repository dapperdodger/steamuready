const cache = require('./cache');
const { pool } = require('./db');
const steamApi = require('./steamApi');
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

// EmuReady has no listing for a not-found game, or (defensively) an
// EmuReady game entry with zero listings — both mean nothing to show.
function buildCompatEntry(result, ownedSet, wishlistSet, preferredDeviceIds, preferredSocIds) {
  if (!result.game || !result.game.listings?.length) return null;

  const best = pickBestListing(result.game.listings, preferredDeviceIds, preferredSocIds);
  if (!best) return null;

  return {
    steamAppId: result.steamAppId,
    gameName: result.game.title,
    imageUrl: result.game.boxartUrl || result.game.imageUrl || '',
    owned: ownedSet.has(result.steamAppId),
    wishlisted: wishlistSet.has(result.steamAppId),
    compatibility: {
      rank: best.performance?.rank ?? null,
      label: best.performance?.label ?? '',
      deviceName: best.device?.modelName ?? '',
      socName: best.device?.soc?.name ?? '',
      emulatorName: best.emulator?.name ?? '',
    },
  };
}

async function getLibraryCompat(userId, steamId) {
  const cacheKey = `steam-library-compat:${userId}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const [ownedAppIds, wishlistAppIds, userRow] = await Promise.all([
    steamApi.getOwnedGameAppIds(steamId),
    steamApi.getWishlistAppIds(steamId),
    pool.query('SELECT preferences FROM users WHERE id = $1', [userId]),
  ]);

  const ownedSet = new Set(ownedAppIds);
  const wishlistSet = new Set(wishlistAppIds);
  const allAppIds = [...new Set([...ownedAppIds, ...wishlistAppIds])];

  const preferences = userRow.rows[0]?.preferences ?? {};
  const preferredDeviceIds = preferences.deviceIds ?? [];
  const preferredSocIds = preferences.socIds ?? [];

  const results = allAppIds.length ? await emuready.batchBySteamAppIds(allAppIds) : [];
  const games = results
    .map(r => buildCompatEntry(r, ownedSet, wishlistSet, preferredDeviceIds, preferredSocIds))
    .filter(Boolean);

  await cache.set(cacheKey, games, CACHE_TTL_MS);
  return games;
}

module.exports = { pickBestListing, buildCompatEntry, getLibraryCompat };
