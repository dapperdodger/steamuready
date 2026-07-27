const { redis } = require('./cache');
const { pool } = require('./db');
const store = require('./store');
const email = require('./email');
const { shouldAlert } = require('./alertMode');
const { shouldSendNow, REGION_TIMEZONES } = require('./alertTiming');
const { buildUnsubscribeUrl } = require('./unsubscribeTokens');

const SENT_KEY_TTL_SECONDS = 90000; // ~25h — comfortably covers a full day even with clock drift

function regionDateStr(region, at) {
  const timeZone = REGION_TIMEZONES[region] || 'Etc/UTC';
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at); // en-CA formats as YYYY-MM-DD
}

// Atomically claims "region's daily digest for today" — whichever of the
// app's ECS tasks calls this first for a given (region, day) wins and does
// the real work; the other task's tick finds the key already set and skips.
async function claimRegionForToday(region, at = new Date()) {
  const key = `alert-sent:${region}:${regionDateStr(region, at)}`;
  const res = await redis.set(key, '1', 'EX', SENT_KEY_TTL_SECONDS, 'NX');
  return res === 'OK';
}

async function getEligibleUsersByRegion() {
  const { rows } = await pool.query(`
    SELECT id, email, COALESCE(preferences->>'region', 'us') AS region, alert_mode
    FROM users WHERE alerts_enabled = TRUE AND email_verified = TRUE
  `);
  const byRegion = new Map();
  for (const row of rows) {
    if (!byRegion.has(row.region)) byRegion.set(row.region, []);
    byRegion.get(row.region).push(row);
  }
  return byRegion;
}

async function checkRegion(region, users) {
  const { rows: wishlistRows } = await pool.query(
    'SELECT user_id, itad_id, last_alerted_price, last_alerted_deal_since FROM wishlist_items WHERE user_id = ANY($1)',
    [users.map(u => u.id)]
  );
  if (!wishlistRows.length) return;

  const itadIds = [...new Set(wishlistRows.map(r => r.itad_id))];
  const dealMap = await store.getDealsForItadIds(itadIds, region, []);

  const alertModeByUser = new Map(users.map(u => [u.id, u.alert_mode]));
  const emailByUser = new Map(users.map(u => [u.id, u.email]));
  const digestsByUser = new Map();

  for (const row of wishlistRows) {
    const deal = dealMap.get(row.itad_id);
    if (!deal) continue;
    if (!shouldAlert(alertModeByUser.get(row.user_id), deal, row)) continue;

    if (!digestsByUser.has(row.user_id)) digestsByUser.set(row.user_id, []);
    digestsByUser.get(row.user_id).push({
      gameName: deal.name, price: deal.price, discountPercent: deal.discountPercent, storeUrl: deal.storeUrl,
    });

    await pool.query(
      'UPDATE wishlist_items SET last_alerted_price = $1, last_alerted_deal_since = $2 WHERE user_id = $3 AND itad_id = $4',
      [deal.price, deal.dealSince, row.user_id, row.itad_id]
    );
  }

  for (const [userId, items] of digestsByUser) {
    const unsubscribeUrl = buildUnsubscribeUrl(process.env.APP_BASE_URL, userId);
    await email.sendPriceAlertDigest(emailByUser.get(userId), items, unsubscribeUrl).catch(e =>
      console.error(`[priceAlerts] digest send failed for user ${userId}:`, e.message)
    );
  }
}

async function runTick(at = new Date()) {
  const byRegion = await getEligibleUsersByRegion();
  for (const [region, users] of byRegion) {
    if (!shouldSendNow(region, at)) continue;
    if (!(await claimRegionForToday(region, at))) continue; // another task already handled this region today
    await checkRegion(region, users);
  }
}

module.exports = { claimRegionForToday, getEligibleUsersByRegion, checkRegion, runTick };
