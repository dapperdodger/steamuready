const axios = require('axios');

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

// ── Cache ─────────────────────────────────────────────────────────────────────
// All entries live in one object; key prefixes differentiate types:
//   `title:${titleLower}`            → { id, matchTitle, imageUrl, ts } | { id: null, ts }
//   `overview:${cc}:${shopsKey}`     → { map: Map<itadId, overviewItem>, ts }
//   `shops:${cc}`                    → { data: [...], ts }
const _cache = {};
const TITLE_TTL    = 24 * 60 * 60 * 1000; // 24 h — titles are stable
const OVERVIEW_TTL = 15 * 60 * 1000;      // 15 m — prices change
const SHOPS_TTL    = 60 * 60 * 1000;      // 1 h  — shop list rarely changes

// ── Phase 1: Batch title → ITAD ID resolution + Steam appId lookup ────────────
// POST /lookup/id/title/v1   — resolves titles → ITAD UUIDs (up to 200/call)
// POST /lookup/shop/61/id/v1 — resolves ITAD UUIDs → Steam appIds (up to 200/call)
// Image URLs are then derived from Steam CDN with no per-game calls.
async function resolveTitlesBatch(titles) {
  const BATCH_SIZE = 200;
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

    // Seed cache entries (imageUrl filled in next step for matched titles)
    for (const [title, id] of Object.entries(lookupResult)) {
      _cache[`title:${title.toLowerCase()}`] = id
        ? { id, matchTitle: title, imageUrl: '', ts: Date.now() }
        : { id: null, ts: Date.now() };
    }

    // 1b. ITAD UUIDs → Steam appIds (batch, one call per 200)
    const matchedIds = Object.values(lookupResult).filter(Boolean);
    if (!matchedIds.length) continue;

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
          const entry = _cache[`title:${title.toLowerCase()}`];
          if (entry) entry.imageUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${steamAppId}/header.jpg`;
        }
      }
    } catch (e) {
      console.warn(`[Store] Steam appId lookup failed (offset ${i}):`, e.message);
    }
  }
}

// ── Phase 2: Fetch overview for a batch of ITAD IDs ───────────────────────────
// POST /games/overview/v2 returns current best price + all-time historical low
// for up to 200 games per call. Replaces /games/prices/v3.
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
  // ITAD returns price amounts as either number or numeric string
  return parseFloat(v) || 0;
}

// ── Main export ───────────────────────────────────────────────────────────────
// Given a list of EmuReady game titles, returns Map(titleLower → deal).
// cc    — ISO 3166-1 alpha-2 lowercase (e.g. 'us')
// shops — array of ITAD shop IDs; empty = all shops
async function getDealsForTitles(titles, cc = 'us', shops = []) {
  const shopsKey = shops.length ? shops.slice().sort().join(',') : 'all';
  const t0 = Date.now();

  // ── Phase 1: batch-resolve uncached/stale title → ITAD ID mappings ────────
  const needsLookup = titles.filter(t => {
    const e = _cache[`title:${t.toLowerCase()}`];
    return !e || Date.now() - e.ts > TITLE_TTL;
  });

  if (needsLookup.length) {
    console.log(`[Store] batch-resolving ${needsLookup.length} titles…`);
    await resolveTitlesBatch(needsLookup);
    console.log(`[Store] title resolution done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  // ── Phase 2: collect matched ITAD IDs ─────────────────────────────────────
  const itadIds = [];
  for (const title of titles) {
    const e = _cache[`title:${title.toLowerCase()}`];
    if (e?.id) itadIds.push(e.id);
  }

  if (!itadIds.length) {
    console.log(`[Store] no ITAD matches for ${titles.length} titles`);
    return new Map();
  }

  // ── Phase 3: fetch overview — current price + historical low ──────────────
  const overviewKey = `overview:${cc}:${shopsKey}`;
  let overviewEntry = _cache[overviewKey];
  const now = Date.now();

  if (!overviewEntry || now - overviewEntry.ts > OVERVIEW_TTL) {
    console.log(`[Store/${cc}/${shopsKey}] overview cache miss — fetching ${itadIds.length} games…`);
    const pairs = await fetchOverviewAPI(itadIds, cc, shops);
    _cache[overviewKey] = { map: new Map(pairs), ts: now };
    overviewEntry = _cache[overviewKey];
    console.log(`[Store/${cc}/${shopsKey}] overview cache built: ${overviewEntry.map.size} entries`);
  } else {
    const missing = itadIds.filter(id => !overviewEntry.map.has(id));
    if (missing.length) {
      console.log(`[Store/${cc}/${shopsKey}] fetching ${missing.length} new entries (incremental)…`);
      const pairs = await fetchOverviewAPI(missing, cc, shops);
      pairs.forEach(([id, item]) => overviewEntry.map.set(id, item));
    } else {
      console.log(`[Store/${cc}/${shopsKey}] overview cache hit (${overviewEntry.map.size} entries)`);
    }
  }

  // ── Phase 4: assemble result Map(titleLower → deal object) ────────────────
  const sym = REGIONS[cc]?.sym ?? '$';
  const result = new Map();

  for (const title of titles) {
    const titleEntry = _cache[`title:${title.toLowerCase()}`];
    if (!titleEntry?.id) continue;

    const item = overviewEntry.map.get(titleEntry.id);
    if (!item?.current) continue;

    const current = item.current;
    const lowest  = item.lowest ?? null;

    const price         = toNum(current.price?.amount);
    const originalPrice = toNum(current.regular?.amount ?? current.price?.amount);

    result.set(title.toLowerCase(), {
      appId:                  titleEntry.id,
      name:                   titleEntry.matchTitle,
      storeName:              current.shop?.name ?? 'Store',
      imageUrl:               titleEntry.imageUrl ?? '',
      storeUrl:               current.url,
      discountPercent:        current.cut ?? 0,
      price,
      originalPrice,
      priceFormatted:         price === 0 ? 'Free' : `${sym}${price.toFixed(2)}`,
      originalPriceFormatted: (current.cut ?? 0) > 0 ? `${sym}${originalPrice.toFixed(2)}` : '',
      currency:               current.price?.currency ?? cc.toUpperCase(),
      // TODO: display historical low in the UI — show badge/tooltip like
      //       "Historical low: $X.XX (-YY%) at StoreName on Date"
      historicalLow: lowest ? {
        price:          toNum(lowest.price?.amount),
        cut:            lowest.cut ?? 0,
        shop:           lowest.shop?.name ?? '',
        timestamp:      lowest.timestamp ?? null,
        priceFormatted: toNum(lowest.price?.amount) === 0
          ? 'Free'
          : `${sym}${toNum(lowest.price?.amount).toFixed(2)}`,
      } : null,
    });
  }

  console.log(`[Store/${cc}/${shopsKey}] done: ${result.size}/${titles.length} matched in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return result;
}

// ── Shops list ────────────────────────────────────────────────────────────────
async function getShops(cc = 'us') {
  const k = `shops:${cc}`;
  const e = _cache[k];
  if (e && Date.now() - e.ts < SHOPS_TTL) return e.data;

  const res = await axios.get(`${ITAD_BASE}/service/shops/v1`, {
    params: { country: cc.toUpperCase() },
    timeout: 10000,
  });
  const data = res.data ?? [];
  _cache[k] = { data, ts: Date.now() };
  return data;
}

function clearCache() {
  Object.keys(_cache).forEach(k => delete _cache[k]);
}

module.exports = { getDealsForTitles, getShops, clearCache, REGIONS, STEAM_SHOP_ID };
