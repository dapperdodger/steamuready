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
    'SELECT id, email, preferences, hide_owned_default, created_at FROM users WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

async function updatePasswordHash(id, passwordHash) {
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
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

module.exports = {
  hashPassword, verifyPassword,
  createUser, findUserByEmail, findUserById,
  updatePasswordHash, updatePreferences, updateHideOwnedDefault, deleteUser,
};
