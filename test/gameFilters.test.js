require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { excludeOwned, excludeHidden } = require('../services/gameFilters');

test('excludeOwned removes games whose appId is in the owned set', () => {
  const games = [{ appId: 'a' }, { appId: 'b' }, { appId: 'c' }];
  assert.deepStrictEqual(excludeOwned(games, ['b']).map(g => g.appId), ['a', 'c']);
});

test('excludeOwned returns the input unchanged when ownedItadIds is empty', () => {
  const games = [{ appId: 'a' }];
  assert.deepStrictEqual(excludeOwned(games, []), games);
});

test('excludeHidden removes games whose appId is in the hidden set', () => {
  const games = [{ appId: 'a' }, { appId: 'b' }, { appId: 'c' }];
  assert.deepStrictEqual(excludeHidden(games, ['a', 'c']).map(g => g.appId), ['b']);
});

test('excludeHidden returns the input unchanged when hiddenItadIds is empty', () => {
  const games = [{ appId: 'a' }];
  assert.deepStrictEqual(excludeHidden(games, []), games);
});
