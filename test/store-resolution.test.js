require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { buildExactEntry, buildFallbackEntry, mapWithDelay } = require('../services/store');
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

test('mapWithDelay runs fn for every item in order and spaces calls by delayMs (not after the last one)', async () => {
  const start = Date.now();
  const elapsedAtCall = [];
  const results = await mapWithDelay(['a', 'b', 'c'], async (item) => {
    elapsedAtCall.push(Date.now() - start);
    return item.toUpperCase();
  }, 50);

  assert.deepStrictEqual(results, ['A', 'B', 'C']);
  assert.strictEqual(elapsedAtCall.length, 3);
  // Tolerant lower bound to avoid flakiness from timer granularity, while
  // still proving the spacing mechanism actually delays between calls.
  assert.ok(elapsedAtCall[1] - elapsedAtCall[0] >= 45, `expected >=45ms gap before call 2, got ${elapsedAtCall[1] - elapsedAtCall[0]}ms`);
  assert.ok(elapsedAtCall[2] - elapsedAtCall[1] >= 45, `expected >=45ms gap before call 3, got ${elapsedAtCall[2] - elapsedAtCall[1]}ms`);
  // No trailing wait after the last item — total runtime should be close to 2 delays, not 3.
  const total = Date.now() - start;
  assert.ok(total < 150, `expected no delay after last item, total runtime was ${total}ms`);
});
