require('dotenv').config();
process.env.EMAIL_DRY_RUN = 'true';
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { pool } = require('../services/db');
const email = require('../services/email');
const { nextTestIp } = require('./helpers/testIp');

function extractToken(text) {
  const match = /[?&]token=([^&\s]+)/.exec(text);
  return match ? match[1] : null;
}

test('signup sends a verification email, and the verify link marks email_verified', async () => {
  const testEmail = `verify-flow-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email: testEmail, password: 'password123' }).expect(201);

  const sent = email._getLastDryRunEmail();
  assert.strictEqual(sent.to, testEmail);
  const token = extractToken(sent.text);
  assert.ok(token);

  const before = await agent.get('/api/auth/me');
  assert.strictEqual(before.body.emailVerified, false);
  assert.strictEqual(before.body.alertsEnabled, true);
  assert.strictEqual(before.body.alertMode, 'sale_period');

  const verifyRes = await agent.get(`/api/auth/verify?token=${token}`);
  assert.strictEqual(verifyRes.status, 302);
  assert.match(verifyRes.headers.location, /emailVerified=1/);

  const after = await agent.get('/api/auth/me');
  assert.strictEqual(after.body.emailVerified, true);

  await pool.query('DELETE FROM users WHERE email = $1', [testEmail]);
});

test('an invalid verify token redirects with an error and does not verify anything', async () => {
  const res = await request(app).get('/api/auth/verify?token=not-a-real-token');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.location, /emailError=invalid_token/);
});

test('resend-verification requires auth, resends while unverified, and no-ops once verified', async () => {
  const anon = await request(app).post('/api/auth/resend-verification');
  assert.strictEqual(anon.status, 401);

  const testEmail = `resend-flow-${Date.now()}@example.com`;
  const testIp = nextTestIp();
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email: testEmail, password: 'password123' }).expect(201);

  const resendRes = await agent.post('/api/auth/resend-verification').set('X-Forwarded-For', testIp);
  assert.strictEqual(resendRes.status, 200);
  assert.strictEqual(resendRes.body.alreadyVerified, undefined);

  const token = extractToken(email._getLastDryRunEmail().text);
  await agent.get(`/api/auth/verify?token=${token}`).expect(302);

  const afterVerify = await agent.post('/api/auth/resend-verification').set('X-Forwarded-For', testIp);
  assert.strictEqual(afterVerify.body.alreadyVerified, true);

  await pool.query('DELETE FROM users WHERE email = $1', [testEmail]);
});
