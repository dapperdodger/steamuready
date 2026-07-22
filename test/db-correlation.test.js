require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { pool, init } = require('../services/db');

test('init() adds game_titles.resolved_via, nullable, checked against steam/title', async () => {
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

  await assert.rejects(
    () => pool.query("UPDATE game_titles SET resolved_via = 'bogus' WHERE title_lower = $1", [testKey]),
    /violates check constraint|game_titles_resolved_via_check/
  );

  // Clean up
  await pool.query("DELETE FROM game_titles WHERE title_lower = $1", [testKey]);
});
