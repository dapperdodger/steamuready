require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { parseBestSteamAppIdResponse } = require('../services/emuready');

test('parseBestSteamAppIdResponse extracts a found appId as a string', () => {
  const data = { success: true, appId: '367520', query: 'Hollow Knight', found: true };
  assert.deepStrictEqual(parseBestSteamAppIdResponse(data), { found: true, appId: '367520' });
});

test('parseBestSteamAppIdResponse treats found:false as a clean miss', () => {
  const data = { success: true, appId: null, query: 'Not A Real Game', found: false };
  assert.deepStrictEqual(parseBestSteamAppIdResponse(data), { found: false, appId: null });
});

test('parseBestSteamAppIdResponse treats a missing/malformed response as a miss, not a crash', () => {
  assert.deepStrictEqual(parseBestSteamAppIdResponse(null), { found: false, appId: null });
  assert.deepStrictEqual(parseBestSteamAppIdResponse({}), { found: false, appId: null });
  assert.deepStrictEqual(parseBestSteamAppIdResponse({ found: true }), { found: false, appId: null }); // found:true but no appId is not trustworthy
});
