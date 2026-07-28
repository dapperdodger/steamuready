require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { pickBestListing, buildOwnedCompatEntry } = require('../services/steamLibraryCompat');

function listing(rank, deviceId, socId, emulatorName = 'GameHub', id = `listing-${deviceId}`) {
  return {
    id,
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

test('buildOwnedCompatEntry never returns null — a game with no EmuReady match still shows up, with empty compatibility', () => {
  const titleRow = { itad_id: 'itad-a', steam_app_id: '220', match_title: 'Half-Life 2', image_url: '' };
  const entry = buildOwnedCompatEntry('itad-a', titleRow, null, [], []);
  assert.deepStrictEqual(entry, {
    itadId: 'itad-a',
    gameName: 'Half-Life 2',
    imageUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/220/header.jpg',
    listingId: null,
    compatibility: null,
  });
});

test('buildOwnedCompatEntry falls back to game_titles.image_url when there is no known Steam App ID', () => {
  const titleRow = { itad_id: 'itad-b', steam_app_id: null, match_title: 'GOG-only Game', image_url: 'https://example.com/gog.jpg' };
  const entry = buildOwnedCompatEntry('itad-b', titleRow, null, [], []);
  assert.strictEqual(entry.imageUrl, 'https://example.com/gog.jpg');
  assert.strictEqual(entry.compatibility, null);
});

test('buildOwnedCompatEntry filters out non-Windows-capable emulator listings, leaving compatibility null', () => {
  const titleRow = { itad_id: 'itad-c', steam_app_id: '620', match_title: 'Portal 2', image_url: '' };
  const batchResult = {
    steamAppId: '620',
    game: { title: 'Portal 2', listings: [listing(1, 'dev-a', 'soc-a', 'Eden')] }, // Switch emulator — not allowed
    matchStrategy: 'exact',
  };
  const entry = buildOwnedCompatEntry('itad-c', titleRow, batchResult, [], []);
  assert.strictEqual(entry.compatibility, null);
  assert.strictEqual(entry.listingId, null);
});

test('buildOwnedCompatEntry assembles compatibility and an EmuReady listing link when an allowed-emulator listing exists', () => {
  const titleRow = { itad_id: 'itad-d', steam_app_id: '220', match_title: 'Half-Life 2', image_url: '' };
  const batchResult = {
    steamAppId: '220',
    game: {
      title: 'Half-Life 2',
      listings: [listing(1, 'dev-a', 'soc-a', 'GameHub', 'listing-abc123')],
    },
    matchStrategy: 'exact',
  };
  const entry = buildOwnedCompatEntry('itad-d', titleRow, batchResult, [], []);
  assert.deepStrictEqual(entry, {
    itadId: 'itad-d',
    gameName: 'Half-Life 2',
    imageUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/220/header.jpg',
    listingId: 'listing-abc123',
    compatibility: { rank: 1, label: 'Rank 1', deviceName: 'Device dev-a', socName: 'Soc soc-a', emulatorName: 'GameHub' },
  });
});
