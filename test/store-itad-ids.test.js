require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert');
const { buildItadIdEntry } = require('../services/store');
const { redis } = require('../services/cache');

// One teardown for the whole file — node:test runs same-file tests in one
// process, and this top-level `after()` (unlike a per-test `t.after()`) only
// fires once all tests in this file have finished, so it covers both tests.
// services/store.js pulls in services/cache.js's redis client (a live
// connection) even though these two tests never touch it directly.
after(() => redis.disconnect());

test('buildItadIdEntry formats a discounted entry with historical low', () => {
  const item = {
    current: {
      price: { amount: '19.99', currency: 'USD' },
      regular: { amount: '39.99' },
      cut: 50,
      shop: { name: 'Steam' },
      url: 'https://store.steampowered.com/app/123',
      timestamp: '2026-01-01T00:00:00Z',
      expiry: null,
    },
    lowest: {
      price: { amount: '9.99' },
      cut: 75,
      shop: { name: 'GOG' },
      timestamp: '2025-06-01T00:00:00Z',
    },
  };
  const titleRow = { match_title: 'Example Game', steam_app_id: '123', image_url: 'https://example.com/img.jpg' };

  const entry = buildItadIdEntry('itad-uuid-1', titleRow, item, 'us');

  assert.strictEqual(entry.appId, 'itad-uuid-1');
  assert.strictEqual(entry.name, 'Example Game');
  assert.strictEqual(entry.price, 19.99);
  assert.strictEqual(entry.priceFormatted, '$19.99');
  assert.strictEqual(entry.discountPercent, 50);
  assert.strictEqual(entry.historicalLow.priceFormatted, '$9.99');
});

test('buildItadIdEntry falls back to sane defaults when titleRow/lowest are missing', () => {
  const item = { current: { price: { amount: '0' }, cut: 0, shop: {}, url: '' }, lowest: null };
  const entry = buildItadIdEntry('itad-uuid-2', undefined, item, 'us');
  assert.strictEqual(entry.name, '');
  assert.strictEqual(entry.priceFormatted, 'Free');
  assert.strictEqual(entry.historicalLow, null);
});
