require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { pool } = require('../services/db');
const { nextTestIp } = require('./helpers/testIp');

async function signupAgent(tag) {
  const email = `${tag}-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email, password: 'password123' }).expect(201);
  return { agent, email };
}

test('GET /api/steam/status requires auth and reports unlinked by default', async () => {
  const anon = await request(app).get('/api/steam/status');
  assert.strictEqual(anon.status, 401);

  const { agent, email } = await signupAgent('steam-status');
  const status = await agent.get('/api/steam/status');
  assert.strictEqual(status.status, 200);
  assert.deepStrictEqual(status.body, { linked: false, personaName: null });

  await pool.query('DELETE FROM users WHERE email = $1', [email]);
});

test('POST /api/steam/unlink requires auth and is idempotent when nothing is linked', async () => {
  const anon = await request(app).post('/api/steam/unlink');
  assert.strictEqual(anon.status, 401);

  const { agent, email } = await signupAgent('steam-unlink');
  await agent.post('/api/steam/unlink').expect(200);

  await pool.query('DELETE FROM users WHERE email = $1', [email]);
});

test('POST /api/steam/import requires auth and 400s when no Steam account is linked', async () => {
  const anon = await request(app).post('/api/steam/import');
  assert.strictEqual(anon.status, 401);

  const { agent, email } = await signupAgent('steam-import-unlinked');
  const res = await agent.post('/api/steam/import');
  assert.strictEqual(res.status, 400);

  await pool.query('DELETE FROM users WHERE email = $1', [email]);
});
