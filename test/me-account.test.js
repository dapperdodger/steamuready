require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { pool } = require('../services/db');
const { redis } = require('../services/cache');
const { nextTestIp } = require('./helpers/testIp');

// One teardown for the whole file — node:test runs same-file tests in one
// process, and this top-level after() (unlike a per-test t.after()) only
// fires once all tests in this file have finished.
after(() => { redis.disconnect(); pool.end(); });

test('PUT /api/me/password requires the current password and updates the hash', async () => {
  const email = `pw-change-${Date.now()}@example.com`;
  const testIp = nextTestIp();
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email, password: 'password123' }).expect(201);

  const wrongCurrent = await agent.put('/api/me/password').send({ currentPassword: 'nope', newPassword: 'newpassword456' });
  assert.strictEqual(wrongCurrent.status, 401);

  const ok = await agent.put('/api/me/password').send({ currentPassword: 'password123', newPassword: 'newpassword456' });
  assert.strictEqual(ok.status, 200);

  await agent.post('/api/auth/logout');
  const loginOld = await request(app).post('/api/auth/login').set('X-Forwarded-For', testIp).send({ email, password: 'password123' });
  assert.strictEqual(loginOld.status, 401);
  const loginNew = await request(app).post('/api/auth/login').set('X-Forwarded-For', testIp).send({ email, password: 'newpassword456' });
  assert.strictEqual(loginNew.status, 200);

  await pool.query('DELETE FROM users WHERE email = $1', [email]);
});

test('DELETE /api/me removes the account and its session', async () => {
  const email = `delete-acct-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email, password: 'password123' }).expect(201);

  await agent.delete('/api/me').expect(200);

  const me = await agent.get('/api/auth/me');
  assert.strictEqual(me.status, 401);

  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  assert.strictEqual(rows.length, 0);
});
