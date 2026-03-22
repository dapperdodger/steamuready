const axios = require('axios');
const { redis, delPattern } = require('./cache');

const IGDB_BASE = 'https://api.igdb.com/v4';
const RATING_TTL = 24 * 60 * 60 * 1000; // 24 h

// ── Twitch OAuth2 token (in-memory; tokens last ~60 days) ─────────────────────
let _tokenCache = null; // { token, expiresAt }

async function getAccessToken() {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;

  const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
    params: {
      client_id:     process.env.IGDB_CLIENT_ID,
      client_secret: process.env.IGDB_CLIENT_SECRET,
      grant_type:    'client_credentials',
    },
    timeout: 10000,
  });

  const { access_token, expires_in } = res.data;
  _tokenCache = {
    token:     access_token,
    expiresAt: Date.now() + expires_in * 1000 - 60_000, // refresh 1 min early
  };
  console.log('[IGDB] obtained new access token');
  return access_token;
}

async function igdbPost(endpoint, body) {
  const token = await getAccessToken();
  const res = await axios.post(`${IGDB_BASE}${endpoint}`, body, {
    headers: {
      'Client-ID':     process.env.IGDB_CLIENT_ID,
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/json',
    },
    timeout: 15000,
  });
  return res.data;
}

// ── Core fetch: { steamAppId → igdbRating } ───────────────────────────────────
// steamAppIds: string[] of Steam app IDs (e.g. "123456")
async function fetchRatingsForSteamApps(steamAppIds) {
  const ratings = new Map(); // steamAppId → rating object

  if (!steamAppIds.length) return ratings;

  // Step 1: Steam AppIDs → IGDB game IDs via /external_games
  // external_game_source = 1 is Steam (confirmed via /external_game_sources).
  // The old `category` field was also 1 for Steam but is now deprecated.
  const igdbIdBySteam = new Map(); // steamAppId → igdbGameId

  for (let i = 0; i < steamAppIds.length; i += 500) {
    const batch = steamAppIds.slice(i, i + 500);
    const uidList = batch.map(id => `"${id}"`).join(',');
    try {
      const data = await igdbPost(
        '/external_games',
        `fields game,uid; where external_game_source = 1 & uid = (${uidList}); limit 500;`
      );
      for (const item of data ?? []) {
        if (item.game && item.uid) igdbIdBySteam.set(item.uid, item.game);
      }
    } catch (e) {
      console.warn(`[IGDB] external_games lookup failed (offset ${i}):`, e.message);
    }
  }

  if (!igdbIdBySteam.size) return ratings;

  // Step 2: IGDB game IDs → ratings via /games
  const igdbIds = [...new Set(igdbIdBySteam.values())];
  const ratingsByIgdbId = new Map(); // igdbGameId → rating object

  for (let i = 0; i < igdbIds.length; i += 500) {
    const batch = igdbIds.slice(i, i + 500);
    try {
      const data = await igdbPost(
        '/games',
        `fields total_rating,total_rating_count,rating,aggregated_rating; where id = (${batch.join(',')}); limit 500;`
      );
      for (const game of data ?? []) {
        ratingsByIgdbId.set(game.id, {
          igdbRating:      game.total_rating      ?? null,
          igdbRatingCount: game.total_rating_count ?? 0,
          userRating:      game.rating             ?? null,
          criticRating:    game.aggregated_rating  ?? null,
        });
      }
    } catch (e) {
      console.warn(`[IGDB] games ratings lookup failed (offset ${i}):`, e.message);
    }
  }

  // Step 3: map back to steamAppId
  for (const [steamAppId, igdbGameId] of igdbIdBySteam) {
    const r = ratingsByIgdbId.get(igdbGameId);
    if (r) ratings.set(steamAppId, r);
  }

  return ratings;
}

// ── Main export ───────────────────────────────────────────────────────────────
// itadSteamPairs: Array<{ itadId: string, steamAppId: string|null }>
// Returns Map(itadId → { igdbRating, igdbRatingCount, userRating, criticRating })
async function getRatings(itadSteamPairs) {
  if (!process.env.IGDB_CLIENT_ID || !process.env.IGDB_CLIENT_SECRET) return new Map();
  if (!itadSteamPairs.length) return new Map();

  // ── Cache read ─────────────────────────────────────────────────────────────
  const pipeline = redis.pipeline();
  for (const { itadId } of itadSteamPairs) {
    pipeline.get(`igdb:rating:${itadId}`);
  }
  const pipeResults = await pipeline.exec();

  const result = new Map();
  const needsFetch = []; // { itadId, steamAppId }

  for (let i = 0; i < itadSteamPairs.length; i++) {
    const raw = pipeResults[i][1];
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (parsed) result.set(itadSteamPairs[i].itadId, parsed);
    } else {
      needsFetch.push(itadSteamPairs[i]);
    }
  }

  if (!needsFetch.length) return result;

  // ── Fetch uncached ─────────────────────────────────────────────────────────
  console.log(`[IGDB] fetching ratings for ${needsFetch.length} uncached games…`);

  // Group by steamAppId (some may be null / missing)
  const steamToItadIds = new Map(); // steamAppId → itadId[]
  const noSteam = [];
  for (const { itadId, steamAppId } of needsFetch) {
    if (!steamAppId) { noSteam.push(itadId); continue; }
    if (!steamToItadIds.has(steamAppId)) steamToItadIds.set(steamAppId, []);
    steamToItadIds.get(steamAppId).push(itadId);
  }

  const steamAppIds = [...steamToItadIds.keys()];
  const fetched = await fetchRatingsForSteamApps(steamAppIds); // steamAppId → ratings

  // ── Cache write ────────────────────────────────────────────────────────────
  const writePipeline = redis.pipeline();

  for (const { itadId, steamAppId } of needsFetch) {
    const rating = steamAppId ? (fetched.get(steamAppId) ?? null) : null;
    writePipeline.set(`igdb:rating:${itadId}`, JSON.stringify(rating), 'PX', RATING_TTL);
    if (rating) result.set(itadId, rating);
  }

  await writePipeline.exec();
  console.log(`[IGDB] cached ratings for ${needsFetch.length} games (${fetched.size} matched)`);

  return result;
}

async function clearCache() {
  _tokenCache = null;
  await delPattern('igdb:*');
}

module.exports = { getRatings, clearCache };
