function shouldAlertPriceDrop(current, lastAlertedPrice) {
  return lastAlertedPrice == null || current.price < lastAlertedPrice;
}

function shouldAlertSalePeriod(current, lastAlertedDealSince) {
  if (lastAlertedDealSince == null) return true;
  // Compare by instant, not by raw value: current.dealSince is always a string from the ITAD
  // API (possibly with a non-UTC offset), while lastAlertedDealSince round-trips through a
  // Postgres TIMESTAMPTZ column and comes back as a Date object. Neither type nor formatting
  // is guaranteed to match even when the two name the same moment.
  return new Date(current.dealSince).getTime() !== new Date(lastAlertedDealSince).getTime();
}

function shouldAlertHistoricalLow(current, lastAlertedPrice) {
  if (!current.historicalLow) return false;
  if (current.price > current.historicalLow.price) return false;
  return lastAlertedPrice == null || current.price < lastAlertedPrice;
}

function shouldAlert(alertMode, current, wishlistItem) {
  if (!current.discountPercent || current.discountPercent <= 0) return false;
  switch (alertMode) {
    case 'price_drop':
      return shouldAlertPriceDrop(current, wishlistItem.last_alerted_price);
    case 'historical_low':
      return shouldAlertHistoricalLow(current, wishlistItem.last_alerted_price);
    case 'sale_period':
    default:
      return shouldAlertSalePeriod(current, wishlistItem.last_alerted_deal_since);
  }
}

module.exports = { shouldAlert, shouldAlertPriceDrop, shouldAlertSalePeriod, shouldAlertHistoricalLow };
