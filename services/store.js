const axios = require('axios');
const { redis, delPattern } = require('./cache');
const { pool } = require('./db');
const igdb = require('./igdb');
const steamcontroller = require('./steamcontroller');

const ITAD_BASE = 'https://api.isthereanydeal.com';
const STEAM_SHOP_ID = 61;

const REGIONS = {
  us: { label: '🇺🇸 USD',  sym: '$'   },
  fr: { label: '🇫🇷 EUR',  sym: '€'   },
  gb: { label: '🇬🇧 GBP',  sym: '£'   },
  de: { label: '🇩🇪 EUR',  sym: '€'   },
  ca: { label: '🇨🇦 CAD',  sym: 'CA$' },
  au: { label: '🇦🇺 AUD',  sym: 'AU$' },
  br: { label: '🇧🇷 BRL',  sym: 'R$'  },
  tr: { label: '🇹🇷 TRY',  sym: '₺'   },
  ar: { label: '🇦🇷 ARS',  sym: '$'   },
  pl: { label: '🇵🇱 PLN',  sym: 'zł'  },
};

const OVERVIEW_TTL = 60 * 60 * 1000; // 1 h

// ── Phase 1: Batch title → ITAD ID resolution + Steam appId lookup ────────────
// Returns { [titleLower]: cacheEntry } for all resolved titles.
async function resolveTitlesBatch(titles) {
  const BATCH_SIZE = 200;
  const resolved = {};

  for (let i = 0; i < titles.length; i += BATCH_SIZE) {
    const batch = titles.slice(i, i + BATCH_SIZE);

    // 1a. Titles → ITAD UUIDs
    let lookupResult = {};
    try {
      const res = await axios.post(
        `${ITAD_BASE}/lookup/id/title/v1`,
        batch,
        { params: { key: process.env.ITAD_API_KEY }, timeout: 15000 }
      );
      lookupResult = res.data ?? {};
    } catch (e) {
      console.warn(`[Store] batch title lookup failed (offset ${i}):`, e.message);
    }

    // Build initial entries (imageUrl filled in next step for matched titles)
    const entries = {};
    for (const [title, id] of Object.entries(lookupResult)) {
      entries[title.toLowerCase()] = id
        ? { id, matchTitle: title, imageUrl: '', steamAppId: null }
        : { id: null };
    }

    // 1b. ITAD UUIDs → Steam appIds (batch, one call per 200)
    const matchedIds = Object.values(lookupResult).filter(Boolean);
    if (matchedIds.length) {
      try {
        const res = await axios.post(
          `${ITAD_BASE}/lookup/shop/${STEAM_SHOP_ID}/id/v1`,
          matchedIds,
          { params: { key: process.env.ITAD_API_KEY }, timeout: 15000 }
        );
        const steamMap = res.data ?? {}; // { itadUuid: ["app/123456", ...] }

        for (const [title, id] of Object.entries(lookupResult)) {
          if (!id) continue;
          const shopIds = steamMap[id];
          const appEntry = shopIds?.find(s => s.startsWith('app/'));
          if (appEntry) {
            const steamAppId = appEntry.replace('app/', '');
            const key = title.toLowerCase();
            if (entries[key]) {
              entries[key].steamAppId = steamAppId;
              entries[key].imageUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${steamAppId}/header.jpg`;
            }
          }
        }
      } catch (e) {
        console.warn(`[Store] Steam appId lookup failed (offset ${i}):`, e.message);
      }
    }

    // Bulk upsert into game_titles
    const vals = Object.entries(entries);
    if (vals.length) {
      const placeholders = vals.map((_, j) => `($${j*5+1}, $${j*5+2}, $${j*5+3}, $${j*5+4}, $${j*5+5})`).join(', ');
      const params = vals.flatMap(([key, e]) => [key, e.id ?? null, e.matchTitle ?? null, e.steamAppId ?? null, e.imageUrl ?? null]);
      await pool.query(
        `INSERT INTO game_titles (title_lower, itad_id, match_title, steam_app_id, image_url)
         VALUES ${placeholders}
         ON CONFLICT (title_lower) DO UPDATE SET
           itad_id      = EXCLUDED.itad_id,
           match_title  = EXCLUDED.match_title,
           steam_app_id = EXCLUDED.steam_app_id,
           image_url    = EXCLUDED.image_url,
           updated_at   = NOW()`,
        params
      );
    }

    Object.assign(resolved, entries);
  }

  return resolved;
}

// ── Phase 2: Fetch overview for a batch of ITAD IDs ───────────────────────────
async function fetchOverviewAPI(itadIds, cc, shops) {
  const country = cc.toUpperCase();
  const shopsParam = shops.length ? shops.join(',') : undefined;
  const pairs = [];

  for (let i = 0; i < itadIds.length; i += 200) {
    const batch = itadIds.slice(i, i + 200);
    try {
      const res = await axios.post(
        `${ITAD_BASE}/games/overview/v2`,
        batch,
        { params: { key: process.env.ITAD_API_KEY, country, shops: shopsParam }, timeout: 15000 }
      );
      for (const item of res.data?.prices ?? []) {
        if (!item.current) continue;
        pairs.push([item.id, item]);
      }
    } catch (e) {
      console.warn(`[Store] overview batch failed (offset ${i}):`, e.message);
    }
  }
  return pairs;
}

function toNum(v) {
  return parseFloat(v) || 0;
}

// ── Main export ───────────────────────────────────────────────────────────────
async function getDealsForTitles(titles, cc = 'us', shops = []) {
  const shopsKey = shops.length ? shops.slice().sort().join(',') : 'all';
  const t0 = Date.now();

  // ── Phase 1: read title cache from DB ─────────────────────────────────────
  const titleLowers = titles.map(t => t.toLowerCase());
  const { rows: dbRows } = await pool.query(
    'SELECT title_lower, itad_id, match_title, steam_app_id, image_url FROM game_titles WHERE title_lower = ANY($1)',
    [titleLowers]
  );

  const titleCache = {};
  for (const row of dbRows) {
    titleCache[row.title_lower] = row.itad_id
      ? { id: row.itad_id, matchTitle: row.match_title, imageUrl: row.image_url ?? '', steamAppId: row.steam_app_id ?? null }
      : { id: null };
  }

  const needsLookup = titles.filter(t => !titleCache[t.toLowerCase()]);

  // ── Phase 2: batch-resolve uncached titles ─────────────────────────────────
  if (needsLookup.length) {
    console.log(`[Store] batch-resolving ${needsLookup.length} titles…`);
    const newEntries = await resolveTitlesBatch(needsLookup);
    Object.assign(titleCache, newEntries);
    console.log(`[Store] title resolution done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  // ── Phase 3: collect matched ITAD IDs ─────────────────────────────────────
  const itadIds = [];
  for (const title of titles) {
    const e = titleCache[title.toLowerCase()];
    if (e?.id) itadIds.push(e.id);
  }

  if (!itadIds.length) {
    console.log(`[Store] no ITAD matches for ${titles.length} titles`);
    return new Map();
  }

  // ── Phase 4: fetch overview — current price + historical low ──────────────
  // Overview is stored as a JSON array of [id, item] pairs (Map serialization)
  const overviewKey = `store:overview:${cc}:${shopsKey}`;
  let overviewRaw = await redis.get(overviewKey);
  let overviewMap;

  if (overviewRaw) {
    overviewMap = new Map(JSON.parse(overviewRaw));
    const missing = itadIds.filter(id => !overviewMap.has(id));
    if (missing.length) {
      console.log(`[Store/${cc}/${shopsKey}] fetching ${missing.length} new entries (incremental)…`);
      const pairs = await fetchOverviewAPI(missing, cc, shops);
      pairs.forEach(([id, item]) => overviewMap.set(id, item));
      await redis.set(overviewKey, JSON.stringify([...overviewMap.entries()]), 'PX', OVERVIEW_TTL);
    } else {
      console.log(`[Store/${cc}/${shopsKey}] overview cache hit (${overviewMap.size} entries)`);
    }
  } else {
    console.log(`[Store/${cc}/${shopsKey}] overview cache miss — fetching ${itadIds.length} games…`);
    const pairs = await fetchOverviewAPI(itadIds, cc, shops);
    overviewMap = new Map(pairs);
    await redis.set(overviewKey, JSON.stringify([...overviewMap.entries()]), 'PX', OVERVIEW_TTL);
    console.log(`[Store/${cc}/${shopsKey}] overview cache built: ${overviewMap.size} entries`);
  }

  // ── Phase 5: assemble result Map(titleLower → deal object) ────────────────
  const sym = REGIONS[cc]?.sym ?? '$';
  const result = new Map();

  for (const title of titles) {
    const titleEntry = titleCache[title.toLowerCase()];
    if (!titleEntry?.id) continue;

    const item = overviewMap.get(titleEntry.id);
    if (!item?.current) continue;

    const current = item.current;
    const lowest  = item.lowest ?? null;

    const price         = toNum(current.price?.amount);
    const originalPrice = toNum(current.regular?.amount ?? current.price?.amount);

    result.set(title.toLowerCase(), {
      appId:                  titleEntry.id,
      name:                   titleEntry.matchTitle,
      steamAppId:             titleEntry.steamAppId ?? null,
      storeName:              current.shop?.name ?? 'Store',
      imageUrl:               titleEntry.imageUrl ?? '',
      storeUrl:               current.url,
      discountPercent:        current.cut ?? 0,
      price,
      originalPrice,
      priceFormatted:         price === 0 ? 'Free' : `${sym}${price.toFixed(2)}`,
      originalPriceFormatted: (current.cut ?? 0) > 0 ? `${sym}${originalPrice.toFixed(2)}` : '',
      currency:               current.price?.currency ?? cc.toUpperCase(),
      dealSince:              current.timestamp ?? null,
      dealExpiry:             current.expiry ?? null,
      historicalLow: lowest ? {
        price:          toNum(lowest.price?.amount),
        cut:            lowest.cut ?? 0,
        shop:           lowest.shop?.name ?? '',
        timestamp:      lowest.timestamp ?? null,
        priceFormatted: toNum(lowest.price?.amount) === 0
          ? 'Free'
          : `${sym}${toNum(lowest.price?.amount).toFixed(2)}`,
      } : null,
      igdbRating:        null, // filled in below
      controllerSupport: null, // filled in below
    });
  }

  // ── Phase 6: enrich with IGDB ratings + controller support ──────────────
  const itadSteamPairs = [];
  for (const entry of result.values()) {
    itadSteamPairs.push({ itadId: entry.appId, steamAppId: entry.steamAppId });
  }

  const [igdbRatings, controllerMap] = await Promise.all([
    igdb.getRatings(itadSteamPairs),
    steamcontroller.getControllerSupport(itadSteamPairs),
  ]);
  for (const entry of result.values()) {
    const r = igdbRatings.get(entry.appId);
    if (r) entry.igdbRating = r;
    const c = controllerMap.get(entry.appId);
    if (c) entry.controllerSupport = c;
  }

  console.log(`[Store/${cc}/${shopsKey}] done: ${result.size}/${titles.length} matched in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return result;
}

// ── Shops list (in-memory, process lifetime) ──────────────────────────────────
const _shopsCache = new Map(); // cc → shops array

async function getShops(cc = 'us') {
  if (_shopsCache.has(cc)) return _shopsCache.get(cc);

  const res = await axios.get(`${ITAD_BASE}/service/shops/v1`, {
    params: { country: cc.toUpperCase() },
    timeout: 10000,
  });
  const data = res.data ?? [];
  _shopsCache.set(cc, data);
  return data;
}

async function clearCache() {
  _shopsCache.clear();
  await Promise.all([delPattern('store:overview:*'), igdb.clearCache()]);
}

module.exports = { getDealsForTitles, getShops, clearCache, REGIONS, STEAM_SHOP_ID };
