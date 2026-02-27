const express = require('express');
const path = require('path');
const Fuse = require('fuse.js');
const emuready = require('./services/emuready');
const steam = require('./services/steam');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Devices ─────────────────────────────────────────────────────────────────
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await emuready.getDevices();
    res.json(devices);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Performance scales ───────────────────────────────────────────────────────
app.get('/api/performance-scales', async (req, res) => {
  try {
    const scales = await emuready.getPerformanceScales();
    res.json(scales);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Regions list ─────────────────────────────────────────────────────────────
app.get('/api/regions', (req, res) => {
  res.json(steam.REGIONS);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Correlation cache: the expensive Fuse.js matching runs once per region,
// then subsequent requests use instant Map lookups.
// ═══════════════════════════════════════════════════════════════════════════════
const _corrCache = {};       // cc → { gameMap, ts }
const CORR_TTL = 15 * 60 * 1000;

function isValidMatch(emuName, steamName) {
  const norm = s => s.toLowerCase().replace(/[®™:™®]/g, '').replace(/\s+/g, ' ').trim();
  const en = norm(emuName);
  const sn = norm(steamName);
  if (en === sn) return true;
  if (sn.startsWith(en) && sn.length > en.length && /[\s\-–—,]/.test(sn[en.length])) return true;
  if (en.startsWith(sn) && en.length > sn.length && /[\s\-–—,]/.test(en[sn.length])) return true;
  return false;
}

// Returns Map(gameNameLower → { gameName, sg (steam game), matchScore })
async function getCorrelationMap(cc) {
  const cached = _corrCache[cc];
  if (cached && Date.now() - cached.ts < CORR_TTL) {
    console.log(`[Corr/${cc}] cache hit: ${cached.gameMap.size} matches`);
    return cached.gameMap;
  }

  console.log(`[Corr/${cc}] building correlation map…`);
  const t0 = Date.now();

  // Fetch all data in parallel
  const [allListings, steamGames] = await Promise.all([
    emuready.getAllListings({}),
    steam.getAllSteamSales(cc),
  ]);

  if (!steamGames.length || !allListings.length) {
    console.log(`[Corr/${cc}] no data: emu=${allListings.length} steam=${steamGames.length}`);
    const empty = new Map();
    _corrCache[cc] = { gameMap: empty, ts: Date.now() };
    return empty;
  }

  // Build Fuse index once
  const fuse = new Fuse(steamGames, {
    keys: ['name'],
    threshold: 0.2,
    includeScore: true,
    ignoreLocation: false,
    findAllMatches: false,
  });

  // Extract unique game names from all listings, then Fuse-match each
  const uniqueNames = new Map(); // gameNameLower → gameName (original casing)
  for (const listing of allListings) {
    const gameName = listing.game?.title ?? listing.game?.name ?? '';
    if (!gameName) continue;
    const key = gameName.toLowerCase();
    if (!uniqueNames.has(key)) uniqueNames.set(key, gameName);
  }

  console.log(`[Corr/${cc}] ${uniqueNames.size} unique games from ${allListings.length} listings vs ${steamGames.length} Steam games`);

  const gameMap = new Map();   // gameNameLower → { gameName, sg, matchScore }
  const seenAppId = new Set(); // dedupe by Steam appId

  for (const [key, gameName] of uniqueNames) {
    const matches = fuse.search(gameName);
    if (!matches.length) continue;

    const best = matches[0];
    if ((best.score ?? 1) > 0.2) continue;

    const sg = best.item;
    if (!isValidMatch(gameName, sg.name)) continue;
    if (!sg.discountPercent) continue;

    // Dedupe: if this Steam appId was already matched by a different EmuReady name, skip
    if (seenAppId.has(sg.appId)) continue;
    seenAppId.add(sg.appId);

    gameMap.set(key, { gameName, sg, matchScore: best.score ?? 0 });
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[Corr/${cc}] done: ${gameMap.size} matches in ${elapsed}s`);

  _corrCache[cc] = { gameMap, ts: Date.now() };
  return gameMap;
}

// ── Main endpoint: correlated games ─────────────────────────────────────────
app.get('/api/games', async (req, res) => {
  try {
    const {
      deviceIds: rawDeviceIds = '',
      performanceId,
      maxPrice, minDiscount = 0,
      search, sort = 'discount_desc',
      page = 1,
      cc = 'us',
    } = req.query;

    const deviceIdList = rawDeviceIds ? rawDeviceIds.split(',').filter(Boolean) : [];
    const hasDeviceFilter = deviceIdList.length > 0;

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

    // 1. Get the correlation map (cached, instant after first build)
    const gameMap = await getCorrelationMap(cc);

    if (!gameMap.size) {
      return res.json({ games: [], total: 0, page: 1, pageSize: 24, totalPages: 0, warn: 'No correlations found' });
    }

    // 2. Get EmuReady listings (filtered by device if needed) — already cached in emuready.js
    let listings;
    if (hasDeviceFilter) {
      const perDevice = await Promise.all(
        deviceIdList.map(id => emuready.getAllListings({ deviceIds: [id] }))
      );
      const seen = new Set();
      listings = perDevice.flat().filter(l => {
        if (seen.has(l.id)) return false;
        seen.add(l.id);
        return true;
      });
    } else {
      listings = await emuready.getAllListings({});
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
        price: sg.price,
        originalPrice: sg.originalPrice,
        discountPercent: sg.discountPercent,
        priceFormatted: sg.priceFormatted,
        originalPriceFormatted: sg.originalPriceFormatted,
        imageUrl: sg.imageUrl,
        storeUrl: sg.storeUrl,
        matchScore: match.matchScore,
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

    // 4. Apply filters
    let filtered = correlated;

    if (search && search.trim()) {
      const sf = new Fuse(filtered, {
        keys: ['gameName', 'steamName', 'device', 'system'],
        threshold: 0.35,
      });
      filtered = sf.search(search.trim()).map(r => r.item);
    }

    if (maxPrice !== undefined && maxPrice !== '') {
      const mp = parseFloat(maxPrice);
      filtered = filtered.filter(g => g.price <= mp);
    }

    const minDisc = parseInt(minDiscount) || 0;
    if (minDisc > 0) {
      filtered = filtered.filter(g => g.discountPercent >= minDisc);
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
      default:
        filtered.sort((a, b) => b.discountPercent - a.discountPercent);
    }

    // 6. Paginate
    const PAGE_SIZE = 24;
    const pageNum = Math.max(1, parseInt(page));
    const total = filtered.length;
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const start = (pageNum - 1) * PAGE_SIZE;
    const games = filtered.slice(start, start + PAGE_SIZE);

    res.json({
      games, total, page: pageNum, pageSize: PAGE_SIZE, totalPages,
      _debug: { emuListings: listings.length, correlationMapSize: gameMap.size }
    });
  } catch (e) {
    console.error('[/api/games]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Cache refresh ─────────────────────────────────────────────────────────────
app.post('/api/refresh', async (req, res) => {
  emuready.clearCache();
  steam.clearCache();
  Object.keys(_corrCache).forEach(k => delete _corrCache[k]);
  res.json({ ok: true, message: 'Cache cleared. Next request will re-fetch.' });
});

// ── Status ────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎮  SteamUReady  →  http://localhost:${PORT}\n`);
});
