require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { pool, init } = require('../services/db');

test('init() creates users, wishlist_items, owned_games, hidden_games with expected columns', async () => {
  await init();

  const { rows } = await pool.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_name IN ('users', 'wishlist_items', 'owned_games', 'hidden_games')
    ORDER BY table_name, ordinal_position
  `);

  const byTable = {};
  for (const r of rows) {
    (byTable[r.table_name] ??= []).push(r.column_name);
  }

  assert.deepStrictEqual(byTable.users, ['id', 'email', 'password_hash', 'preferences', 'hide_owned_default', 'created_at', 'email_verified', 'alerts_enabled', 'alert_mode']);
  assert.deepStrictEqual(byTable.wishlist_items, ['user_id', 'itad_id', 'added_at', 'last_alerted_price', 'last_alerted_deal_since']);
  assert.deepStrictEqual(byTable.owned_games, ['user_id', 'itad_id', 'source', 'added_at']);
  assert.deepStrictEqual(byTable.hidden_games, ['user_id', 'itad_id', 'added_at']);
});
