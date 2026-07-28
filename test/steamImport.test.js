require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { createUser, deleteUser, hashPassword } = require('../services/auth');
const { addWishlistItem, addOwned, listWishlistItadIds, listOwnedItadIds } = require('../services/wishlist');
const { resyncOwnedFromSteam, resyncWishlistFromSteam } = require('../services/steamImport');

async function makeTestUser(tag) {
  const email = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  return createUser(email, await hashPassword('password123'));
}

test('resyncOwnedFromSteam adds new steam-sourced games, drops stale ones, keeps manual entries, and clears matching wishlist entries', async () => {
  const user = await makeTestUser('steam-owned-resync');
  await addWishlistItem(user.id, 'itad-a'); // about to become owned via Steam import
  await addOwned(user.id, 'itad-manual', 'manual'); // unrelated manually-owned game

  await resyncOwnedFromSteam(user.id, ['itad-a', 'itad-b']);
  assert.deepStrictEqual((await listOwnedItadIds(user.id)).sort(), ['itad-a', 'itad-b', 'itad-manual'].sort());
  assert.deepStrictEqual(await listWishlistItadIds(user.id), []); // itad-a cleared from wishlist

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
