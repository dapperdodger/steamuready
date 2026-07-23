const { pool } = require('./db');

async function addWishlistItem(userId, itadId) {
  await pool.query(
    `INSERT INTO wishlist_items (user_id, itad_id) VALUES ($1, $2)
     ON CONFLICT (user_id, itad_id) DO NOTHING`,
    [userId, itadId]
  );
}

async function removeWishlistItem(userId, itadId) {
  await pool.query('DELETE FROM wishlist_items WHERE user_id = $1 AND itad_id = $2', [userId, itadId]);
}

async function listWishlistItadIds(userId) {
  const { rows } = await pool.query(
    'SELECT itad_id FROM wishlist_items WHERE user_id = $1 ORDER BY added_at DESC',
    [userId]
  );
  return rows.map(r => r.itad_id);
}

// Owning a game always implies it shouldn't stay on the wishlist or stay
// hidden, regardless of how it got there (manually added/hidden, or
// previously imported from Steam).
async function addOwned(userId, itadId, source = 'manual') {
  await pool.query(
    `INSERT INTO owned_games (user_id, itad_id, source) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, itad_id) DO NOTHING`,
    [userId, itadId, source]
  );
  await removeWishlistItem(userId, itadId);
  await removeHidden(userId, itadId);
}

async function removeOwned(userId, itadId) {
  await pool.query('DELETE FROM owned_games WHERE user_id = $1 AND itad_id = $2', [userId, itadId]);
}

async function listOwnedItadIds(userId) {
  const { rows } = await pool.query(
    'SELECT itad_id FROM owned_games WHERE user_id = $1 ORDER BY added_at DESC',
    [userId]
  );
  return rows.map(r => r.itad_id);
}

// Hiding a game always implies it shouldn't stay on the wishlist — "don't
// show me this" is incompatible with "I want this."
async function addHidden(userId, itadId) {
  await pool.query(
    `INSERT INTO hidden_games (user_id, itad_id) VALUES ($1, $2)
     ON CONFLICT (user_id, itad_id) DO NOTHING`,
    [userId, itadId]
  );
  await removeWishlistItem(userId, itadId);
}

async function removeHidden(userId, itadId) {
  await pool.query('DELETE FROM hidden_games WHERE user_id = $1 AND itad_id = $2', [userId, itadId]);
}

async function listHiddenItadIds(userId) {
  const { rows } = await pool.query(
    'SELECT itad_id FROM hidden_games WHERE user_id = $1 ORDER BY added_at DESC',
    [userId]
  );
  return rows.map(r => r.itad_id);
}

// Lightweight — title only, no price/image lookup. Backs the "Manage hidden
// games" list (Task 16), which is a maintenance screen, not a card grid.
async function listHiddenWithTitles(userId) {
  const { rows } = await pool.query(
    `SELECT hg.itad_id, gt.match_title AS name
     FROM hidden_games hg
     LEFT JOIN game_titles gt ON gt.itad_id = hg.itad_id
     WHERE hg.user_id = $1
     ORDER BY hg.added_at DESC`,
    [userId]
  );
  return rows.map(r => ({ itadId: r.itad_id, name: r.name || '' }));
}

module.exports = {
  addWishlistItem, removeWishlistItem, listWishlistItadIds,
  addOwned, removeOwned, listOwnedItadIds,
  addHidden, removeHidden, listHiddenItadIds, listHiddenWithTitles,
};
