require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { extractSteamId } = require('../services/steamAuth');

test('extractSteamId parses a valid Steam claimedIdentifier', () => {
  assert.strictEqual(
    extractSteamId('https://steamcommunity.com/openid/id/76561198000000000'),
    '76561198000000000'
  );
});

test('extractSteamId returns null for anything that is not a Steam claimedIdentifier', () => {
  assert.strictEqual(extractSteamId('https://example.com/not-steam'), null);
  assert.strictEqual(extractSteamId(''), null);
  assert.strictEqual(extractSteamId(undefined), null);
  assert.strictEqual(extractSteamId('https://steamcommunity.com/openid/id/not-a-number'), null);
});
