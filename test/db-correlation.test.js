require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { pool, init, tryWithAdvisoryLock } = require('../services/db');

test.after(() => pool.end());

test('init() adds game_titles.resolved_via, nullable, checked against steam/title', async (t) => {
  await init();

  const { rows } = await pool.query(`
    SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_name = 'game_titles' AND column_name = 'resolved_via'
  `);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].is_nullable, 'YES');

  // Insert a test row to trigger constraint validation
  const testKey = 'constraint_test_' + Date.now();
  await pool.query(`INSERT INTO game_titles (title_lower) VALUES ($1)`, [testKey]);
  t.after(() => pool.query('DELETE FROM game_titles WHERE title_lower = $1', [testKey]));

  await assert.rejects(
    () => pool.query("UPDATE game_titles SET resolved_via = $1 WHERE title_lower = $2", ['bogus', testKey]),
    /violates check constraint|game_titles_resolved_via_check/
  );
});

test('tryWithAdvisoryLock: a second concurrent attempt under the same lock id is skipped', async () => {
  const lockId = 999999001; // dedicated to this test, distinct from server.js's WARM_CACHE_LOCK_ID
  let firstStarted = false;
  let firstFinished = false;
  let secondRan = false;
  let skipCalled = false;

  const first = tryWithAdvisoryLock(lockId, async () => {
    firstStarted = true;
    await new Promise(r => setTimeout(r, 300));
    firstFinished = true;
  });

  while (!firstStarted) await new Promise(r => setTimeout(r, 10));

  const second = tryWithAdvisoryLock(lockId, async () => {
    secondRan = true;
  }, () => { skipCalled = true; });

  await second;
  assert.strictEqual(secondRan, false, 'second call should have been skipped while the first held the lock');
  assert.strictEqual(skipCalled, true, 'onSkip callback should fire when the lock is already held');
  assert.strictEqual(firstFinished, false, 'first call should still be in progress when second is skipped');

  await first;
  assert.strictEqual(firstFinished, true);
});

test('tryWithAdvisoryLock: a later attempt succeeds once the lock has been released', async () => {
  const lockId = 999999002;
  let ran = false;
  await tryWithAdvisoryLock(lockId, async () => { ran = true; });
  assert.strictEqual(ran, true);

  let ranAgain = false;
  await tryWithAdvisoryLock(lockId, async () => { ranAgain = true; });
  assert.strictEqual(ranAgain, true, 'lock should have been released after the first call completed');
});
