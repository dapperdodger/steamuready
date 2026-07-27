require('dotenv').config();
process.env.EMAIL_DRY_RUN = 'true';
const { test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { pool } = require('../services/db');
const { redis } = require('../services/cache');
const email = require('../services/email');
const { nextTestIp } = require('./helpers/testIp');

// One teardown for the whole file — node:test runs same-file tests in one
// process, and this top-level `after()` (unlike a per-test `t.after()`) only
// fires once all tests in this file have finished, so Redis/pool stay open
// for every test that needs them.
after(() => { redis.disconnect(); pool.end(); });

function extractToken(text) {
  const match = /[?&]resetToken=([^&\s]+)/.exec(text);
  return match ? match[1] : null;
}

test('forgot-password always returns a generic response, whether or not the email exists', async () => {
  const testIp = nextTestIp();
  const existsRes = await request(app).post('/api/auth/forgot-password').set('X-Forwarded-For', testIp).send({ email: 'nobody-real@example.com' });
  const missingRes = await request(app).post('/api/auth/forgot-password').set('X-Forwarded-For', testIp).send({ email: 'also-nobody-real@example.com' });
  assert.strictEqual(existsRes.status, 200);
  assert.deepStrictEqual(existsRes.body, missingRes.body);
});

test('forgot-password emails a working reset link for a real account, and reset-password invalidates other sessions', async () => {
  const testEmail = `reset-flow-${Date.now()}@example.com`;
  const testIp = nextTestIp();

  const agentA = request.agent(app); // session that will be invalidated
  await agentA.post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email: testEmail, password: 'password123' }).expect(201);
  const meBefore = await agentA.get('/api/auth/me');
  assert.strictEqual(meBefore.status, 200);

  await request(app).post('/api/auth/forgot-password').set('X-Forwarded-For', testIp).send({ email: testEmail }).expect(200);
  const token = extractToken(email._getLastDryRunEmail().text);
  assert.ok(token);

  const resetRes = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'brandnewpassword456' });
  assert.strictEqual(resetRes.status, 200);

  // The old session (agentA) must no longer be valid.
  const meAfter = await agentA.get('/api/auth/me');
  assert.strictEqual(meAfter.status, 401);

  // The old password no longer works; the new one does.
  const oldLogin = await request(app).post('/api/auth/login').set('X-Forwarded-For', testIp).send({ email: testEmail, password: 'password123' });
  assert.strictEqual(oldLogin.status, 401);
  const newLogin = await request(app).post('/api/auth/login').set('X-Forwarded-For', testIp).send({ email: testEmail, password: 'brandnewpassword456' });
  assert.strictEqual(newLogin.status, 200);

  // The reset token is single-use.
  const reuse = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'anotherpassword789' });
  assert.strictEqual(reuse.status, 400);

  await pool.query('DELETE FROM users WHERE email = $1', [testEmail]);
});
