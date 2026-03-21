const axios = require('axios');
const { redis, delPattern } = require('./cache');

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

const TITLE_TTL    = 24 * 60 * 60 * 1000; // 24 h
const OVERVIEW_TTL = 15 * 60 * 1000;      // 15 m
const SHOPS_TTL    =      60 * 60 * 1000; //  1 h

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
        ? { id, matchTitle: title, imageUrl: '' }
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
              entries[key].imageUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${steamAppId}/header.jpg`;
            }
          }
        }
      } catch (e) {
        console.warn(`[Store] Steam appId lookup failed (offset ${i}):`, e.message);
      }
    }

    // Write all entries to Redis and collect results
    const pipeline = redis.pipeline();
    for (const [key, entry] of Object.entries(entries)) {
      pipeline.set(`store:title:${key}`, JSON.stringify(entry), 'PX', TITLE_TTL);
    }
    await pipeline.exec();
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

  // ── Phase 1: pipeline-read all title cache entries ─────────────────────────
  const pipeline = redis.pipeline();
  for (const t of titles) pipeline.get(`store:title:${t.toLowerCase()}`);
  const pipeResults = await pipeline.exec();

  const titleCache = {};
  const needsLookup = [];
  for (let i = 0; i < titles.length; i++) {
    const raw = pipeResults[i][1]; // [err, value]
    if (raw) {
      titleCache[titles[i].toLowerCase()] = JSON.parse(raw);
    } else {
      needsLookup.push(titles[i]);
    }
  }

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
    });
  }

  console.log(`[Store/${cc}/${shopsKey}] done: ${result.size}/${titles.length} matched in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return result;
}

// ── Shops list ────────────────────────────────────────────────────────────────
async function getShops(cc = 'us') {
  const k = `store:shops:${cc}`;
  const raw = await redis.get(k);
  if (raw) return JSON.parse(raw);

  const res = await axios.get(`${ITAD_BASE}/service/shops/v1`, {
    params: { country: cc.toUpperCase() },
    timeout: 10000,
  });
  const data = res.data ?? [];
  await redis.set(k, JSON.stringify(data), 'PX', SHOPS_TTL);
  return data;
}

async function clearCache() {
  await delPattern('store:*');
}

module.exports = { getDealsForTitles, getShops, clearCache, REGIONS, STEAM_SHOP_ID };
