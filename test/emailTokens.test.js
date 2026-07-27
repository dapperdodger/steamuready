require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { pool } = require('../services/db');
const { createUser, deleteUser, hashPassword } = require('../services/auth');
const { createToken, consumeToken, hashToken } = require('../services/emailTokens');

async function makeTestUser(tag) {
  const email = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  return createUser(email, await hashPassword('password123'));
}

test('createToken/consumeToken round-trips and is single-use', async () => {
  const user = await makeTestUser('token-test');
  const token = await createToken(user.id, 'verify', 60 * 60 * 1000);

  assert.strictEqual(await consumeToken(token, 'verify'), user.id);
  assert.strictEqual(await consumeToken(token, 'verify'), null); // already consumed

  await deleteUser(user.id);
});

test('consumeToken rejects the wrong purpose without consuming the token', async () => {
  const user = await makeTestUser('token-purpose-test');
  const token = await createToken(user.id, 'reset', 60 * 60 * 1000);

  assert.strictEqual(await consumeToken(token, 'verify'), null);
  assert.strictEqual(await consumeToken(token, 'reset'), user.id); // still valid for the correct purpose

  await deleteUser(user.id);
});

test('consumeToken rejects an expired token', async () => {
  const user = await makeTestUser('token-expiry-test');
  const token = await createToken(user.id, 'verify', -1000); // already expired

  assert.strictEqual(await consumeToken(token, 'verify'), null);

  await deleteUser(user.id);
});

test('the database stores only a hash of the token, never the plaintext', async () => {
  const user = await makeTestUser('token-hash-test');
  const token = await createToken(user.id, 'verify', 60 * 60 * 1000);

  const { rows } = await pool.query('SELECT token FROM email_tokens WHERE user_id = $1', [user.id]);
  assert.strictEqual(rows[0].token, hashToken(token));
  assert.notStrictEqual(rows[0].token, token);

  await deleteUser(user.id);
});
