require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const Fuse = require('fuse.js');
const emuready = require('./services/emuready');
const store = require('./services/store');
const { redis, delPattern } = require('./services/cache');

const app = express();
app.set('trust proxy', 1); // honour X-Forwarded-For from ALB
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'img-src': ["'self'", 'data:', 'https://cdn.akamai.steamstatic.com'],
    },
  },
}));
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Devices ─────────────────────────────────────────────────────────────────
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await emuready.getDevices();
    res.json(devices);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Performance scales ───────────────────────────────────────────────────────
app.get('/api/performance-scales', async (req, res) => {
  try {
    const scales = await emuready.getPerformanceScales();
    res.json(scales);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Regions list ─────────────────────────────────────────────────────────────
app.get('/api/regions', (req, res) => {
  res.json(store.REGIONS);
});

// Stores supported by GameNative (Steam, Epic, GOG, Amazon) and GameHub Lite (Steam).
// Amazon has no ITAD presence, so we allow Steam + Epic Game Store + GOG.
const ALLOWED_SHOP_IDS = new Set([61, 16, 35]); // Steam, Epic Game Store, GOG

// Apps supported: GameNative, GameHub / GameHub Lite, Winlator.
// Matched case-insensitively as substrings of the emulator name.
const ALLOWED_EMULATOR_TERMS = ['gamenative', 'game native', 'gamehub', 'game hub', 'winlator'];

function isAllowedEmulator(listing) {
  const name = (listing.emulator?.name ?? '').toLowerCase();
  return ALLOWED_EMULATOR_TERMS.some(term => name.includes(term));
}

// Canonical app slugs — order matters: gamehublite before gamehub
const APP_DEFINITIONS = [
  { slug: 'winlator',    test: n => n.includes('winlator') },
  { slug: 'gamenative',  test: n => n.includes('gamenative') || n.includes('game native') },
  { slug: 'gamehublite', test: n => (n.includes('gamehub') || n.includes('game hub')) && n.includes('lite') },
  { slug: 'gamehub',     test: n => (n.includes('gamehub') || n.includes('game hub')) && !n.includes('lite') },
];

function getEmulatorApp(emulatorName) {
  const n = (emulatorName ?? '').toLowerCase();
  for (const app of APP_DEFINITIONS) {
    if (app.test(n)) return app.slug;
  }
  return null;
}

// ── Shops list ────────────────────────────────────────────────────────────────
app.get('/api/shops', async (req, res) => {
  try {
    const shops = await store.getShops(req.query.cc || 'us');
    res.json(shops.filter(s => ALLOWED_SHOP_IDS.has(s.id)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Correlation cache: the expensive title-matching runs once per region/devices,
// then subsequent requests use instant Map lookups.
// Stored in Redis as a JSON array of [key, entry] pairs (Map serialization).
// ═══════════════════════════════════════════════════════════════════════════════
const CORR_TTL = 15 * 60 * 1000;

// Returns Map(gameNameLower → { gameName, sg, matchScore })
// deviceIds: optional array — when provided, only correlate listings for those devices.
// shopIds:   optional array of ITAD shop IDs — when empty, all shops are included.
async function getCorrelationMap(cc, deviceIds = [], shopIds = []) {
  const shopsKey = shopIds.length ? shopIds.slice().sort().join(',') : 'all';
  const cacheKey = deviceIds.length
    ? `corr:${cc}:${shopsKey}:${[...deviceIds].sort().join(',')}`
    : `corr:${cc}:${shopsKey}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    const gameMap = new Map(JSON.parse(cached));
    console.log(`[Corr/${cacheKey}] cache hit: ${gameMap.size} matches`);
    return gameMap;
  }

  const label = deviceIds.length ? `${cc}/${shopsKey} (${deviceIds.length} device(s))` : `${cc}/${shopsKey}`;
  console.log(`[Corr/${label}] building correlation map…`);
  const t0 = Date.now();

  // Fetch EmuReady listings (scoped to devices when provided)
  const listingFilter = deviceIds.length ? { deviceIds } : {};
  const allListings = (await emuready.getAllListings(listingFilter)).filter(isAllowedEmulator);

  if (!allListings.length) {
    console.log(`[Corr/${label}] no EmuReady listings`);
    await redis.set(cacheKey, '[]', 'PX', CORR_TTL);
    return new Map();
  }

  // Extract unique game titles
  const uniqueNames = new Map(); // titleLower → original title
  for (const listing of allListings) {
    const gameName = listing.game?.title ?? listing.game?.name ?? '';
    if (!gameName) continue;
    const key = gameName.toLowerCase();
    if (!uniqueNames.has(key)) uniqueNames.set(key, gameName);
  }

  console.log(`[Corr/${label}] ${uniqueNames.size} unique titles from ${allListings.length} listings`);

  // Ask the store module to resolve titles → deals (handles all ITAD calls + caching)
  const dealMap = await store.getDealsForTitles([...uniqueNames.values()], cc, shopIds);

  const gameMap = new Map();
  const seenAppId = new Set();

  for (const [key, gameName] of uniqueNames) {
    const sg = dealMap.get(key);
    if (!sg) continue;
    if (seenAppId.has(sg.appId)) continue;
    seenAppId.add(sg.appId);
    gameMap.set(key, { gameName, sg, matchScore: 0 });
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[Corr/${label}] done: ${gameMap.size} matches in ${elapsed}s`);

  await redis.set(cacheKey, JSON.stringify([...gameMap.entries()]), 'PX', CORR_TTL);
  return gameMap;
}

// ── Rate limiter: up to 10 requests per 10 s per IP ──────────────────────────
// Pagination (page > 1) is exempt only if the same IP has already made a page-1
// request within the last 5 minutes (tracked in Redis).
const RATE_WINDOW_MS = 10 * 1000;
const RATE_LIMIT_MAX = 10;
const SEARCHED_TTL_MS = 5 * 60 * 1000; // how long a page-1 grant lasts
async function gamesRateLimiter(req, res, next) {
  const page = parseInt(req.query.page) || 1;

  if (page > 1) {
    const searchedKey = `searched:games:${req.ip}`;
    const hasSearched = await redis.exists(searchedKey);
    if (hasSearched) return next(); // legitimate pagination, skip rate limit
    // No prior page-1 request — fall through and consume a rate-limit token
  }

  const key = `ratelimit:games:${req.ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.pexpire(key, RATE_WINDOW_MS);
  if (count > RATE_LIMIT_MAX) {
    const ttl = await redis.pttl(key);
    return res.status(429).json({
      error: 'Rate limit exceeded. Please wait before searching again.',
      retryAfter: Math.ceil(ttl / 1000),
    });
  }

  // Record that this IP has made a page-1 search
  if (page === 1) {
    await redis.set(`searched:games:${req.ip}`, '1', 'PX', SEARCHED_TTL_MS);
  }

  next();
}

// ── Main endpoint: correlated games ─────────────────────────────────────────
app.get('/api/games', gamesRateLimiter, async (req, res) => {
  try {
    const {
      deviceIds: rawDeviceIds = '',
      performanceId,
      maxPrice, minDiscount = 0,
      histLow,
      search, sort = 'discount_desc',
      newAge,
      page = 1,
      cc = 'us',
      shops: rawShops = '',
      apps: rawApps = '',
    } = req.query;

    const deviceIdList = rawDeviceIds ? rawDeviceIds.split(',').filter(Boolean) : [];
    if (!deviceIdList.length) {
      return res.status(400).json({ error: 'deviceIds is required' });
    }
    const hasDeviceFilter = true;
    const shopIds = rawShops ? rawShops.split(',').map(Number).filter(Boolean) : [...ALLOWED_SHOP_IDS];
    const appSlugs = rawApps ? new Set(rawApps.split(',').filter(Boolean)) : null;

    // Resolve performanceId → all scales with rank ≤ selected
    let perfIds = null;
    if (performanceId) {
      const allScales = await emuready.getPerformanceScales();
      const selected = allScales.find(s => String(s.id) === String(performanceId));
      if (selected) {
        const maxRank = selected.rank ?? 99;
        perfIds = allScales
          .filter(s => (s.rank ?? 99) <= maxRank)
          .map(s => String(s.id));
      } else {
        perfIds = [performanceId];
      }
    }

    // 1. Build correlation map scoped to selected devices/shops — cache hit after first build
    const gameMap = await getCorrelationMap(cc, deviceIdList, shopIds);

    if (!gameMap.size) {
      return res.json({ games: [], total: 0, page: 1, pageSize: 24, totalPages: 0, warn: 'No correlations found' });
    }

    // 2. Get EmuReady listings — reuses the same cache entry populated in step 1
    const listingFilter = hasDeviceFilter ? { deviceIds: deviceIdList } : {};
    let listings = (await emuready.getAllListings(listingFilter)).filter(isAllowedEmulator);

    // Filter by app (emulator)
    if (appSlugs && appSlugs.size) {
      listings = listings.filter(l => {
        const slug = getEmulatorApp(l.emulator?.name);
        return slug && appSlugs.has(slug);
      });
    }

    // Filter by performance
    if (perfIds && perfIds.length) {
      const perfIdSet = new Set(perfIds.map(String));
      listings = listings.filter(l =>
        l.performance?.id ? perfIdSet.has(String(l.performance.id)) : true
      );
    }

    if (!listings.length) {
      return res.json({ games: [], total: 0, page: 1, pageSize: 24, totalPages: 0 });
    }

    // 3. Build correlated results using instant Map lookups (no Fuse.js)
    const seenAppId = new Map(); // appId → entry (keep best perf rank)
    const correlated = [];

    for (const listing of listings) {
      const gameName = listing.game?.title ?? listing.game?.name ?? '';
      if (!gameName) continue;

      const match = gameMap.get(gameName.toLowerCase());
      if (!match) continue;

      const sg = match.sg;
      const perf = listing.performance ?? listing.performanceScale ?? {};
      const rank = perf.rank ?? perf.position ?? perf.value ?? 0;

      const dev = listing.device ?? {};
      const deviceName = dev.name
        ?? [dev.brand?.name, dev.modelName].filter(Boolean).join(' ')
        ?? '';

      const entry = {
        id: listing.id,
        gameName: match.gameName,
        steamName: sg.name,
        device: deviceName,
        system: listing.system?.name ?? listing.game?.system?.name ?? '',
        emulator: listing.emulator?.name ?? '',
        performanceLabel: perf.label ?? perf.description ?? '',
        performanceRank: rank,
        notes: listing.notes ?? '',
        appId: sg.appId,
        storeName: sg.storeName,
        price: sg.price,
        originalPrice: sg.originalPrice,
        discountPercent: sg.discountPercent,
        priceFormatted: sg.priceFormatted,
        originalPriceFormatted: sg.originalPriceFormatted,
        imageUrl: sg.imageUrl,
        storeUrl: sg.storeUrl,
        matchScore: match.matchScore,
        historicalLow: sg.historicalLow ?? null,
        dealSince: sg.dealSince ?? null,
        dealExpiry: sg.dealExpiry ?? null,
      };

      // Dedupe by Steam appId: keep best (lowest) performance rank
      const existing = seenAppId.get(sg.appId);
      if (existing) {
        if (rank > 0 && (existing.performanceRank === 0 || rank < existing.performanceRank)) {
          const idx = correlated.indexOf(existing);
          if (idx !== -1) correlated[idx] = entry;
          seenAppId.set(sg.appId, entry);
        }
      } else {
        seenAppId.set(sg.appId, entry);
        correlated.push(entry);
      }
    }

    // 4. Apply filters — drop anything with no active discount
    let filtered = correlated.filter(g => g.discountPercent > 0);

    if (search && search.trim()) {
      const sf = new Fuse(filtered, {
        keys: ['gameName', 'steamName', 'device', 'system'],
        threshold: 0.35,
      });
      filtered = sf.search(search.trim()).map(r => r.item);
    }

    if (maxPrice !== undefined && maxPrice !== '') {
      const mp = parseFloat(maxPrice);
      if (isNaN(mp) || mp < 0 || mp > 10000) {
        return res.status(400).json({ error: 'maxPrice must be between 0 and 10000' });
      }
      filtered = filtered.filter(g => g.price <= mp);
    }

    const minDisc = Math.min(100, Math.max(0, parseInt(minDiscount) || 0));
    if (minDisc > 0) {
      filtered = filtered.filter(g => g.discountPercent >= minDisc);
    }

    if (histLow === '1') {
      filtered = filtered.filter(g => g.historicalLow && g.price <= g.historicalLow.price);
    }

    const newAgeHours = parseInt(newAge);
    if (newAgeHours > 0) {
      const cutoff = Date.now() - newAgeHours * 60 * 60 * 1000;
      filtered = filtered.filter(g => g.dealSince && new Date(g.dealSince).getTime() >= cutoff);
    }

    // 5. Sort
    switch (sort) {
      case 'discount_desc':
        filtered.sort((a, b) => b.discountPercent - a.discountPercent);
        break;
      case 'price_asc':
        filtered.sort((a, b) => a.price - b.price);
        break;
      case 'price_desc':
        filtered.sort((a, b) => b.price - a.price);
        break;
      case 'compat_desc':
        filtered.sort((a, b) => a.performanceRank - b.performanceRank);
        break;
      case 'name_asc':
        filtered.sort((a, b) => a.gameName.localeCompare(b.gameName));
        break;
      case 'new_desc':
        filtered.sort((a, b) => {
          if (!a.dealSince && !b.dealSince) return 0;
          if (!a.dealSince) return 1;
          if (!b.dealSince) return -1;
          return new Date(b.dealSince) - new Date(a.dealSince);
        });
        break;
      default:
        filtered.sort((a, b) => b.discountPercent - a.discountPercent);
    }

    // 6. Paginate
    const PAGE_SIZE = 24;
    const pageNum = Math.min(500, Math.max(1, parseInt(page) || 1));
    const total = filtered.length;
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const start = (pageNum - 1) * PAGE_SIZE;
    const games = filtered.slice(start, start + PAGE_SIZE);

    res.json({ games, total, page: pageNum, pageSize: PAGE_SIZE, totalPages });
  } catch (e) {
    console.error('[/api/games]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Cache refresh ─────────────────────────────────────────────────────────────
app.post('/api/refresh', async (req, res) => {
  const secret = process.env.REFRESH_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'Refresh endpoint not configured' });
  }
  const auth = req.headers['authorization'] ?? '';
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  await Promise.all([
    emuready.clearCache(),
    store.clearCache(),
    delPattern('corr:*'),
  ]);
  res.json({ ok: true, message: 'Cache cleared. Next request will re-fetch.' });
});

// ── Status ────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`\n🎮  SteamUReady Running`);
});

// ── Graceful shutdown (ECS/ALB task draining) ─────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM received — draining connections…');
  server.close(() => {
    console.log('[shutdown] all connections closed, exiting');
    process.exit(0);
  });
});
