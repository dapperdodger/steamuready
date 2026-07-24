require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { sessionMiddleware, requireAuth } = require('../middleware/session');
const { redis } = require('../services/cache');

test('requireAuth blocks requests with no session userId, allows requests with one', async (t) => {
  t.after(() => redis.disconnect()); // one teardown covers the whole file — node:test runs same-file tests in one process

  const app = express();
  app.use(sessionMiddleware);
  app.get('/anon-ok', (req, res) => res.json({ hasSession: !!req.session }));
  app.post('/login-stub', (req, res) => { req.session.userId = 'test-user-id'; res.json({ ok: true }); });
  app.get('/whoami', requireAuth, (req, res) => res.json({ userId: req.session.userId }));

  const anonRes = await request(app).get('/anon-ok');
  assert.strictEqual(anonRes.status, 200);
  assert.strictEqual(anonRes.body.hasSession, true);

  const blocked = await request(app).get('/whoami');
  assert.strictEqual(blocked.status, 401);

  const agent = request.agent(app);
  await agent.post('/login-stub').expect(200);
  const allowed = await agent.get('/whoami');
  assert.strictEqual(allowed.status, 200);
  assert.strictEqual(allowed.body.userId, 'test-user-id');
});
