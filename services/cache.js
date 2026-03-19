const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: false,
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
});

redis.on('error', err => console.error('[Redis] error:', err.message));
redis.on('connect', () => console.log('[Redis] connected'));
redis.on('ready', () => console.log('[Redis] ready'));

async function get(key) {
  const val = await redis.get(key);
  return val ? JSON.parse(val) : null;
}

async function set(key, value, ttlMs) {
  await redis.set(key, JSON.stringify(value), 'PX', ttlMs);
}

// Delete all keys matching a glob pattern using SCAN (safe for large keyspaces)
async function delPattern(pattern) {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== '0');
}

// In-process map of in-flight fetch promises, keyed by cache key.
// Prevents cache stampede: concurrent callers for the same key share one fetch.
const inflight = new Map();

async function getOrFetch(key, fetchFn, ttlMs) {
  const cached = await get(key);
  if (cached !== null) return cached;

  if (inflight.has(key)) return inflight.get(key);

  const promise = fetchFn()
    .then(async value => {
      await set(key, value, ttlMs);
      return value;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

module.exports = { redis, get, set, delPattern, getOrFetch, inflight };
