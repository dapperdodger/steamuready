const crypto = require('crypto');
const { pool } = require('./db');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createToken(userId, purpose, ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMs);
  await pool.query(
    'INSERT INTO email_tokens (token, user_id, purpose, expires_at) VALUES ($1, $2, $3, $4)',
    [hashToken(token), userId, purpose, expiresAt]
  );
  return token;
}

// Atomically validates (purpose + not expired) and consumes (deletes) in one
// statement, avoiding a check-then-delete race between concurrent requests.
async function consumeToken(token, purpose) {
  const { rows } = await pool.query(
    'DELETE FROM email_tokens WHERE token = $1 AND purpose = $2 AND expires_at > NOW() RETURNING user_id',
    [hashToken(token), purpose]
  );
  return rows[0]?.user_id ?? null;
}

// Equalize response timing in /forgot-password regardless of whether a user exists.
// Mimics createToken's cost profile without side effects: generates a random token,
// hashes it (same CPU cost as createToken), then does an indexed lookup against
// email_tokens using that hash (matching the index-access pattern of INSERT's
// unique-index maintenance). Since the hash is freshly random, this always returns
// zero rows — that's expected; we're approximating the query execution cost, not
// the result. Must be a pure read: no rows inserted/left behind.
async function simulateTokenLookupCost() {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = hashToken(token);
  await pool.query('SELECT 1 FROM email_tokens WHERE token = $1', [hash]);
}

module.exports = { hashToken, createToken, consumeToken, simulateTokenLookupCost };
