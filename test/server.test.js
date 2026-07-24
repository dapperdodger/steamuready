require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { redis } = require('../services/cache');
const { pool } = require('../services/db');

test('GET /api/status returns ok without touching a live network call', async (t) => {
  t.after(() => { redis.disconnect(); pool.end(); }); // one teardown covers the whole file — node:test runs same-file tests in one process
  const res = await request(app).get('/api/status');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'ok');
});
