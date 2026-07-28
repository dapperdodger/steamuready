const { pool } = require('./db');
const steamApi = require('./steamApi');
const store = require('./store');

// The exact-correlation plan already implements and manually-verifies this
// exact ITAD /lookup/id/shop/61/v1 call in services/store.js — reused here
// under the name this file's callers expect, rather than duplicated.
const resolveAppIdsToItadIds = store.resolveSteamAppIdsToItadIds;

async function resyncOwnedFromSteam(userId, itadIds) {
  const idSet = new Set(itadIds);
  const { rows } = await pool.query(
    "SELECT itad_id FROM owned_games WHERE user_id = $1 AND source = 'steam'",
    [userId]
  );
  const stale = rows.map(r => r.itad_id).filter(id => !idSet.has(id));
  if (stale.length) {
    await pool.query(
      "DELETE FROM owned_games WHERE user_id = $1 AND source = 'steam' AND itad_id = ANY($2)",
      [userId, stale]
    );
  }
  for (const itadId of itadIds) {
    await pool.query(
      `INSERT INTO owned_games (user_id, itad_id, source) VALUES ($1, $2, 'steam')
       ON CONFLICT (user_id, itad_id) DO NOTHING`,
      [userId, itadId]
    );
    // Owning it always clears any wishlist entry, regardless of source (accounts plan's rule).
    await pool.query('DELETE FROM wishlist_items WHERE user_id = $1 AND itad_id = $2', [userId, itadId]);
  }
}

async function resyncWishlistFromSteam(userId, itadIds, ownedItadIds) {
  const ownedSet = new Set(ownedItadIds);
  const idSet = new Set(itadIds.filter(id => !ownedSet.has(id)));
  const { rows } = await pool.query(
    "SELECT itad_id FROM wishlist_items WHERE user_id = $1 AND source = 'steam'",
    [userId]
  );
  const stale = rows.map(r => r.itad_id).filter(id => !idSet.has(id));
  if (stale.length) {
    await pool.query(
      "DELETE FROM wishlist_items WHERE user_id = $1 AND source = 'steam' AND itad_id = ANY($2)",
      [userId, stale]
    );
  }
  for (const itadId of idSet) {
    await pool.query(
      `INSERT INTO wishlist_items (user_id, itad_id, source) VALUES ($1, $2, 'steam')
       ON CONFLICT (user_id, itad_id) DO NOTHING`,
      [userId, itadId]
    );
  }
}

async function runImport(userId, steamId) {
  const [ownedAppIds, wishlistAppIds] = await Promise.all([
    steamApi.getOwnedGameAppIds(steamId),
    steamApi.getWishlistAppIds(steamId),
  ]);
  const allAppIds = [...new Set([...ownedAppIds, ...wishlistAppIds])];
  const itadMap = await resolveAppIdsToItadIds(allAppIds);

  const ownedItadIds = [...new Set(ownedAppIds.map(id => itadMap.get(id)).filter(Boolean))];
  const wishlistItadIds = [...new Set(wishlistAppIds.map(id => itadMap.get(id)).filter(Boolean))];

  await resyncOwnedFromSteam(userId, ownedItadIds);
  await resyncWishlistFromSteam(userId, wishlistItadIds, ownedItadIds);

  const { rows: ownedRows } = await pool.query('SELECT COUNT(*) FROM owned_games WHERE user_id = $1', [userId]);
  const { rows: wishlistRows } = await pool.query('SELECT COUNT(*) FROM wishlist_items WHERE user_id = $1', [userId]);
  return { ownedCount: Number(ownedRows[0].count), wishlistCount: Number(wishlistRows[0].count) };
}

module.exports = { resolveAppIdsToItadIds, resyncOwnedFromSteam, resyncWishlistFromSteam, runImport };
