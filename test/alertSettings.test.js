require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { pool } = require('../services/db');
const { nextTestIp } = require('./helpers/testIp');

test('PUT /api/me/alert-settings requires auth, validates alertMode, and persists both fields', async () => {
  const anon = await request(app).put('/api/me/alert-settings').send({ alertsEnabled: false, alertMode: 'price_drop' });
  assert.strictEqual(anon.status, 401);

  const email = `alert-settings-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email, password: 'password123' }).expect(201);

  const invalidMode = await agent.put('/api/me/alert-settings').send({ alertsEnabled: true, alertMode: 'not_a_real_mode' });
  assert.strictEqual(invalidMode.status, 400);

  const ok = await agent.put('/api/me/alert-settings').send({ alertsEnabled: false, alertMode: 'historical_low' });
  assert.strictEqual(ok.status, 200);

  const me = await agent.get('/api/auth/me');
  assert.strictEqual(me.body.alertsEnabled, false);
  assert.strictEqual(me.body.alertMode, 'historical_low');

  await pool.query('DELETE FROM users WHERE email = $1', [email]);
});
