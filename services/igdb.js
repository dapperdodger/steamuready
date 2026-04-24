const axios = require('axios');
const { pool } = require('./db');

const IGDB_BASE          = 'https://api.igdb.com/v4';
const RATING_MAX_AGE_DAYS = 7;

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
    expiresAt: Date.now() + expires_in * 1000 - 60_000,
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

// ── Fetch steamAppId → igdbGameId mappings not yet in DB ─────────────────────
async function fetchMappings(steamAppIds) {
  const newMappings = new Map(); // steamAppId → igdbGameId|null

  for (let i = 0; i < steamAppIds.length; i += 500) {
    const batch = steamAppIds.slice(i, i + 500).map(id => String(id).replace(/\D/g, '')).filter(Boolean);
    const uidList = batch.map(id => `"${id}"`).join(',');
    try {
      const data = await igdbPost(
        '/external_games',
        `fields game,uid; where external_game_source = 1 & uid = (${uidList}); limit 500;`
      );
      for (const item of data ?? []) {
        if (item.game && item.uid) newMappings.set(item.uid, item.game);
      }
    } catch (e) {
      console.warn(`[IGDB] external_games lookup failed (offset ${i}):`, e.message);
    }
    // Mark steamAppIds with no IGDB match as null so we don't re-fetch them
    for (const id of batch) {
      if (!newMappings.has(id)) newMappings.set(id, null);
    }
  }

  // Bulk upsert into igdb_mappings
  if (newMappings.size) {
    const vals = [...newMappings.entries()];
    const placeholders = vals.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
    const params = vals.flatMap(([steam, igdb]) => [steam, igdb]);
    await pool.query(
      `INSERT INTO igdb_mappings (steam_app_id, igdb_game_id)
       VALUES ${placeholders}
       ON CONFLICT (steam_app_id) DO NOTHING`,
      params
    );
  }

  return newMappings;
}

// ── Fetch ratings for a list of IGDB game IDs ────────────────────────────────
async function fetchRatingsForIgdbIds(igdbIds) {
  const ratings = new Map(); // igdbGameId → rating object

  for (let i = 0; i < igdbIds.length; i += 500) {
    const batch = igdbIds.slice(i, i + 500);
    try {
      const data = await igdbPost(
        '/games',
        `fields total_rating,total_rating_count,rating,aggregated_rating; where id = (${batch.join(',')}); limit 500;`
      );
      for (const game of data ?? []) {
        ratings.set(game.id, {
          igdbRating:      game.total_rating       ?? null,
          igdbRatingCount: game.total_rating_count ?? 0,
          userRating:      game.rating             ?? null,
          criticRating:    game.aggregated_rating  ?? null,
        });
      }
    } catch (e) {
      console.warn(`[IGDB] games ratings lookup failed (offset ${i}):`, e.message);
    }
  }

  return ratings;
}

// ── Main export ───────────────────────────────────────────────────────────────
// itadSteamPairs: Array<{ itadId: string, steamAppId: string|null }>
// Returns Map(itadId → { igdbRating, igdbRatingCount, userRating, criticRating })
async function getRatings(itadSteamPairs) {
  if (!process.env.IGDB_CLIENT_ID || !process.env.IGDB_CLIENT_SECRET) return new Map();
  if (!itadSteamPairs.length) return new Map();

  // ── 1. Read fresh ratings from DB ─────────────────────────────────────────
  const itadIds = itadSteamPairs.map(p => p.itadId);
  const { rows: ratingRows } = await pool.query(
    `SELECT itad_id, igdb_rating, igdb_rating_count, user_rating, critic_rating
     FROM   igdb_ratings
     WHERE  itad_id = ANY($1)
       AND  updated_at > NOW() - INTERVAL '${RATING_MAX_AGE_DAYS} days'`,
    [itadIds]
  );

  const result = new Map();
  const cachedIds = new Set();

  for (const row of ratingRows) {
    cachedIds.add(row.itad_id);
    if (row.igdb_rating !== null) {
      result.set(row.itad_id, {
        igdbRating:      row.igdb_rating,
        igdbRatingCount: row.igdb_rating_count,
        userRating:      row.user_rating,
        criticRating:    row.critic_rating,
      });
    }
  }

  const needsFetch = itadSteamPairs.filter(p => !cachedIds.has(p.itadId));
  if (!needsFetch.length) return result;

  console.log(`[IGDB] fetching ratings for ${needsFetch.length} uncached games…`);

  // ── 2. Resolve steamAppId → igdbGameId via DB (fetch missing from IGDB API) ─
  const steamAppIds = [...new Set(needsFetch.map(p => p.steamAppId).filter(Boolean))];

  let igdbIdBySteam = new Map(); // steamAppId → igdbGameId

  if (steamAppIds.length) {
    const { rows: mappingRows } = await pool.query(
      'SELECT steam_app_id, igdb_game_id FROM igdb_mappings WHERE steam_app_id = ANY($1)',
      [steamAppIds]
    );
    for (const row of mappingRows) igdbIdBySteam.set(row.steam_app_id, row.igdb_game_id);

    const unmapped = steamAppIds.filter(id => !igdbIdBySteam.has(id));
    if (unmapped.length) {
      const fetched = await fetchMappings(unmapped);
      for (const [k, v] of fetched) igdbIdBySteam.set(k, v);
    }
  }

  // ── 3. Fetch ratings from IGDB for resolved game IDs ─────────────────────
  const igdbGameIds = [...new Set([...igdbIdBySteam.values()].filter(Boolean))];
  const ratingsByIgdbId = igdbGameIds.length ? await fetchRatingsForIgdbIds(igdbGameIds) : new Map();

  // ── 4. Write results to DB + build return map ─────────────────────────────
  for (const { itadId, steamAppId } of needsFetch) {
    const igdbGameId = steamAppId ? (igdbIdBySteam.get(steamAppId) ?? null) : null;
    const rating     = igdbGameId ? (ratingsByIgdbId.get(igdbGameId) ?? null) : null;

    await pool.query(
      `INSERT INTO igdb_ratings (itad_id, igdb_rating, igdb_rating_count, user_rating, critic_rating)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (itad_id) DO UPDATE SET
         igdb_rating       = EXCLUDED.igdb_rating,
         igdb_rating_count = EXCLUDED.igdb_rating_count,
         user_rating       = EXCLUDED.user_rating,
         critic_rating     = EXCLUDED.critic_rating,
         updated_at        = NOW()`,
      [itadId, rating?.igdbRating ?? null, rating?.igdbRatingCount ?? null,
       rating?.userRating ?? null, rating?.criticRating ?? null]
    );

    if (rating) result.set(itadId, rating);
  }

  console.log(`[IGDB] cached ratings for ${needsFetch.length} games (${result.size} matched)`);
  return result;
}

async function clearCache() {
  _tokenCache = null;
  // Ratings refresh naturally via updated_at; call this only to force a full re-fetch
  await pool.query(`DELETE FROM igdb_ratings`);
}

module.exports = { getRatings, clearCache };
