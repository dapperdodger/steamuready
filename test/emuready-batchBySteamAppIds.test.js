require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { filterValidSteamAppIds, parseBatchBySteamAppIdsResponse } = require('../services/emuready');

test('filterValidSteamAppIds keeps only positive-integer-shaped ids', () => {
  assert.deepStrictEqual(
    filterValidSteamAppIds(['220', '588650', 'not-a-number', '', null, undefined, '12.5']),
    ['220', '588650']
  );
});

test('parseBatchBySteamAppIdsResponse passes through found and not-found entries unchanged', () => {
  const data = {
    success: true,
    results: [
      { steamAppId: '220', game: { title: 'Half-Life 2' }, matchStrategy: 'exact' },
      { steamAppId: '4000000', game: null, matchStrategy: 'not_found' },
    ],
    totalRequested: 2, totalFound: 1, totalNotFound: 1,
  };
  assert.deepStrictEqual(parseBatchBySteamAppIdsResponse(data), data.results);
});

test('parseBatchBySteamAppIdsResponse returns an empty array for a malformed response', () => {
  assert.deepStrictEqual(parseBatchBySteamAppIdsResponse(null), []);
  assert.deepStrictEqual(parseBatchBySteamAppIdsResponse({}), []);
});
