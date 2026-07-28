require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { parseOwnedGamesResponse, parseWishlistResponse } = require('../services/steamApi');

test('parseOwnedGamesResponse extracts appids as strings', () => {
  const data = { response: { game_count: 2, games: [{ appid: 730 }, { appid: 220 }] } };
  assert.deepStrictEqual(parseOwnedGamesResponse(data), ['730', '220']);
});

test('parseOwnedGamesResponse returns an empty array when the profile has no public game details', () => {
  assert.deepStrictEqual(parseOwnedGamesResponse({ response: {} }), []);
});

test('parseWishlistResponse extracts appids as strings', () => {
  const data = { response: { items: [{ appid: 620, priority: 1, date_added: 123 }] } };
  assert.deepStrictEqual(parseWishlistResponse(data), ['620']);
});

test('parseWishlistResponse returns an empty array when the wishlist is empty or private', () => {
  assert.deepStrictEqual(parseWishlistResponse({ response: {} }), []);
});
