require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { pickBestListing, buildCompatEntry } = require('../services/steamLibraryCompat');

function listing(rank, deviceId, socId, emulatorName = 'GameHub') {
  return {
    device: { id: deviceId, modelName: `Device ${deviceId}`, soc: { id: socId, name: `Soc ${socId}` } },
    emulator: { name: emulatorName },
    performance: { rank, label: `Rank ${rank}` },
  };
}

test('pickBestListing picks the lowest-rank listing when no device preference matches', () => {
  const listings = [listing(3, 'dev-a', 'soc-a'), listing(1, 'dev-b', 'soc-b'), listing(5, 'dev-c', 'soc-c')];
  assert.strictEqual(pickBestListing(listings, [], []).performance.rank, 1);
});

test("pickBestListing prefers a listing matching the user's saved device, even if another device ranks better", () => {
  const listings = [listing(1, 'dev-a', 'soc-a'), listing(4, 'dev-b', 'soc-b')];
  const best = pickBestListing(listings, ['dev-b'], []);
  assert.strictEqual(best.device.id, 'dev-b');
});

test('pickBestListing falls back to the best listing overall when no device/SoC preference matches', () => {
  const listings = [listing(2, 'dev-a', 'soc-a'), listing(1, 'dev-b', 'soc-b')];
  assert.strictEqual(pickBestListing(listings, ['dev-z'], ['soc-z']).performance.rank, 1);
});

test('pickBestListing returns null for an empty listings array', () => {
  assert.strictEqual(pickBestListing([], [], []), null);
});

test('buildCompatEntry returns null for a not-found result', () => {
  const entry = buildCompatEntry({ steamAppId: '4000000', game: null, matchStrategy: 'not_found' }, new Set(), new Set(), [], []);
  assert.strictEqual(entry, null);
});

test('buildCompatEntry assembles a display entry with owned/wishlisted flags and best compatibility', () => {
  const result = {
    steamAppId: '220',
    game: {
      title: 'Half-Life 2',
      boxartUrl: 'https://example.com/box.jpg',
      imageUrl: 'https://example.com/img.jpg',
      listings: [listing(1, 'dev-a', 'soc-a', 'GameHub')],
    },
    matchStrategy: 'exact',
  };
  const entry = buildCompatEntry(result, new Set(['220']), new Set(), [], []);
  assert.deepStrictEqual(entry, {
    steamAppId: '220',
    gameName: 'Half-Life 2',
    imageUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/220/header.jpg',
    owned: true,
    wishlisted: false,
    compatibility: { rank: 1, label: 'Rank 1', deviceName: 'Device dev-a', socName: 'Soc soc-a', emulatorName: 'GameHub' },
  });
});
