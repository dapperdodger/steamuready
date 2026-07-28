require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { redis } = require('../services/cache');
const { pool } = require('../services/db');
const { createUser, hashPassword, deleteUser, setEmailVerified, setAlertsEnabled } = require('../services/auth');
const store = require('../services/store');
const email = require('../services/email');
const { getTargetLocalHour } = require('../services/alertTiming');
const {
  claimRegionForToday, releaseRegionClaim, checkRegion, runTick, getEligibleUsersByRegion,
} = require('../services/priceAlerts');

async function makeEligibleUser(tag, region = 'us') {
  const testEmail = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const user = await createUser(testEmail, await hashPassword('password123'));
  await pool.query(
    `UPDATE users SET email_verified = TRUE, alerts_enabled = TRUE, alert_mode = 'sale_period', preferences = $1 WHERE id = $2`,
    [JSON.stringify({ region }), user.id]
  );
  return { id: user.id, email: testEmail, alert_mode: 'sale_period' };
}

test('getEligibleUsersByRegion returns only the user with alerts_enabled=TRUE AND email_verified=TRUE (the consent gate)', async () => {
  const region = `test-consent-${Date.now()}`;
  const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const bothTrue = await createUser(`consent-both-${tag}@example.com`, await hashPassword('password123'));
  const enabledOnly = await createUser(`consent-enabled-${tag}@example.com`, await hashPassword('password123'));
  const verifiedOnly = await createUser(`consent-verified-${tag}@example.com`, await hashPassword('password123'));
  const neither = await createUser(`consent-neither-${tag}@example.com`, await hashPassword('password123'));
  const users = [bothTrue, enabledOnly, verifiedOnly, neither];

  try {
    await pool.query('UPDATE users SET preferences = $1 WHERE id = ANY($2)', [
      JSON.stringify({ region }), users.map(u => u.id),
    ]);

    // createUser defaults: email_verified = FALSE, alerts_enabled = TRUE.
    await setEmailVerified(bothTrue.id, true); // alerts_enabled stays TRUE (default) -> eligible
    // enabledOnly: alerts_enabled TRUE (default), email_verified left FALSE (default) -> not eligible
    await setEmailVerified(verifiedOnly.id, true);
    await setAlertsEnabled(verifiedOnly.id, false); // email_verified TRUE, alerts_enabled FALSE -> not eligible
    await setAlertsEnabled(neither.id, false); // both FALSE -> not eligible

    const byRegion = await getEligibleUsersByRegion();
    const regionUserIds = (byRegion.get(region) || []).map(u => u.id);

    assert.ok(regionUserIds.includes(bothTrue.id), 'alerts_enabled=TRUE AND email_verified=TRUE user is included');
    assert.ok(!regionUserIds.includes(enabledOnly.id), 'alerts_enabled=TRUE but email_verified=FALSE user is excluded');
    assert.ok(!regionUserIds.includes(verifiedOnly.id), 'email_verified=TRUE but alerts_enabled=FALSE user is excluded');
    assert.ok(!regionUserIds.includes(neither.id), 'alerts_enabled=FALSE and email_verified=FALSE user is excluded');
  } finally {
    for (const u of users) await deleteUser(u.id);
  }
});

test('claimRegionForToday: first claim for a region+day succeeds, a second claim for the same region+day fails', async () => {
  const region = `test-region-${Date.now()}`;
  const at = new Date('2026-07-15T19:00:00Z');

  const first = await claimRegionForToday(region, at);
  assert.strictEqual(first, true);

  const second = await claimRegionForToday(region, at);
  assert.strictEqual(second, false);

  // Cleanup: delete whatever key this created (region/date-scoped, safe to target by pattern).
  await redis.del(`alert-sent:${region}:2026-07-15`);
});

test('claimRegionForToday: different regions on the same day claim independently', async () => {
  const at = new Date('2026-07-15T19:00:00Z');
  const regionA = `test-region-a-${Date.now()}`;
  const regionB = `test-region-b-${Date.now()}`;

  assert.strictEqual(await claimRegionForToday(regionA, at), true);
  assert.strictEqual(await claimRegionForToday(regionB, at), true);

  await redis.del(`alert-sent:${regionA}:2026-07-15`, `alert-sent:${regionB}:2026-07-15`);
});

test('checkRegion does not persist last_alerted_price/last_alerted_deal_since when the digest send fails', async () => {
  const user = await makeEligibleUser('checkregion-fail');
  const itadId = `itad-checkregion-fail-${Date.now()}`;
  await pool.query('INSERT INTO wishlist_items (user_id, itad_id) VALUES ($1, $2)', [user.id, itadId]);

  const deal = {
    name: 'Test Game', price: 9.99, discountPercent: 50,
    storeUrl: 'http://example.com/game', dealSince: '2026-07-01T00:00:00.000Z',
  };
  const originalGetDeals = store.getDealsForItadIds;
  const originalSendDigest = email.sendPriceAlertDigest;
  store.getDealsForItadIds = async () => new Map([[itadId, deal]]);
  email.sendPriceAlertDigest = async () => { throw new Error('simulated SES failure'); };

  try {
    await checkRegion('us', [user]);

    const { rows } = await pool.query(
      'SELECT last_alerted_price, last_alerted_deal_since FROM wishlist_items WHERE user_id = $1 AND itad_id = $2',
      [user.id, itadId]
    );
    assert.strictEqual(rows[0].last_alerted_price, null);
    assert.strictEqual(rows[0].last_alerted_deal_since, null);
  } finally {
    store.getDealsForItadIds = originalGetDeals;
    email.sendPriceAlertDigest = originalSendDigest;
    await pool.query('DELETE FROM wishlist_items WHERE user_id = $1', [user.id]);
    await deleteUser(user.id);
  }
});

test('checkRegion persists last_alerted_price/last_alerted_deal_since only after a successful digest send', async () => {
  const user = await makeEligibleUser('checkregion-ok');
  const itadId = `itad-checkregion-ok-${Date.now()}`;
  await pool.query('INSERT INTO wishlist_items (user_id, itad_id) VALUES ($1, $2)', [user.id, itadId]);

  const deal = {
    name: 'Test Game', price: 9.99, discountPercent: 50,
    storeUrl: 'http://example.com/game', dealSince: '2026-07-01T00:00:00.000Z',
  };
  const originalGetDeals = store.getDealsForItadIds;
  const originalSendDigest = email.sendPriceAlertDigest;
  store.getDealsForItadIds = async () => new Map([[itadId, deal]]);
  email.sendPriceAlertDigest = async () => {};

  try {
    await checkRegion('us', [user]);

    const { rows } = await pool.query(
      'SELECT last_alerted_price, last_alerted_deal_since FROM wishlist_items WHERE user_id = $1 AND itad_id = $2',
      [user.id, itadId]
    );
    assert.strictEqual(Number(rows[0].last_alerted_price), 9.99);
    assert.strictEqual(new Date(rows[0].last_alerted_deal_since).getTime(), new Date(deal.dealSince).getTime());
  } finally {
    store.getDealsForItadIds = originalGetDeals;
    email.sendPriceAlertDigest = originalSendDigest;
    await pool.query('DELETE FROM wishlist_items WHERE user_id = $1', [user.id]);
    await deleteUser(user.id);
  }
});

test('runTick isolates a failing region (releasing its claim) without aborting other eligible regions', async () => {
  const regionOk = `test-runtick-ok-${Date.now()}`;
  const regionFail = `test-runtick-fail-${Date.now()}`;

  // Neither region is in REGION_TIMEZONES, so both fall back to the same
  // Etc/UTC timezone for shouldSendNow — pick `at` so both are "on time" together.
  const day = new Date('2026-07-15T12:00:00Z');
  const targetHour = getTargetLocalHour(regionOk, day);
  const at = new Date(day);
  at.setUTCHours(targetHour, 0, 0, 0);
  const dateStr = '2026-07-15';

  const userOk = await makeEligibleUser('runtick-ok', regionOk); // no wishlist items -> checkRegion succeeds trivially
  const userFail = await makeEligibleUser('runtick-fail', regionFail);
  const itadId = `itad-runtick-fail-${Date.now()}`;
  await pool.query('INSERT INTO wishlist_items (user_id, itad_id) VALUES ($1, $2)', [userFail.id, itadId]);

  const originalGetDeals = store.getDealsForItadIds;
  store.getDealsForItadIds = async () => { throw new Error('simulated store failure'); };

  try {
    await assert.doesNotReject(runTick(at));

    // regionOk's checkRegion succeeded (no wishlist rows to fetch deals for) -> claim still held.
    assert.strictEqual(await claimRegionForToday(regionOk, at), false);
    // regionFail's checkRegion threw -> claim was released so a later tick today can retry.
    assert.strictEqual(await claimRegionForToday(regionFail, at), true);
  } finally {
    store.getDealsForItadIds = originalGetDeals;
    await redis.del(`alert-sent:${regionOk}:${dateStr}`, `alert-sent:${regionFail}:${dateStr}`);
    await pool.query('DELETE FROM wishlist_items WHERE user_id = $1', [userFail.id]);
    await deleteUser(userOk.id);
    await deleteUser(userFail.id);
  }
});

test('releaseRegionClaim allows a region to be re-claimed on the same day after release', async () => {
  const region = `test-release-${Date.now()}`;
  const at = new Date('2026-07-15T19:00:00Z');

  assert.strictEqual(await claimRegionForToday(region, at), true);
  assert.strictEqual(await claimRegionForToday(region, at), false); // still held

  await releaseRegionClaim(region, at);
  assert.strictEqual(await claimRegionForToday(region, at), true); // re-claimable after release

  await redis.del(`alert-sent:${region}:2026-07-15`);
});
