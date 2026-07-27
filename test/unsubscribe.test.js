require('dotenv').config();
process.env.UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || 'test-secret-not-for-production';
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { pool } = require('../services/db');
const { createUser, hashPassword } = require('../services/auth');
const { generateUnsubscribeToken } = require('../services/unsubscribeTokens');

test('GET /api/alerts/unsubscribe with a valid token disables alerts and redirects', async () => {
  const testEmail = `unsub-get-${Date.now()}@example.com`;
  const user = await createUser(testEmail, await hashPassword('password123'));

  const res = await request(app).get(`/api/alerts/unsubscribe?u=${user.id}&token=${generateUnsubscribeToken(user.id)}`);
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.location, /unsubscribed=1/);

  const { rows } = await pool.query('SELECT alerts_enabled FROM users WHERE id = $1', [user.id]);
  assert.strictEqual(rows[0].alerts_enabled, false);

  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
});

test('POST /api/alerts/unsubscribe (RFC 8058 one-click) disables alerts and responds 200 with no redirect', async () => {
  const testEmail = `unsub-post-${Date.now()}@example.com`;
  const user = await createUser(testEmail, await hashPassword('password123'));

  const res = await request(app).post(`/api/alerts/unsubscribe?u=${user.id}&token=${generateUnsubscribeToken(user.id)}`);
  assert.strictEqual(res.status, 200);

  const { rows } = await pool.query('SELECT alerts_enabled FROM users WHERE id = $1', [user.id]);
  assert.strictEqual(rows[0].alerts_enabled, false);

  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
});

test('an invalid or mismatched token is rejected without disabling alerts', async () => {
  const testEmail = `unsub-invalid-${Date.now()}@example.com`;
  const user = await createUser(testEmail, await hashPassword('password123'));

  const res = await request(app).get(`/api/alerts/unsubscribe?u=${user.id}&token=not-a-real-token`);
  assert.strictEqual(res.status, 400);

  const { rows } = await pool.query('SELECT alerts_enabled FROM users WHERE id = $1', [user.id]);
  assert.strictEqual(rows[0].alerts_enabled, true); // unchanged, still the DB default

  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
});
