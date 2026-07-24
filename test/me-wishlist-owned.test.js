require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { pool } = require('../services/db');
const { redis } = require('../services/cache');
const { nextTestIp } = require('./helpers/testIp');

// One teardown for the whole file — node:test runs same-file tests in one
// process, and this top-level `after()` (unlike a per-test `t.after()`) only
// fires once all tests in this file have finished, so Redis/pool stay open
// for every test that needs them.
after(() => { redis.disconnect(); pool.end(); });

async function seedGameTitleAndOverview(itadId, steamAppId) {
  await pool.query(
    `INSERT INTO game_titles (title_lower, itad_id, match_title, steam_app_id, image_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (title_lower) DO UPDATE SET itad_id = EXCLUDED.itad_id, steam_app_id = EXCLUDED.steam_app_id`,
    [`test wishlist game ${itadId}`, itadId, `Test Wishlist Game ${itadId}`, steamAppId, 'https://example.com/img.jpg']
  );
  const overviewEntry = {
    current: {
      price: { amount: '9.99', currency: 'USD' },
      regular: { amount: '19.99' },
      cut: 50,
      shop: { name: 'Steam' },
      url: `https://store.steampowered.com/app/${steamAppId}`,
    },
    lowest: null,
  };
  await redis.set('store:overview:us:all', JSON.stringify([[itadId, overviewEntry]]), 'PX', 60000);
}

async function cleanup(email, itadId) {
  await pool.query('DELETE FROM users WHERE email = $1', [email]);
  await pool.query('DELETE FROM game_titles WHERE itad_id = $1', [itadId]);
  await redis.del('store:overview:us:all');
}

test('wishlist: unauthenticated requests are rejected, authenticated add/list/remove works', async () => {
  const anon = await request(app).get('/api/me/wishlist');
  assert.strictEqual(anon.status, 401);

  const itadId = `itad-wishlist-test-${Date.now()}`;
  await seedGameTitleAndOverview(itadId, '900001');

  const email = `wishlist-route-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email, password: 'password123' }).expect(201);

  await agent.post(`/api/me/wishlist/${itadId}`).expect(204);

  const list1 = await agent.get('/api/me/wishlist');
  assert.strictEqual(list1.status, 200);
  assert.strictEqual(list1.body.games.length, 1);
  assert.strictEqual(list1.body.games[0].appId, itadId);
  assert.strictEqual(list1.body.games[0].name, `Test Wishlist Game ${itadId}`);

  await agent.delete(`/api/me/wishlist/${itadId}`).expect(204);
  const list2 = await agent.get('/api/me/wishlist');
  assert.strictEqual(list2.body.games.length, 0);

  await cleanup(email, itadId);
});

test('owned: add/list/remove works, and marking owned removes the game from the wishlist', async () => {
  const itadId = `itad-owned-test-${Date.now()}`;
  await seedGameTitleAndOverview(itadId, '900002');

  const email = `owned-route-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email, password: 'password123' }).expect(201);

  // Wishlist it first, to prove marking it owned clears the wishlist entry.
  await agent.post(`/api/me/wishlist/${itadId}`).expect(204);

  await agent.post(`/api/me/owned/${itadId}`).expect(204);
  const owned = await agent.get('/api/me/owned');
  assert.strictEqual(owned.body.games.length, 1);

  const wishlist = await agent.get('/api/me/wishlist');
  assert.strictEqual(wishlist.body.games.length, 0); // owning it cleared the wishlist entry

  await agent.delete(`/api/me/owned/${itadId}`).expect(204);
  const ownedAfter = await agent.get('/api/me/owned');
  assert.strictEqual(ownedAfter.body.games.length, 0);

  await cleanup(email, itadId);
});

test('hidden: unauthenticated requests are rejected, authenticated hide/list/unhide works and returns only itadId+name', async () => {
  const anon = await request(app).get('/api/me/hidden');
  assert.strictEqual(anon.status, 401);

  const itadId = `itad-hidden-test-${Date.now()}`;
  await seedGameTitleAndOverview(itadId, '900003');

  const email = `hidden-route-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email, password: 'password123' }).expect(201);

  // Wishlist it first, to prove hiding it clears the wishlist entry.
  await agent.post(`/api/me/wishlist/${itadId}`).expect(204);

  await agent.post(`/api/me/hidden/${itadId}`).expect(204);
  const hidden = await agent.get('/api/me/hidden');
  assert.strictEqual(hidden.status, 200);
  assert.deepStrictEqual(hidden.body.games, [{ itadId, name: `Test Wishlist Game ${itadId}` }]);

  const wishlist = await agent.get('/api/me/wishlist');
  assert.strictEqual(wishlist.body.games.length, 0); // hiding it cleared the wishlist entry

  await agent.delete(`/api/me/hidden/${itadId}`).expect(204);
  const hiddenAfter = await agent.get('/api/me/hidden');
  assert.strictEqual(hiddenAfter.body.games.length, 0);

  await cleanup(email, itadId);
});
