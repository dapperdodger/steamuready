require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { parseBestSteamAppIdResponse, throttledDedup } = require('../services/emuready');
const { redis } = require('../services/cache');

test('parseBestSteamAppIdResponse extracts a found appId as a string', (t) => {
  t.after(() => redis.disconnect());
  const data = { success: true, appId: '367520', query: 'Hollow Knight', found: true };
  assert.deepStrictEqual(parseBestSteamAppIdResponse(data), { found: true, appId: '367520' });
});

test('parseBestSteamAppIdResponse treats found:false as a clean miss', () => {
  const data = { success: true, appId: null, query: 'Not A Real Game', found: false };
  assert.deepStrictEqual(parseBestSteamAppIdResponse(data), { found: false, appId: null });
});

test('parseBestSteamAppIdResponse treats a missing/malformed response as a miss, not a crash', () => {
  assert.deepStrictEqual(parseBestSteamAppIdResponse(null), { found: false, appId: null });
  assert.deepStrictEqual(parseBestSteamAppIdResponse({}), { found: false, appId: null });
  assert.deepStrictEqual(parseBestSteamAppIdResponse({ found: true }), { found: false, appId: null }); // found:true but no appId is not trustworthy
});

test('throttledDedup: concurrent calls for the same key share one in-flight call', async () => {
  let callCount = 0;
  const call = throttledDedup(async (key) => {
    callCount++;
    await new Promise(r => setTimeout(r, 20));
    return `result-${key}`;
  }, 10);

  const [a, b, c] = await Promise.all([call('x'), call('x'), call('x')]);
  assert.strictEqual(callCount, 1, 'fn should run exactly once for 3 concurrent calls with the same key');
  assert.deepStrictEqual([a, b, c], ['result-x', 'result-x', 'result-x']);
});

test('throttledDedup: distinct keys are globally serialized and spaced by delayMs, even fired concurrently', async () => {
  const start = Date.now();
  const elapsedAtCall = [];
  const call = throttledDedup(async (key) => {
    elapsedAtCall.push(Date.now() - start);
    return key;
  }, 50);

  // Fire all three at the same instant, as concurrent live requests would.
  await Promise.all([call('a'), call('b'), call('c')]);

  assert.strictEqual(elapsedAtCall.length, 3);
  const gap1 = elapsedAtCall[1] - elapsedAtCall[0];
  const gap2 = elapsedAtCall[2] - elapsedAtCall[1];
  assert.ok(gap1 >= 45, `expected >=45ms gap between call 1 and 2 despite concurrent firing, got ${gap1}ms`);
  assert.ok(gap2 >= 45, `expected >=45ms gap between call 2 and 3 despite concurrent firing, got ${gap2}ms`);
});

test('throttledDedup: a key is re-fetched (not deduped) once its prior call has settled', async () => {
  let callCount = 0;
  const call = throttledDedup(async (key) => {
    callCount++;
    return callCount;
  }, 5);

  const first = await call('x');
  const second = await call('x');
  assert.strictEqual(first, 1);
  assert.strictEqual(second, 2, 'a new call for the same key after the first settled should run fn again, not reuse the stale result');
});
