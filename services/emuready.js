const axios = require('axios');

const BASE = 'https://www.emuready.com/api/trpc';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.emuready.com/listings',
};

const _cache = {};
const TTL = 30 * 60 * 1000;

function getCached(k) {
  const e = _cache[k];
  return e && Date.now() - e.ts < TTL ? e.data : null;
}
function setCache(k, data) {
  _cache[k] = { data, ts: Date.now() };
  return data;
}

async function trpcGet(procedure, input = {}) {
  const inputEnc = encodeURIComponent(JSON.stringify({ json: input }));
  const url = `${BASE}/${procedure}?input=${inputEnc}`;
  const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const body = res.data;
  if (Array.isArray(body)) {
    return body[0]?.result?.data?.json ?? body[0]?.result?.data ?? null;
  }
  return body?.result?.data?.json ?? body?.result?.data ?? body;
}

async function getDevices() {
  const k = 'devices';
  const hit = getCached(k);
  if (hit) return hit;
  try {
    const data = await trpcGet('devices.get', { limit: 1000 });
    const list = data?.devices ?? data?.data ?? (Array.isArray(data) ? data : []);
    const normalized = list.map(d => ({
      ...d,
      name: [d.brand?.name, d.modelName].filter(Boolean).join(' '),
    }));
    normalized.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    console.log(`[EmuReady] loaded ${normalized.length} devices`);
    return setCache(k, normalized);
  } catch (e) {
    console.error('[EmuReady] devices error:', e.message);
    return [];
  }
}

async function getPerformanceScales() {
  const k = 'perf';
  const hit = getCached(k);
  if (hit) return hit;
  try {
    const data = await trpcGet('listings.performanceScales', {});
    const list = Array.isArray(data) ? data : data?.performanceScales ?? [];
    list.sort((a, b) => (a.rank ?? a.position ?? 0) - (b.rank ?? b.position ?? 0));
    return setCache(k, list);
  } catch (e) {
    console.error('[EmuReady] performanceScales error:', e.message);
    return [];
  }
}

async function getListings({ deviceId, performanceId, page = 1, limit = 200 } = {}) {
  const k = `listings_${deviceId}_${performanceId}_${page}_${limit}`;
  const hit = getCached(k);
  if (hit) return hit;
  const input = { page, limit };
  if (deviceId) input.deviceIds = [deviceId];
  if (performanceId) input.performanceIds = [performanceId];
  try {
    const data = await trpcGet('listings.get', input);
    return setCache(k, data);
  } catch (e) {
    console.error('[EmuReady] listings error:', e.message);
    return { data: [], total: 0 };
  }
}

// Fetch ALL listings across all pages for given filters.
// EmuReady caps page size at 100, so we paginate through everything.
// Results cached 30 min per filter combo.
async function getAllListings(filters, onProgress) {
  const deviceIds = (filters && filters.deviceIds) || [];
  const performanceIds = (filters && filters.performanceIds) || [];
  const k = 'all_listings_' + deviceIds.join(',') + '__' + performanceIds.join(',');
  const hit = getCached(k);
  if (hit) {
    console.log('[EmuReady] cache hit: ' + hit.length + ' listings');
    return hit;
  }
  console.log('[EmuReady] fetching all listing pages...');
  const PAGE_SIZE = 100;
  let all = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    try {
      const input = { page, limit: PAGE_SIZE };
      if (deviceIds.length) input.deviceIds = deviceIds;
      if (performanceIds.length) input.performanceIds = performanceIds;
      const data = await trpcGet('listings.get', input);
      const items = (data && data.listings) || (data && data.data) || [];
      all = all.concat(items);
      if (page === 1 && data && data.pagination) {
        totalPages = data.pagination.pages || 1;
        console.log('[EmuReady] total: ' + data.pagination.total + ', ' + totalPages + ' pages');
      }
      console.log('[EmuReady] page ' + page + '/' + totalPages + ': +' + items.length + ' (total: ' + all.length + ')');
      if (onProgress) onProgress(all.length, (data.pagination && data.pagination.total) || all.length);
      if (items.length < PAGE_SIZE) break;
      page++;
      if (page <= totalPages) await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.error('[EmuReady] page ' + page + ' error: ' + e.message);
      await new Promise(r => setTimeout(r, 1000));
      try {
        const input2 = { page, limit: PAGE_SIZE };
        if (deviceIds.length) input2.deviceIds = deviceIds;
        if (performanceIds.length) input2.performanceIds = performanceIds;
        const data2 = await trpcGet('listings.get', input2);
        all = all.concat((data2 && data2.listings) || (data2 && data2.data) || []);
      } catch (e2) { /* skip */ }
      page++;
    }
  }
  console.log('[EmuReady] done: ' + all.length + ' listings');
  return setCache(k, all);
}

function clearCache() {
  Object.keys(_cache).forEach(k => delete _cache[k]);
}

module.exports = { getDevices, getPerformanceScales, getListings, getAllListings, clearCache };
