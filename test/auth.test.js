require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword } = require('../services/auth');

test('hashPassword produces a bcrypt hash distinct from the input, and verifyPassword round-trips', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.notStrictEqual(hash, 'correct horse battery staple');
  assert.match(hash, /^\$2[aby]\$12\$/); // cost factor 12

  assert.strictEqual(await verifyPassword('correct horse battery staple', hash), true);
  assert.strictEqual(await verifyPassword('wrong password', hash), false);
});

test('hashPassword salts each call, producing different hashes for the same password', async () => {
  const [h1, h2] = await Promise.all([hashPassword('same password'), hashPassword('same password')]);
  assert.notStrictEqual(h1, h2);
});
