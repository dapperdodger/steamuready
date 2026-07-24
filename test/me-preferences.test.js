require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { redis } = require('../services/cache');
const { pool } = require('../services/db');
const { nextTestIp } = require('./helpers/testIp');

// One teardown for the whole file — node:test runs same-file tests in one
// process, and this top-level `after()` (unlike a per-test `t.after()`) only
// fires once all tests in this file have finished, so Redis/pool stay open
// for every test that needs them.
after(() => { redis.disconnect(); pool.end(); });

test('PUT /api/me/preferences requires auth and persists a preferences object', async () => {
  const anon = await request(app).put('/api/me/preferences').send({ region: 'us' });
  assert.strictEqual(anon.status, 401);

  const email = `prefs-test-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email, password: 'password123' }).expect(201);

  const invalid = await agent.put('/api/me/preferences').send([1, 2, 3]);
  assert.strictEqual(invalid.status, 400);

  const saved = await agent.put('/api/me/preferences').send({ region: 'de', deviceIds: ['abc'] });
  assert.strictEqual(saved.status, 200);
  assert.deepStrictEqual(saved.body.preferences, { region: 'de', deviceIds: ['abc'] });

  const me = await agent.get('/api/auth/me');
  assert.deepStrictEqual(me.body.preferences, { region: 'de', deviceIds: ['abc'] });

  await pool.query('DELETE FROM users WHERE email = $1', [email]);
});

test('PUT /api/me/hide-owned-default requires auth and persists a boolean', async () => {
  const anon = await request(app).put('/api/me/hide-owned-default').send({ hideOwnedDefault: true });
  assert.strictEqual(anon.status, 401);

  const email = `hide-owned-default-test-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email, password: 'password123' }).expect(201);

  const invalid = await agent.put('/api/me/hide-owned-default').send({ hideOwnedDefault: 'yes' });
  assert.strictEqual(invalid.status, 400);

  const saved = await agent.put('/api/me/hide-owned-default').send({ hideOwnedDefault: true });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.body.hideOwnedDefault, true);

  const me = await agent.get('/api/auth/me');
  assert.strictEqual(me.body.hideOwnedDefault, true);

  await pool.query('DELETE FROM users WHERE email = $1', [email]);
});
