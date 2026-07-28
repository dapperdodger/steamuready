const bcrypt = require('bcrypt');
const { pool } = require('./db');

const BCRYPT_COST = 12;

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

async function createUser(email, passwordHash) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     RETURNING id, email, preferences, hide_owned_default, created_at`,
    [email, passwordHash]
  );
  return rows[0];
}

async function findUserByEmail(email) {
  const { rows } = await pool.query(
    'SELECT id, email, password_hash, preferences, hide_owned_default, created_at FROM users WHERE email = $1',
    [email]
  );
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await pool.query(
    'SELECT id, email, preferences, hide_owned_default, created_at, email_verified, alerts_enabled, alert_mode FROM users WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

async function updatePasswordHash(id, passwordHash) {
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
}

// Narrow, purpose-built lookup — findUserById deliberately excludes
// password_hash (it backs GET /api/auth/me, which must never leak it).
// Changing a password needs the hash without a second round-trip through
// email, so this exists instead of loosening findUserById.
async function findPasswordHashById(id) {
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [id]);
  return rows[0]?.password_hash ?? null;
}

async function updatePreferences(id, preferences) {
  const { rows } = await pool.query(
    'UPDATE users SET preferences = $1 WHERE id = $2 RETURNING preferences',
    [JSON.stringify(preferences), id]
  );
  return rows[0]?.preferences;
}

async function updateHideOwnedDefault(id, value) {
  const { rows } = await pool.query(
    'UPDATE users SET hide_owned_default = $1 WHERE id = $2 RETURNING hide_owned_default',
    [value, id]
  );
  return rows[0]?.hide_owned_default;
}

async function deleteUser(id) {
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
}

async function setEmailVerified(id, verified) {
  await pool.query('UPDATE users SET email_verified = $1 WHERE id = $2', [verified, id]);
}

async function setAlertsEnabled(id, enabled) {
  await pool.query('UPDATE users SET alerts_enabled = $1 WHERE id = $2', [enabled, id]);
}

async function updateAlertSettings(id, alertsEnabled, alertMode) {
  await pool.query(
    'UPDATE users SET alerts_enabled = $1, alert_mode = $2 WHERE id = $3',
    [alertsEnabled, alertMode, id]
  );
}

async function findUserBySteamId(steamId) {
  const { rows } = await pool.query('SELECT id FROM users WHERE steam_id = $1', [steamId]);
  return rows[0] || null;
}

async function linkSteamAccount(userId, steamId, personaName) {
  await pool.query(
    'UPDATE users SET steam_id = $1, steam_persona_name = $2 WHERE id = $3',
    [steamId, personaName, userId]
  );
}

async function unlinkSteamAccount(userId) {
  await pool.query('UPDATE users SET steam_id = NULL, steam_persona_name = NULL WHERE id = $1', [userId]);
}

async function getSteamLinkStatus(userId) {
  const { rows } = await pool.query('SELECT steam_id, steam_persona_name FROM users WHERE id = $1', [userId]);
  return { steamId: rows[0]?.steam_id ?? null, personaName: rows[0]?.steam_persona_name ?? null };
}

module.exports = {
  hashPassword, verifyPassword,
  createUser, findUserByEmail, findUserById,
  updatePasswordHash, findPasswordHashById, updatePreferences, updateHideOwnedDefault, deleteUser, setEmailVerified, setAlertsEnabled, updateAlertSettings,
  findUserBySteamId, linkSteamAccount, unlinkSteamAccount, getSteamLinkStatus,
};
