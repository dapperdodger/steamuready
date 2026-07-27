require('dotenv').config();
process.env.UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || 'test-secret-not-for-production';
const test = require('node:test');
const assert = require('node:assert');
const { generateUnsubscribeToken, verifyUnsubscribeToken, buildUnsubscribeUrl } = require('../services/unsubscribeTokens');

test('generateUnsubscribeToken is deterministic per user and differs across users', () => {
  const tokenA1 = generateUnsubscribeToken('user-a');
  const tokenA2 = generateUnsubscribeToken('user-a');
  const tokenB = generateUnsubscribeToken('user-b');
  assert.strictEqual(tokenA1, tokenA2);
  assert.notStrictEqual(tokenA1, tokenB);
});

test('verifyUnsubscribeToken accepts the correct token and rejects a wrong or malformed one', () => {
  const token = generateUnsubscribeToken('user-a');
  assert.strictEqual(verifyUnsubscribeToken('user-a', token), true);
  assert.strictEqual(verifyUnsubscribeToken('user-a', generateUnsubscribeToken('user-b')), false);
  assert.strictEqual(verifyUnsubscribeToken('user-a', 'not-hex-and-wrong-length'), false);
  assert.strictEqual(verifyUnsubscribeToken('user-a', undefined), false);
});

test('buildUnsubscribeUrl embeds a verifiable token for the given user', () => {
  const url = buildUnsubscribeUrl('http://localhost:3000', 'user-a');
  const params = new URL(url).searchParams;
  assert.strictEqual(params.get('u'), 'user-a');
  assert.strictEqual(verifyUnsubscribeToken('user-a', params.get('token')), true);
});
