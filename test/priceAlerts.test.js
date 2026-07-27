require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { redis } = require('../services/cache');
const { claimRegionForToday } = require('../services/priceAlerts');

test('claimRegionForToday: first claim for a region+day succeeds, a second claim for the same region+day fails', async () => {
  const region = `test-region-${Date.now()}`;
  const at = new Date('2026-07-15T19:00:00Z');

  const first = await claimRegionForToday(region, at);
  assert.strictEqual(first, true);

  const second = await claimRegionForToday(region, at);
  assert.strictEqual(second, false);

  // Cleanup: delete whatever key this created (region/date-scoped, safe to target by pattern).
  await redis.del(`alert-sent:${region}:2026-07-15`);
});

test('claimRegionForToday: different regions on the same day claim independently', async () => {
  const at = new Date('2026-07-15T19:00:00Z');
  const regionA = `test-region-a-${Date.now()}`;
  const regionB = `test-region-b-${Date.now()}`;

  assert.strictEqual(await claimRegionForToday(regionA, at), true);
  assert.strictEqual(await claimRegionForToday(regionB, at), true);

  await redis.del(`alert-sent:${regionA}:2026-07-15`, `alert-sent:${regionB}:2026-07-15`);
});
