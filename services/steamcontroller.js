const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const SEED_FILE = path.join(__dirname, '..', 'seeds', 'controller_support.json');

async function importSeedIfPresent() {
  if (!fs.existsSync(SEED_FILE)) return 0;
  const records = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  if (!records.length) return 0;

  const BATCH_SIZE = 500;
  let inserted = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(', ');
    const params = batch.flatMap(r => [r.steam_app_id, r.support]);
    const res = await pool.query(
      `INSERT INTO controller_support (steam_app_id, support) VALUES ${placeholders} ON CONFLICT (steam_app_id) DO NOTHING`,
      params
    );
    inserted += res.rowCount;
  }
  return inserted;
}

const REQUEST_DELAY = 1500; // ms between requests — ~40/min, within Steam's undocumented limit
const RETRY_DELAY   = 10000;
const CAT_FULL      = 28;
const CAT_PARTIAL   = 18;

// In-flight guard: prevents duplicate background fetches for the same steamAppId
const _inFlight = new Set();

async function fetchOne(steamAppId) {
  const res = await axios.get('https://store.steampowered.com/api/appdetails', {
    params: { appids: steamAppId, filters: 'categories' },
    timeout: 8000,
  });
  const entry = res.data?.[steamAppId];
  if (!entry?.success || !entry.data) return 'none';
  const cats = (entry.data.categories ?? []).map(c => c.id);
  if (cats.includes(CAT_FULL))    return 'full';
  if (cats.includes(CAT_PARTIAL)) return 'partial';
  return 'none';
}

async function fetchAndStore(steamAppIds) {
  const toFetch = steamAppIds.filter(id => !_inFlight.has(id));
  if (!toFetch.length) return;
  for (const id of toFetch) _inFlight.add(id);

  try {
    for (let i = 0; i < toFetch.length; i++) {
      const steamAppId = toFetch[i];
      let support = null;
      try {
        support = await fetchOne(steamAppId);
      } catch (e) {
        if (e.response?.status === 429) {
          console.warn(`[SteamCtrl] rate limited — waiting ${RETRY_DELAY}ms before retrying ${steamAppId}`);
          await new Promise(r => setTimeout(r, RETRY_DELAY));
          try { support = await fetchOne(steamAppId); } catch { /* skip */ }
        } else if (e.response?.status !== 403) {
          // 403 = age-gated/region-locked, treat as null (no data)
          console.warn(`[SteamCtrl] fetch failed for ${steamAppId}:`, e.message);
        }
      }

      await pool.query(
        `INSERT INTO controller_support (steam_app_id, support)
         VALUES ($1, $2)
         ON CONFLICT (steam_app_id) DO NOTHING`,
        [steamAppId, support]
      );

      if (i < toFetch.length - 1) await new Promise(r => setTimeout(r, REQUEST_DELAY));
    }
    console.log(`[SteamCtrl] fetched ${toFetch.length} games`);
  } finally {
    for (const id of toFetch) _inFlight.delete(id);
  }
}

// itadSteamPairs: Array<{ itadId: string, steamAppId: string|null }>
// Returns Map(itadId → 'full'|'partial'|'none') from DB only.
// Fires a background fetch for any steamAppIds not yet in DB.
async function getControllerSupport(itadSteamPairs) {
  if (!itadSteamPairs.length) return new Map();

  const steamToItad = new Map();
  for (const { itadId, steamAppId } of itadSteamPairs) {
    if (!steamAppId) continue;
    if (!steamToItad.has(steamAppId)) steamToItad.set(steamAppId, []);
    steamToItad.get(steamAppId).push(itadId);
  }

  const steamAppIds = [...steamToItad.keys()];
  if (!steamAppIds.length) return new Map();

  const { rows } = await pool.query(
    'SELECT steam_app_id, support FROM controller_support WHERE steam_app_id = ANY($1)',
    [steamAppIds]
  );

  const result = new Map();
  const inDb = new Set();

  for (const row of rows) {
    inDb.add(row.steam_app_id);
    if (row.support) {
      for (const itadId of (steamToItad.get(row.steam_app_id) ?? [])) {
        result.set(itadId, row.support);
      }
    }
  }

  const missing = steamAppIds.filter(id => !inDb.has(id));
  if (missing.length) {
    fetchAndStore(missing).catch(e => console.warn('[SteamCtrl] background fetch error:', e.message));
  }

  return result;
}

// Called from warmCaches on startup — imports seed file if present, then fetches any
// remaining gaps from Steam. Awaited so ctrlCacheReady is set only once this finishes.
async function warmMissing() {
  const seeded = await importSeedIfPresent();
  if (seeded > 0) console.log(`[SteamCtrl] imported ${seeded} entries from seed file`);

  const { rows } = await pool.query(`
    SELECT DISTINCT gt.steam_app_id
    FROM   game_titles gt
    LEFT   JOIN controller_support cs ON cs.steam_app_id = gt.steam_app_id
    WHERE  gt.steam_app_id IS NOT NULL
      AND  cs.steam_app_id IS NULL
  `);

  if (!rows.length) {
    console.log('[SteamCtrl] controller support fully populated');
    return;
  }

  const missing = rows.map(r => r.steam_app_id);
  console.log(`[SteamCtrl] warming ${missing.length} missing entries…`);
  await fetchAndStore(missing);
}

module.exports = { getControllerSupport, warmMissing };
