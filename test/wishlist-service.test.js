require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { pool } = require('../services/db');
const { createUser, deleteUser, hashPassword } = require('../services/auth');
const {
  addWishlistItem, removeWishlistItem, listWishlistItadIds,
  addOwned, removeOwned, listOwnedItadIds,
  addHidden, removeHidden, listHiddenItadIds, listHiddenWithTitles,
} = require('../services/wishlist');

async function makeTestUser(tag) {
  const email = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  return createUser(email, await hashPassword('password123'));
}

test('wishlist add/list/remove is idempotent and scoped per user', async () => {
  const user = await makeTestUser('wish-svc');
  const itadId = 'itad-test-aaa';

  await addWishlistItem(user.id, itadId);
  await addWishlistItem(user.id, itadId); // duplicate add must not throw
  assert.deepStrictEqual(await listWishlistItadIds(user.id), [itadId]);

  await removeWishlistItem(user.id, itadId);
  assert.deepStrictEqual(await listWishlistItadIds(user.id), []);

  await deleteUser(user.id);
});

test('owned add/list/remove defaults source to manual', async () => {
  const user = await makeTestUser('owned-svc');
  const itadId = 'itad-test-bbb';

  await addOwned(user.id, itadId);
  const { rows } = await pool.query('SELECT source FROM owned_games WHERE user_id = $1 AND itad_id = $2', [user.id, itadId]);
  assert.strictEqual(rows[0].source, 'manual');
  assert.deepStrictEqual(await listOwnedItadIds(user.id), [itadId]);

  await removeOwned(user.id, itadId);
  assert.deepStrictEqual(await listOwnedItadIds(user.id), []);

  await deleteUser(user.id);
});

test('addOwned removes any existing wishlist entry for the same game', async () => {
  const user = await makeTestUser('owned-wishlist-svc');
  const itadId = 'itad-test-ccc';

  await addWishlistItem(user.id, itadId);
  assert.deepStrictEqual(await listWishlistItadIds(user.id), [itadId]);

  await addOwned(user.id, itadId);
  assert.deepStrictEqual(await listOwnedItadIds(user.id), [itadId]);
  assert.deepStrictEqual(await listWishlistItadIds(user.id), []); // owning it clears the wishlist entry

  await deleteUser(user.id);
});

test('hidden add/list/remove is idempotent and scoped per user, and addHidden clears the wishlist', async () => {
  const user = await makeTestUser('hidden-svc');
  const itadId = 'itad-test-ddd';

  await addWishlistItem(user.id, itadId);
  assert.deepStrictEqual(await listWishlistItadIds(user.id), [itadId]);

  await addHidden(user.id, itadId);
  await addHidden(user.id, itadId); // duplicate add must not throw
  assert.deepStrictEqual(await listHiddenItadIds(user.id), [itadId]);
  assert.deepStrictEqual(await listWishlistItadIds(user.id), []); // hiding it clears the wishlist entry

  await removeHidden(user.id, itadId);
  assert.deepStrictEqual(await listHiddenItadIds(user.id), []);

  await deleteUser(user.id);
});

test('addOwned removes any existing hidden entry for the same game', async () => {
  const user = await makeTestUser('owned-hidden-svc');
  const itadId = 'itad-test-eee';

  await addHidden(user.id, itadId);
  assert.deepStrictEqual(await listHiddenItadIds(user.id), [itadId]);

  await addOwned(user.id, itadId);
  assert.deepStrictEqual(await listOwnedItadIds(user.id), [itadId]);
  assert.deepStrictEqual(await listHiddenItadIds(user.id), []); // owning it clears the hidden entry

  await deleteUser(user.id);
});

test('listHiddenWithTitles joins game_titles for a display name', async () => {
  const user = await makeTestUser('hidden-titles-svc');
  const itadId = `itad-test-fff-${Date.now()}`;

  await pool.query(
    `INSERT INTO game_titles (title_lower, itad_id, match_title)
     VALUES ($1, $2, $3)
     ON CONFLICT (title_lower) DO UPDATE SET itad_id = EXCLUDED.itad_id`,
    [`test hidden game ${itadId}`, itadId, `Test Hidden Game ${itadId}`]
  );

  await addHidden(user.id, itadId);
  const list = await listHiddenWithTitles(user.id);
  assert.deepStrictEqual(list, [{ itadId, name: `Test Hidden Game ${itadId}` }]);

  await pool.query('DELETE FROM game_titles WHERE itad_id = $1', [itadId]);
  await deleteUser(user.id);
});
