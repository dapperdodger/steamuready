require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { shouldAlert } = require('../services/alertMode');

const dealAt = (price, discountPercent, dealSince, historicalLow = null) => ({ price, discountPercent, dealSince, historicalLow });

test('a game with no active discount never alerts, regardless of mode', () => {
  const deal = dealAt(19.99, 0, '2026-01-01T00:00:00Z');
  for (const mode of ['price_drop', 'sale_period', 'historical_low']) {
    assert.strictEqual(shouldAlert(mode, deal, {}), false);
  }
});

test('price_drop alerts on first discount seen, then only on a deeper price, never on an unchanged price', () => {
  const wishlistItem = { last_alerted_price: null };
  assert.strictEqual(shouldAlert('price_drop', dealAt(9.99, 50, 'x'), wishlistItem), true);

  wishlistItem.last_alerted_price = 9.99;
  assert.strictEqual(shouldAlert('price_drop', dealAt(9.99, 50, 'x'), wishlistItem), false); // unchanged
  assert.strictEqual(shouldAlert('price_drop', dealAt(4.99, 75, 'x'), wishlistItem), true);  // deeper
  assert.strictEqual(shouldAlert('price_drop', dealAt(14.99, 25, 'x'), wishlistItem), false); // higher than last alert
});

test('sale_period alerts once per distinct dealSince, not on every check within the same sale', () => {
  const wishlistItem = { last_alerted_deal_since: null };
  assert.strictEqual(shouldAlert('sale_period', dealAt(9.99, 50, '2026-07-01T00:00:00Z'), wishlistItem), true);

  wishlistItem.last_alerted_deal_since = '2026-07-01T00:00:00Z';
  assert.strictEqual(shouldAlert('sale_period', dealAt(9.99, 50, '2026-07-01T00:00:00Z'), wishlistItem), false); // same sale window
  assert.strictEqual(shouldAlert('sale_period', dealAt(7.99, 60, '2026-07-15T00:00:00Z'), wishlistItem), true);  // new sale window
});

// pg returns TIMESTAMPTZ columns as JS Date objects, not strings — last_alerted_deal_since
// arrives this way from every real DB read. dealSince from the ITAD API is always a string,
// and may use a non-UTC offset (e.g. "+02:00") even when it names the same instant as a UTC
// Date. Regression test for a bug where comparing these directly with !== always mismatched,
// re-sending the "new sale" email every tick even though nothing about the deal had changed.
test('sale_period does not re-alert when last_alerted_deal_since comes back from the DB as a Date object', () => {
  const wishlistItem = { last_alerted_deal_since: new Date('2026-07-01T17:00:00.000Z') };
  const sameInstantDifferentOffset = dealAt(9.99, 50, '2026-07-01T19:00:00+02:00');
  assert.strictEqual(shouldAlert('sale_period', sameInstantDifferentOffset, wishlistItem), false);

  const newDeal = dealAt(7.99, 60, '2026-07-15T00:00:00Z');
  assert.strictEqual(shouldAlert('sale_period', newDeal, wishlistItem), true);
});

test('historical_low only alerts at or below the all-time low, and not repeatedly for the same low price', () => {
  const wishlistItem = { last_alerted_price: null };
  const notLow = dealAt(9.99, 50, 'x', { price: 4.99 });
  assert.strictEqual(shouldAlert('historical_low', notLow, wishlistItem), false);

  const atLow = dealAt(4.99, 75, 'x', { price: 4.99 });
  assert.strictEqual(shouldAlert('historical_low', atLow, wishlistItem), true);

  wishlistItem.last_alerted_price = 4.99;
  assert.strictEqual(shouldAlert('historical_low', atLow, wishlistItem), false); // same low again

  const newLow = dealAt(3.99, 80, 'x', { price: 3.99 });
  assert.strictEqual(shouldAlert('historical_low', newLow, wishlistItem), true); // even lower
});
