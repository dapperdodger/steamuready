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

function uniqueEmail(tag) {
  return `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function cleanupUser(email) {
  await pool.query('DELETE FROM users WHERE email = $1', [email]);
}

test('signup: creates a user, sets a session cookie, rejects duplicates and weak input', async () => {
  const email = uniqueEmail('signup');
  const testIp = nextTestIp();
  const agent = request.agent(app);

  const ok = await agent.post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email, password: 'password123' });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.body.email, email);
  assert.deepStrictEqual(ok.body.preferences, {});
  assert.strictEqual(ok.body.hideOwnedDefault, false);

  const dup = await request(app).post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email, password: 'password123' });
  assert.strictEqual(dup.status, 409);

  const weakPw = await request(app).post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email: uniqueEmail('weak'), password: 'short' });
  assert.strictEqual(weakPw.status, 400);

  const badEmail = await request(app).post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email: 'not-an-email', password: 'password123' });
  assert.strictEqual(badEmail.status, 400);

  await cleanupUser(email);
});

test('login: succeeds with correct credentials, generic 401 on wrong password or unknown email', async () => {
  const email = uniqueEmail('login');
  const testIp = nextTestIp();
  await request(app).post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email, password: 'password123' }).expect(201);

  const wrongPw = await request(app).post('/api/auth/login').set('X-Forwarded-For', testIp).send({ email, password: 'wrong-password' });
  assert.strictEqual(wrongPw.status, 401);
  assert.strictEqual(wrongPw.body.error, 'Invalid email or password');

  const unknownEmail = await request(app).post('/api/auth/login').set('X-Forwarded-For', testIp).send({ email: uniqueEmail('nope'), password: 'password123' });
  assert.strictEqual(unknownEmail.status, 401);
  assert.strictEqual(unknownEmail.body.error, 'Invalid email or password');

  const ok = await request(app).post('/api/auth/login').set('X-Forwarded-For', testIp).send({ email, password: 'password123' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.email, email);
  assert.strictEqual(ok.body.hideOwnedDefault, false);

  await cleanupUser(email);
});

test('logout clears the session, and /me reflects logged-in vs logged-out state', async () => {
  const email = uniqueEmail('me');
  const testIp = nextTestIp();
  const agent = request.agent(app);

  const loggedOut = await agent.get('/api/auth/me');
  assert.strictEqual(loggedOut.status, 401);

  await agent.post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email, password: 'password123' }).expect(201);

  const loggedIn = await agent.get('/api/auth/me');
  assert.strictEqual(loggedIn.status, 200);
  assert.strictEqual(loggedIn.body.email, email);
  assert.strictEqual(loggedIn.body.hideOwnedDefault, false);

  await agent.post('/api/auth/logout').expect(200);

  const afterLogout = await agent.get('/api/auth/me');
  assert.strictEqual(afterLogout.status, 401);

  await cleanupUser(email);
});
