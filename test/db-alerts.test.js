require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { pool, init } = require('../services/db');

test('init() creates email_tokens with expected columns', async () => {
  await init();

  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'email_tokens' ORDER BY ordinal_position
  `);
  assert.deepStrictEqual(rows.map(r => r.column_name), ['token', 'user_id', 'purpose', 'expires_at', 'created_at']);
});

test('alert_mode rejects values outside the enum', async () => {
  await init();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert a test user
    const { rows: [user] } = await client.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      ['test@example.com', 'hash']
    );

    // Try to update with invalid alert_mode
    await assert.rejects(
      () => client.query("UPDATE users SET alert_mode = $1 WHERE id = $2", ['not_a_real_mode', user.id]),
      /violates check constraint|users_alert_mode_check/
    );

    // Rollback to clean up
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});
