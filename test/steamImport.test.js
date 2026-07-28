require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { createUser, deleteUser, hashPassword } = require('../services/auth');
const {
  addWishlistItem, addOwned, listWishlistItadIds, listOwnedItadIds,
  addHidden, listHiddenItadIds,
} = require('../services/wishlist');
const { resyncOwnedFromSteam, resyncWishlistFromSteam, filterImportableResults } = require('../services/steamImport');
const { isAllowedEmulator } = require('../services/emuready');
const store = require('../services/store');
const { pool } = require('../services/db');

async function makeTestUser(tag) {
  const email = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  return createUser(email, await hashPassword('password123'));
}

test('resyncOwnedFromSteam adds new steam-sourced games, drops stale ones, keeps manual entries, and clears matching wishlist and hidden entries', async () => {
  const user = await makeTestUser('steam-owned-resync');
  await addWishlistItem(user.id, 'itad-a'); // about to become owned via Steam import
  await addHidden(user.id, 'itad-a'); // also hidden — should be cleared too
  await addOwned(user.id, 'itad-manual', 'manual'); // unrelated manually-owned game

  await resyncOwnedFromSteam(user.id, ['itad-a', 'itad-b']);
  assert.deepStrictEqual((await listOwnedItadIds(user.id)).sort(), ['itad-a', 'itad-b', 'itad-manual'].sort());
  assert.deepStrictEqual(await listWishlistItadIds(user.id), []); // itad-a cleared from wishlist
  assert.deepStrictEqual(await listHiddenItadIds(user.id), []); // itad-a cleared from hidden_games

  // Re-sync: itad-b no longer in the Steam library — drop it; itad-a and itad-manual stay.
  await resyncOwnedFromSteam(user.id, ['itad-a']);
  assert.deepStrictEqual((await listOwnedItadIds(user.id)).sort(), ['itad-a', 'itad-manual'].sort());

  await deleteUser(user.id);
});

test('resyncWishlistFromSteam adds/removes steam-sourced items, keeps manual entries, and never re-adds an owned game', async () => {
  const user = await makeTestUser('steam-wishlist-resync');
  await addWishlistItem(user.id, 'itad-manual-wish'); // untouched by resync

  await resyncWishlistFromSteam(user.id, ['itad-x', 'itad-y'], []);
  assert.deepStrictEqual(
    (await listWishlistItadIds(user.id)).sort(),
    ['itad-manual-wish', 'itad-x', 'itad-y'].sort()
  );

  // Re-sync: itad-y fell off Steam's wishlist; itad-x is now owned, so it must not be re-added.
  await resyncWishlistFromSteam(user.id, ['itad-x'], ['itad-x']);
  assert.deepStrictEqual(await listWishlistItadIds(user.id), ['itad-manual-wish']);

  await deleteUser(user.id);
});

// ── filterImportableResults (Fix B: only import games EmuReady actually
// has a Windows-capable listing for) ───────────────────────────────────────
function fakeResult(steamAppId, game) {
  return { steamAppId, game, matchStrategy: game ? 'exact' : 'not_found' };
}

function fakeListing(emulatorName) {
  return { emulator: { name: emulatorName }, performance: { rank: 1, label: 'Rank 1' } };
}

test('filterImportableResults keeps only results with at least one allowed-emulator listing', () => {
  const results = [
    fakeResult('1', { title: 'Allowed via Winlator', listings: [fakeListing('Winlator')] }),
    fakeResult('2', { title: 'Allowed via GameNative, mixed with disallowed', listings: [fakeListing('Dolphin'), fakeListing('GameNative')] }),
    fakeResult('3', { title: 'Only disallowed emulators', listings: [fakeListing('Dolphin'), fakeListing('RPCS3')] }),
    fakeResult('4', null), // not found on EmuReady at all
    fakeResult('5', { title: 'No listings anywhere', listings: [] }),
    fakeResult('6', { title: 'Listings field missing entirely' }),
  ];

  const kept = filterImportableResults(results, isAllowedEmulator);
  assert.deepStrictEqual(kept.map(r => r.steamAppId), ['1', '2']);
});

test('filterImportableResults returns an empty array for an empty input', () => {
  assert.deepStrictEqual(filterImportableResults([], isAllowedEmulator), []);
});

// ── persistGameTitles plumbing (Fix C: Steam import persists game_titles
// for every imported game so it renders with a real name/image) ───────────
test('persistGameTitles upserts a game_titles row for a buildExactEntry-shaped entry', async () => {
  const titleLower = `steam-import-plumbing-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const entry = store.buildExactEntry('Steam Import Plumbing Test', '2914440', 'itad-steam-import-plumbing-test');

  try {
    await store.persistGameTitles({ [titleLower]: entry });

    const { rows } = await pool.query(
      'SELECT itad_id, match_title, steam_app_id, image_url, resolved_via FROM game_titles WHERE title_lower = $1',
      [titleLower]
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].itad_id, 'itad-steam-import-plumbing-test');
    assert.strictEqual(rows[0].match_title, 'Steam Import Plumbing Test');
    assert.strictEqual(rows[0].steam_app_id, '2914440');
    assert.strictEqual(rows[0].image_url, 'https://cdn.akamai.steamstatic.com/steam/apps/2914440/header.jpg');
    assert.strictEqual(rows[0].resolved_via, 'steam');
  } finally {
    await pool.query('DELETE FROM game_titles WHERE title_lower = $1', [titleLower]);
  }
});
