require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { buildExactEntry, buildFallbackEntry } = require('../services/store');
const { redis } = require('../services/cache');

test('buildExactEntry assembles a steam-resolved-and-verified entry with a Steam header image', (t) => {
  t.after(() => redis.disconnect()); // one teardown covers the whole file — node:test runs same-file tests in one process
  const entry = buildExactEntry('Hollow Knight', '367520', '018d937f-1ae9-734c-ba47-bd357cf07edd');
  assert.deepStrictEqual(entry, {
    id: '018d937f-1ae9-734c-ba47-bd357cf07edd',
    matchTitle: 'Hollow Knight',
    steamAppId: '367520',
    imageUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/367520/header.jpg',
    resolvedVia: 'steam',
  });
});

test('buildExactEntry returns null when there is no itad_id (caller must fall back)', () => {
  assert.strictEqual(buildExactEntry('Hollow Knight', '367520', null), null);
});

test('buildFallbackEntry assembles a title-resolved entry with steamAppId left null', () => {
  const entry = buildFallbackEntry('Verdun Soundtrack', '0191ccea-f986-7119-8d93-d043727298f0');
  assert.deepStrictEqual(entry, {
    id: '0191ccea-f986-7119-8d93-d043727298f0',
    matchTitle: 'Verdun Soundtrack',
    steamAppId: null,
    imageUrl: '',
    resolvedVia: 'title',
  });
});

test('buildFallbackEntry marks a fully unresolved title so it is cached as a permanent miss', () => {
  assert.deepStrictEqual(buildFallbackEntry('Some Unmatchable Title', null), { id: null, resolvedVia: 'title' });
});
