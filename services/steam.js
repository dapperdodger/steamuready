const axios = require('axios');
const cheerio = require('cheerio');

const SEARCH_URL = 'https://store.steampowered.com/search/results/';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cookie': 'birthtime=0; mature_content=1; wants_mature_content=1',
};

// Supported regions: code → { label, currency symbol }
const REGIONS = {
  us: { label: '🇺🇸 USD',  sym: '$'  },
  fr: { label: '🇫🇷 EUR',  sym: '€'  },
  gb: { label: '🇬🇧 GBP',  sym: '£'  },
  de: { label: '🇩🇪 EUR',  sym: '€'  },
  ca: { label: '🇨🇦 CAD',  sym: 'CA$'},
  au: { label: '🇦🇺 AUD',  sym: 'AU$'},
  br: { label: '🇧🇷 BRL',  sym: 'R$' },
  tr: { label: '🇹🇷 TRY',  sym: '₺'  },
  ar: { label: '🇦🇷 ARS',  sym: '$'  },
  pl: { label: '🇵🇱 PLN',  sym: 'zł' },
};

const _cache = {};
const TTL = 15 * 60 * 1000;

function getCached(k) {
  const e = _cache[k];
  return e && Date.now() - e.ts < TTL ? e.data : null;
}

async function fetchPage(start, cc = 'us', count = 100) {
  const res = await axios.get(SEARCH_URL, {
    params: {
      specials: 1,
      start,
      count,
      sort_by: 'Reviews_DESC',
      cc,
      l: 'english',
    },
    headers: HEADERS,
    timeout: 20000,
  });
  return res.data; // HTML string
}

function parseGames(html, cc = 'us') {
  const $ = cheerio.load(html);
  const games = [];

  $('a.search_result_row').each((_, el) => {
    const $el = $(el);
    const appId = $el.attr('data-ds-appid');
    if (!appId || appId.includes(',')) return; // skip bundles/packs

    const name = $el.find('.title').text().trim();
    if (!name) return;

    // Skip non-game entries (soundtracks, artbooks, DLC, demos)
    const nameLower = name.toLowerCase();
    if (/\b(soundtrack|original soundtrack|ost|artbook|dlc|demo|prologue|episode|season pass|expansion pack|upgrade pack|content pack|cosmetic pack)\b/.test(nameLower)) return;

    // Discount % from data-discount attribute
    const $discBlock = $el.find('.discount_block');
    const discountPct = parseInt($discBlock.attr('data-discount') || '0') || 0;
    if (discountPct === 0) return; // only discounted games

    // Final price in cents
    const finalCents = parseInt(
      $el.find('[data-price-final]').first().attr('data-price-final') || '0'
    );

    const price = finalCents / 100;
    const originalPrice = discountPct > 0 && finalCents > 0
      ? Math.round(finalCents / (1 - discountPct / 100)) / 100
      : price;

    const sym = REGIONS[cc]?.sym ?? '$';
    const priceFormatted = finalCents === 0 ? 'Free' : `${sym}${price.toFixed(2)}`;
    const originalPriceFormatted = discountPct > 0 ? `${sym}${originalPrice.toFixed(2)}` : '';

    const headerUrl = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;

    games.push({
      appId,
      name,
      imageUrl: headerUrl,
      storeUrl: `https://store.steampowered.com/app/${appId}/?cc=${cc}`,
      discountPercent: discountPct,
      price,
      originalPrice,
      priceFormatted,
      originalPriceFormatted,
      currency: cc.toUpperCase(),
    });
  });

  return games;
}

// Fetch ALL Steam sale games for a given region.
// Steam has ~12 000 games on sale; we fetch them all (pausing 300ms between pages).
// Results are cached 15 min per region.
async function getAllSteamSales(cc = 'us', onProgress = null) {
  const k = `steam_sales_${cc}`;
  const hit = getCached(k);
  if (hit) {
    console.log(`[Steam/${cc}] cache hit: ${hit.length} games`);
    return hit;
  }

  console.log(`[Steam/${cc}] fetching all sale pages…`);
  const all = [];
  const seen = new Set();
  let start = 0;
  const count = 100;
  let consecutiveEmpty = 0;

  // Steam has ~12k games on sale; cap at 15 000 to be safe
  while (all.length < 15000) {
    try {
      const html = await fetchPage(start, cc, count);
      const games = parseGames(html, cc);

      if (games.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) {
          console.log(`[Steam/${cc}] no more games, stopping at ${all.length}`);
          break;
        }
        start += count;
        continue;
      }
      consecutiveEmpty = 0;

      let added = 0;
      for (const g of games) {
        if (!seen.has(g.appId)) {
          seen.add(g.appId);
          all.push(g);
          added++;
        }
      }

      start += count;
      const pageNum = start / count;
      console.log(`[Steam/${cc}] page ${pageNum}: +${added} (total: ${all.length})`);

      if (onProgress) onProgress(all.length);

      // If this page had fewer raw rows than expected, likely near the end
      // (We still continue — Steam results page can vary in density)
      if (games.length < 10 && added === 0) break;

      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error(`[Steam/${cc}] fetch error at start=${start}:`, e.message);
      // Retry once after a pause
      await new Promise(r => setTimeout(r, 2000));
      try {
        const html = await fetchPage(start, cc, count);
        const games = parseGames(html, cc);
        for (const g of games) {
          if (!seen.has(g.appId)) { seen.add(g.appId); all.push(g); }
        }
        start += count;
      } catch {
        break; // give up on this page
      }
    }
  }

  console.log(`[Steam/${cc}] done: ${all.length} sale games`);
  _cache[k] = { data: all, ts: Date.now() };
  return all;
}

function clearCache() {
  Object.keys(_cache).forEach(k => delete _cache[k]);
}

module.exports = { getAllSteamSales, clearCache, REGIONS };
