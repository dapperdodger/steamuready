const { pool } = require('./db');
const steamApi = require('./steamApi');
const store = require('./store');
const { addOwned, listOwnedItadIds } = require('./wishlist');

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
    // addOwned handles insert (ON CONFLICT DO NOTHING) and clears both the
    // wishlist and hidden_games entries for this game (accounts plan's rule).
    await addOwned(userId, itadId, 'steam');
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
  // Use the full owned set (all sources), not just Steam's, so a game owned
  // via another source never gets re-added to the wishlist by this resync.
  const allOwnedItadIds = await listOwnedItadIds(userId);
  await resyncWishlistFromSteam(userId, wishlistItadIds, allOwnedItadIds);

  const { rows: ownedRows } = await pool.query('SELECT COUNT(*) FROM owned_games WHERE user_id = $1', [userId]);
  const { rows: wishlistRows } = await pool.query('SELECT COUNT(*) FROM wishlist_items WHERE user_id = $1', [userId]);
  return { ownedCount: Number(ownedRows[0].count), wishlistCount: Number(wishlistRows[0].count) };
}

module.exports = { resolveAppIdsToItadIds, resyncOwnedFromSteam, resyncWishlistFromSteam, runImport };
