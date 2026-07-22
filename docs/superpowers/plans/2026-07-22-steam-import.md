# Steam Account Linking & Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in SteamUReady user link their Steam account (via OpenID) and import their Steam-owned games and wishlist into the existing `owned_games`/`wishlist_items` tables, keeping later imports in sync via a full resync of Steam-sourced rows.

**Architecture:** A new `services/steamAuth.js` wraps the raw `openid` npm package for the OpenID handshake (link only, not login — the user must already have an active email/password session). `services/steamApi.js` wraps Steam's official Web API (`GetOwnedGames`, `GetWishlist`, `GetPlayerSummaries`). `services/steamImport.js` resolves Steam appids to `itad_id`s via ITAD's `/lookup/id/shop/61/v1` and runs the resync/cross-removal logic against Postgres. `routes/steam.js` ties it together behind `requireAuth`. This plan depends on the accounts plan (`docs/superpowers/plans/2026-07-22-accounts-wishlist-owned.md`) already being implemented — it reuses `users`, `owned_games`, `wishlist_items`, `middleware/session.js`, and `services/wishlist.js`.

**Tech Stack:** `openid` (npm), `axios` (already a dependency), PostgreSQL, `node:test`.

## Global Constraints

- Steam only — GOG and Epic are explicitly out of scope for this plan.
- Steam linking is attach-to-existing-session, never a login mechanism — every route in this plan is `requireAuth`.
- `steam_id` is `TEXT`, unique at the DB level — one Steam account links to at most one SteamUReady account.
- `STEAM_API_KEY` and ITAD calls are server-side only, never exposed to the client.
- Import is manual (`POST /api/steam/import`) — no background job in this plan.
- Re-import fully resyncs `source = 'steam'` rows (adds new, removes stale) without touching `source = 'manual'` rows.
- Marking a game owned — via Steam import or otherwise — always removes it from the wishlist (enforced in `services/wishlist.js`'s `addOwned`, from the accounts plan's Task 8 amendment; this plan's resync logic must apply the same rule, not duplicate a different one).
- Verified live against Steam's endpoints already (see the design spec) — `GetWishlist` needs no API key but we pass one anyway; `GetOwnedGames` and `GetWishlist` both silently return empty when the relevant privacy setting isn't Public.
- Environment is Windows/PowerShell — no bash-specific command syntax.
- Local dev requires Redis + Postgres running (`docker compose up -d`) before running any test in this plan.
- Automated tests cover pure/DB logic only (resync diffing, id extraction, response parsing) — live OpenID handshakes and live Steam/ITAD network calls are verified manually, consistent with this codebase's existing lack of HTTP-mocking infrastructure (`services/store.js`, `services/steamcontroller.js` have no automated tests for their network calls either).

---

## Task 1: DB schema + dependencies

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `services/db.js`
- Modify: `test/db.test.js`

**Interfaces:**
- Produces: `users.steam_id` (TEXT, UNIQUE, nullable), `users.steam_persona_name` (TEXT, nullable), `wishlist_items.source` (TEXT, default `'manual'`) — consumed by every later task in this plan.

- [ ] **Step 1: Add the `openid` dependency**

```
npm install openid@^2.0.6
```

- [ ] **Step 2: Add `STEAM_API_KEY` to `.env.example`**

Append to `.env.example`:

```
# Steam Web API key — free at https://steamcommunity.com/dev/apikey
# Used for GetOwnedGames, GetWishlist, and GetPlayerSummaries.
STEAM_API_KEY=
```

- [ ] **Step 3: Add the schema changes to `services/db.js`**

Add inside the template string in `init()`, after the `owned_games` table (and after the `igdb_ratings` table, wherever it currently ends) — these use `ADD COLUMN IF NOT EXISTS` (valid Postgres syntax) since, unlike `CREATE TABLE IF NOT EXISTS`, altering an already-existing table needs its own idempotency guard:

```sql

    ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_id TEXT UNIQUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_persona_name TEXT;
    ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';
```

- [ ] **Step 4: Extend the schema test**

In `test/db.test.js`, update the assertion for `users` and add one for `wishlist_items`:

```js
  assert.deepStrictEqual(byTable.users, ['id', 'email', 'password_hash', 'preferences', 'created_at', 'steam_id', 'steam_persona_name']);
  assert.deepStrictEqual(byTable.wishlist_items, ['user_id', 'itad_id', 'added_at', 'source']);
```

(Replace the previous `assert.deepStrictEqual(byTable.users, ...)` and `assert.deepStrictEqual(byTable.wishlist_items, ...)` lines with these — column order reflects `ordinal_position`, so new columns from `ADD COLUMN` land at the end.)

- [ ] **Step 5: Run the test**

```
npm test
```

Expected: `test/db.test.js` passes.

- [ ] **Step 6: Commit**

```
git add package.json package-lock.json .env.example services/db.js test/db.test.js
git commit -m "Add Steam linking columns and openid dependency"
```

---

## Task 2: Steam-link user helpers (`services/auth.js`)

**Files:**
- Modify: `services/auth.js`
- Modify: `test/auth.test.js`

**Interfaces:**
- Produces: `findUserBySteamId(steamId): Promise<{id}|null>`, `linkSteamAccount(userId, steamId, personaName): Promise<void>`, `unlinkSteamAccount(userId): Promise<void>`, `getSteamLinkStatus(userId): Promise<{steamId, personaName}>` — consumed by `routes/steam.js` in Task 6.

- [ ] **Step 1: Write the failing test**

Append to `test/auth.test.js`:

```js
const {
  findUserBySteamId, linkSteamAccount, unlinkSteamAccount, getSteamLinkStatus,
} = require('../services/auth');

test('linkSteamAccount / getSteamLinkStatus / findUserBySteamId / unlinkSteamAccount', async () => {
  const email = `steam-link-${Date.now()}@example.com`;
  const user = await createUser(email, await hashPassword('password123'));

  const before = await getSteamLinkStatus(user.id);
  assert.deepStrictEqual(before, { steamId: null, personaName: null });

  const steamId = `7656119${Date.now()}`.slice(0, 17);
  await linkSteamAccount(user.id, steamId, 'CoolGamer42');

  const after = await getSteamLinkStatus(user.id);
  assert.deepStrictEqual(after, { steamId, personaName: 'CoolGamer42' });

  const found = await findUserBySteamId(steamId);
  assert.strictEqual(found.id, user.id);

  await unlinkSteamAccount(user.id);
  const afterUnlink = await getSteamLinkStatus(user.id);
  assert.deepStrictEqual(afterUnlink, { steamId: null, personaName: null });
  assert.strictEqual(await findUserBySteamId(steamId), null);

  await deleteUser(user.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `findUserBySteamId is not a function`.

- [ ] **Step 3: Implement in `services/auth.js`**

Add before the final `module.exports`:

```js
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
```

Update `module.exports` in `services/auth.js` to include these four names.

- [ ] **Step 4: Run test to verify it passes**

```
npm test
```

Expected: passes.

- [ ] **Step 5: Commit**

```
git add services/auth.js test/auth.test.js
git commit -m "Add Steam-link user helpers"
```

---

## Task 3: OpenID handshake wrapper (`services/steamAuth.js`)

**Files:**
- Create: `services/steamAuth.js`
- Create: `test/steamAuth.test.js`

**Interfaces:**
- Produces: `getAuthUrl(returnUrl, realm): Promise<string>`, `verifyAssertion(req, returnUrl, realm): Promise<string|null>` (resolves to a verified steamid64, or `null` if the assertion wasn't authenticated), `extractSteamId(claimedIdentifier): string|null` (exported specifically for unit testing) — consumed by `routes/steam.js` in Task 6.

Verified against the actual `openid` package API and Steam's documented OpenID identifier (see the design spec's "Verified API details" — cross-checked against a real Steam-OpenID wrapper package's published source): `RelyingParty(returnUrl, realm, useStateless, strictMode, extensions)`, `rp.authenticate('https://steamcommunity.com/openid', false, callback)`, `rp.verifyAssertion(req, callback)`, and the SteamID is the trailing numeric segment of `result.claimedIdentifier` (`https://steamcommunity.com/openid/id/<steamid64>`).

- [ ] **Step 1: Write the failing test (pure `extractSteamId` logic only)**

Create `test/steamAuth.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { extractSteamId } = require('../services/steamAuth');

test('extractSteamId parses a valid Steam claimedIdentifier', () => {
  assert.strictEqual(
    extractSteamId('https://steamcommunity.com/openid/id/76561198000000000'),
    '76561198000000000'
  );
});

test('extractSteamId returns null for anything that is not a Steam claimedIdentifier', () => {
  assert.strictEqual(extractSteamId('https://example.com/not-steam'), null);
  assert.strictEqual(extractSteamId(''), null);
  assert.strictEqual(extractSteamId(undefined), null);
  assert.strictEqual(extractSteamId('https://steamcommunity.com/openid/id/not-a-number'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `Cannot find module '../services/steamAuth'`.

- [ ] **Step 3: Implement `services/steamAuth.js`**

```js
const openid = require('openid');

const STEAM_OPENID_IDENTIFIER = 'https://steamcommunity.com/openid';
const CLAIMED_ID_RE = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/;

function buildRelyingParty(returnUrl, realm) {
  // (returnUrl, realm, useStateless, strictMode, extensions)
  return new openid.RelyingParty(returnUrl, realm, true, true, []);
}

function extractSteamId(claimedIdentifier) {
  const match = CLAIMED_ID_RE.exec(claimedIdentifier || '');
  return match ? match[1] : null;
}

function getAuthUrl(returnUrl, realm) {
  return new Promise((resolve, reject) => {
    const rp = buildRelyingParty(returnUrl, realm);
    rp.authenticate(STEAM_OPENID_IDENTIFIER, false, (err, authUrl) => {
      if (err || !authUrl) return reject(err || new Error('Steam did not return an auth URL'));
      resolve(authUrl);
    });
  });
}

function verifyAssertion(req, returnUrl, realm) {
  return new Promise((resolve, reject) => {
    const rp = buildRelyingParty(returnUrl, realm);
    rp.verifyAssertion(req, (err, result) => {
      if (err) return reject(err);
      if (!result || !result.authenticated) return resolve(null);
      resolve(extractSteamId(result.claimedIdentifier));
    });
  });
}

module.exports = { getAuthUrl, verifyAssertion, extractSteamId };
```

- [ ] **Step 4: Run test to verify it passes**

```
npm test
```

Expected: `test/steamAuth.test.js` passes (2 tests).

- [ ] **Step 5: Commit**

```
git add services/steamAuth.js test/steamAuth.test.js
git commit -m "Add Steam OpenID handshake wrapper"
```

- [ ] **Step 6: Manual verification (deferred to Task 6)**

`getAuthUrl`/`verifyAssertion` need a real browser round-trip through Steam's login page — this is exercised once `routes/steam.js` exists (Task 6, Step 7).

---

## Task 4: Steam Web API wrapper (`services/steamApi.js`)

**Files:**
- Create: `services/steamApi.js`
- Create: `test/steamApi.test.js`

**Interfaces:**
- Produces: `getOwnedGameAppIds(steamId): Promise<string[]>`, `getWishlistAppIds(steamId): Promise<string[]>`, `getPersonaName(steamId): Promise<string|null>`, plus `parseOwnedGamesResponse(data)` and `parseWishlistResponse(data)` (exported for unit testing without a live call) — consumed by `services/steamImport.js` (Task 5) and `routes/steam.js` (Task 6).

Endpoint/shape details verified live against Steam's actual API (see the design spec) rather than assumed from documentation: `GetWishlist` needs no `key` (confirmed by contrasting its response against `GetPlayerSummaries`'s "key is missing" error for an unkeyed request), and its response shape is `{"response": {"items": [{"appid", "priority", "date_added"}, ...]}}` with no game name.

- [ ] **Step 1: Write the failing tests (pure parse functions only)**

Create `test/steamApi.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { parseOwnedGamesResponse, parseWishlistResponse } = require('../services/steamApi');

test('parseOwnedGamesResponse extracts appids as strings', () => {
  const data = { response: { game_count: 2, games: [{ appid: 730 }, { appid: 220 }] } };
  assert.deepStrictEqual(parseOwnedGamesResponse(data), ['730', '220']);
});

test('parseOwnedGamesResponse returns an empty array when the profile has no public game details', () => {
  assert.deepStrictEqual(parseOwnedGamesResponse({ response: {} }), []);
});

test('parseWishlistResponse extracts appids as strings', () => {
  const data = { response: { items: [{ appid: 620, priority: 1, date_added: 123 }] } };
  assert.deepStrictEqual(parseWishlistResponse(data), ['620']);
});

test('parseWishlistResponse returns an empty array when the wishlist is empty or private', () => {
  assert.deepStrictEqual(parseWishlistResponse({ response: {} }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `Cannot find module '../services/steamApi'`.

- [ ] **Step 3: Implement `services/steamApi.js`**

```js
const axios = require('axios');

const STEAM_API_BASE = 'https://api.steampowered.com';

function parseOwnedGamesResponse(data) {
  const games = data?.response?.games ?? [];
  return games.map(g => String(g.appid));
}

function parseWishlistResponse(data) {
  const items = data?.response?.items ?? [];
  return items.map(i => String(i.appid));
}

async function getOwnedGameAppIds(steamId) {
  const res = await axios.get(`${STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/`, {
    params: {
      key: process.env.STEAM_API_KEY,
      steamid: steamId,
      include_appinfo: false,
      include_played_free_games: true,
      format: 'json',
    },
    timeout: 10000,
  });
  return parseOwnedGamesResponse(res.data);
}

async function getWishlistAppIds(steamId) {
  const res = await axios.get(`${STEAM_API_BASE}/IWishlistService/GetWishlist/v1/`, {
    params: { key: process.env.STEAM_API_KEY, steamid: steamId, format: 'json' },
    timeout: 10000,
  });
  return parseWishlistResponse(res.data);
}

async function getPersonaName(steamId) {
  const res = await axios.get(`${STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v2/`, {
    params: { key: process.env.STEAM_API_KEY, steamids: steamId, format: 'json' },
    timeout: 10000,
  });
  const player = res.data?.response?.players?.[0];
  return player?.personaname ?? null;
}

module.exports = {
  getOwnedGameAppIds, getWishlistAppIds, getPersonaName,
  parseOwnedGamesResponse, parseWishlistResponse,
};
```

- [ ] **Step 4: Run test to verify it passes**

```
npm test
```

Expected: `test/steamApi.test.js` passes (4 tests).

- [ ] **Step 5: Commit**

```
git add services/steamApi.js test/steamApi.test.js
git commit -m "Add Steam Web API wrapper (owned games, wishlist, persona name)"
```

- [ ] **Step 6: Manual verification of the live calls**

Requires a real `STEAM_API_KEY` in `.env` and a real steamid64 with Public game-details/wishlist privacy. Deferred to Task 6, Step 7, once wired into a route.

---

## Task 5: Import resolution + resync logic (`services/steamImport.js`)

**Files:**
- Create: `services/steamImport.js`
- Create: `test/steamImport.test.js`

**Interfaces:**
- Consumes: `pool` (`services/db.js`), `services/steamApi.js` (Task 4).
- Produces: `resolveAppIdsToItadIds(appIds): Promise<Map<appId, itadId>>`, `resyncOwnedFromSteam(userId, itadIds): Promise<void>`, `resyncWishlistFromSteam(userId, itadIds, ownedItadIds): Promise<void>`, `runImport(userId, steamId): Promise<{ownedCount, wishlistCount}>` — consumed by `routes/steam.js` in Task 6.

`resyncOwnedFromSteam`/`resyncWishlistFromSteam` are pure DB-diffing logic (no network calls), so they get full automated coverage against a real Postgres instance — this is the highest-risk logic in the whole spec (it can silently delete a user's manually-curated list if the diff is wrong), unlike `resolveAppIdsToItadIds`/`runImport`, which make live network calls and are verified manually.

- [ ] **Step 1: Write the failing tests**

Create `test/steamImport.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { createUser, deleteUser, hashPassword } = require('../services/auth');
const { addWishlistItem, addOwned, listWishlistItadIds, listOwnedItadIds } = require('../services/wishlist');
const { resyncOwnedFromSteam, resyncWishlistFromSteam } = require('../services/steamImport');

async function makeTestUser(tag) {
  const email = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  return createUser(email, await hashPassword('password123'));
}

test('resyncOwnedFromSteam adds new steam-sourced games, drops stale ones, keeps manual entries, and clears matching wishlist entries', async () => {
  const user = await makeTestUser('steam-owned-resync');
  await addWishlistItem(user.id, 'itad-a'); // about to become owned via Steam import
  await addOwned(user.id, 'itad-manual', 'manual'); // unrelated manually-owned game

  await resyncOwnedFromSteam(user.id, ['itad-a', 'itad-b']);
  assert.deepStrictEqual((await listOwnedItadIds(user.id)).sort(), ['itad-a', 'itad-b', 'itad-manual'].sort());
  assert.deepStrictEqual(await listWishlistItadIds(user.id), []); // itad-a cleared from wishlist

  // Re-sync: itad-b no longer in the Steam library — drop it; itad-a and itad-manual stay.
  await resyncOwnedFromSteam(user.id, ['itad-a']);
  assert.deepStrictEqual((await listOwnedItadIds(user.id)).sort(), ['itad-a', 'itad-manual'].sort());

  await deleteUser(user.id);
});

test('resyncWishlistFromSteam adds/removes steam-sourced items, keeps manual entries, and never re-adds an owned game', async () => {
  const user = await makeTestUser('steam-wishlist-resync');
  await addWishlistItem(user.id, 'itad-manual-wish'); // untouched by resync

  await resyncWishlistFromSteam(user.id, ['itad-x', 'itad-y'], []);
  assert.deepStrictEqual(
    (await listWishlistItadIds(user.id)).sort(),
    ['itad-manual-wish', 'itad-x', 'itad-y'].sort()
  );

  // Re-sync: itad-y fell off Steam's wishlist; itad-x is now owned, so it must not be re-added.
  await resyncWishlistFromSteam(user.id, ['itad-x'], ['itad-x']);
  assert.deepStrictEqual(await listWishlistItadIds(user.id), ['itad-manual-wish']);

  await deleteUser(user.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `Cannot find module '../services/steamImport'`.

- [ ] **Step 3: Implement `services/steamImport.js`**

```js
const axios = require('axios');
const { pool } = require('./db');
const steamApi = require('./steamApi');

const ITAD_BASE = 'https://api.isthereanydeal.com';
const STEAM_SHOP_ID = 61;

async function resolveAppIdsToItadIds(appIds) {
  const result = new Map(); // appId (string) → itadId
  for (let i = 0; i < appIds.length; i += 200) {
    const batch = appIds.slice(i, i + 200).map(id => `app/${id}`);
    try {
      const res = await axios.post(
        `${ITAD_BASE}/lookup/id/shop/${STEAM_SHOP_ID}/v1`,
        batch,
        { params: { key: process.env.ITAD_API_KEY }, timeout: 15000 }
      );
      for (const [shopKey, itadId] of Object.entries(res.data ?? {})) {
        if (itadId) result.set(shopKey.replace('app/', ''), itadId);
      }
    } catch (e) {
      console.warn('[steamImport] ITAD shop lookup batch failed:', e.message);
    }
  }
  return result;
}

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
```

- [ ] **Step 4: Run test to verify it passes**

```
npm test
```

Expected: `test/steamImport.test.js` passes (2 tests).

- [ ] **Step 5: Commit**

```
git add services/steamImport.js test/steamImport.test.js
git commit -m "Add Steam import resolution and resync logic"
```

- [ ] **Step 6: Manual verification of `resolveAppIdsToItadIds`/`runImport`**

Deferred to Task 6, Step 7, once wired into a route (needs a real `STEAM_API_KEY`, `ITAD_API_KEY`, and a linked Steam account).

---

## Task 6: Routes (`routes/steam.js`)

**Files:**
- Create: `routes/steam.js`
- Modify: `server.js`
- Create: `test/steam-routes.test.js`

**Interfaces:**
- Consumes: `requireAuth` (`middleware/session.js`), `services/steamAuth.js` (Task 3), `services/steamApi.js` (Task 4), `services/steamImport.js` (Task 5), `services/auth.js`'s Steam-link helpers (Task 2).
- Produces: mounted at `/api/steam` — `GET /link`, `GET /callback`, `POST /unlink`, `GET /status`, `POST /import` — consumed by the frontend in Task 7.

The routes that require a live Steam OpenID handshake or live Steam/ITAD API calls (`/link`, `/callback`, and a successful `/import`) are verified manually in Step 7. The routes/behaviors that only depend on session + DB state (`/status`, `/unlink`, and `/import`'s "not linked" guard) are covered by `supertest`.

- [ ] **Step 1: Write the failing tests**

Create `test/steam-routes.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { pool } = require('../services/db');
const { nextTestIp } = require('./helpers/testIp');

async function signupAgent(tag) {
  const email = `${tag}-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email, password: 'password123' }).expect(201);
  return { agent, email };
}

test('GET /api/steam/status requires auth and reports unlinked by default', async () => {
  const anon = await request(app).get('/api/steam/status');
  assert.strictEqual(anon.status, 401);

  const { agent, email } = await signupAgent('steam-status');
  const status = await agent.get('/api/steam/status');
  assert.strictEqual(status.status, 200);
  assert.deepStrictEqual(status.body, { linked: false, personaName: null });

  await pool.query('DELETE FROM users WHERE email = $1', [email]);
});

test('POST /api/steam/unlink requires auth and is idempotent when nothing is linked', async () => {
  const anon = await request(app).post('/api/steam/unlink');
  assert.strictEqual(anon.status, 401);

  const { agent, email } = await signupAgent('steam-unlink');
  await agent.post('/api/steam/unlink').expect(200);

  await pool.query('DELETE FROM users WHERE email = $1', [email]);
});

test('POST /api/steam/import requires auth and 400s when no Steam account is linked', async () => {
  const anon = await request(app).post('/api/steam/import');
  assert.strictEqual(anon.status, 401);

  const { agent, email } = await signupAgent('steam-import-unlinked');
  const res = await agent.post('/api/steam/import');
  assert.strictEqual(res.status, 400);

  await pool.query('DELETE FROM users WHERE email = $1', [email]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `GET /api/steam/status` returns 404.

- [ ] **Step 3: Implement `routes/steam.js`**

```js
const express = require('express');
const { requireAuth } = require('../middleware/session');
const steamAuth = require('../services/steamAuth');
const steamApi = require('../services/steamApi');
const steamImport = require('../services/steamImport');
const auth = require('../services/auth');

const router = express.Router();
router.use(requireAuth);

function buildUrls(req) {
  const base = `${req.protocol}://${req.get('host')}`;
  return { returnUrl: `${base}/api/steam/callback`, realm: `${base}/` };
}

router.get('/link', async (req, res) => {
  try {
    const { returnUrl, realm } = buildUrls(req);
    const authUrl = await steamAuth.getAuthUrl(returnUrl, realm);
    res.redirect(authUrl);
  } catch (e) {
    console.error('[/api/steam/link]', e);
    res.redirect('/?steamError=link_failed');
  }
});

router.get('/callback', async (req, res) => {
  try {
    const { returnUrl, realm } = buildUrls(req);
    const steamId = await steamAuth.verifyAssertion(req, returnUrl, realm);
    if (!steamId) return res.redirect('/?steamError=verification_failed');

    const existing = await auth.findUserBySteamId(steamId);
    if (existing && existing.id !== req.session.userId) {
      return res.redirect('/?steamError=already_linked');
    }

    const personaName = await steamApi.getPersonaName(steamId).catch(() => null);
    await auth.linkSteamAccount(req.session.userId, steamId, personaName);
    res.redirect('/?steamLinked=1');
  } catch (e) {
    console.error('[/api/steam/callback]', e);
    res.redirect('/?steamError=link_failed');
  }
});

router.post('/unlink', async (req, res) => {
  await auth.unlinkSteamAccount(req.session.userId);
  res.json({ ok: true });
});

router.get('/status', async (req, res) => {
  const status = await auth.getSteamLinkStatus(req.session.userId);
  res.json({ linked: !!status.steamId, personaName: status.personaName });
});

router.post('/import', async (req, res) => {
  const status = await auth.getSteamLinkStatus(req.session.userId);
  if (!status.steamId) return res.status(400).json({ error: 'No Steam account linked' });

  try {
    const summary = await steamImport.runImport(req.session.userId, status.steamId);
    res.json(summary);
  } catch (e) {
    console.error('[/api/steam/import]', e);
    res.status(500).json({ error: 'Import failed' });
  }
});

module.exports = router;
```

- [ ] **Step 4: Mount the router in `server.js`**

Add near the other route requires:

```js
const steamRouter = require('./routes/steam');
```

Add after `app.use('/api/me', meRouter);`:

```js
app.use('/api/steam', steamRouter);
```

- [ ] **Step 5: Run tests to verify they pass**

```
npm test
```

Expected: `test/steam-routes.test.js` passes (3 tests).

- [ ] **Step 6: Commit**

```
git add routes/steam.js server.js test/steam-routes.test.js
git commit -m "Add Steam link/unlink/status/import routes"
```

- [ ] **Step 7: Manual verification of the live paths**

Requires real `STEAM_API_KEY` and `ITAD_API_KEY` values in `.env`, and a real Steam account with game-details + wishlist privacy set to Public.

1. Start the dev server (`npm start`), log into SteamUReady with an email/password account in a browser.
2. Navigate to `/api/steam/link` directly (Task 7 will wire a button to this) — confirm it redirects to Steam's login page.
3. Log into Steam — confirm it redirects back to `/?steamLinked=1` and `GET /api/steam/status` now reports `{linked: true, personaName: "<your Steam name>"}`.
4. Call `POST /api/steam/import` — confirm it returns non-zero `ownedCount`/`wishlistCount` matching your actual Steam library/wishlist (spot-check a couple of known-owned games appear via `GET /api/me/owned`).
5. Temporarily set your Steam profile's game-details/wishlist privacy to something other than Public, re-run import, and confirm it returns `{ownedCount: 0, wishlistCount: 0}` without erroring (matches the documented silent-empty behavior — revert your privacy setting afterward).
6. Call `POST /api/steam/unlink`, confirm `GET /api/steam/status` reports `{linked: false, personaName: null}`, and confirm previously-imported games are still present in `GET /api/me/owned`/`GET /api/me/wishlist` (unlinking doesn't delete imported data).

---

## Task 7: Frontend — Connected Accounts section

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`
- Modify: `public/i18n.js`

**Interfaces:**
- Consumes: `GET/POST /api/steam/*` (Task 6), the Account Settings page scaffolding from the accounts plan (`openAccountSettings()`/`closeAccountSettings()`, `#settingsView`).

No automated test — no frontend test tooling in this project (see Global Constraints). Verified manually via the `run` skill.

- [ ] **Step 1: Add the Connected Accounts markup to `public/index.html`**

Add inside `#settingsView` (added in the accounts plan's Task 16), right before the "Danger zone" `.settings-block`:

```html
  <div class="settings-block">
    <h3 data-i18n="connectedAccounts">Connected Accounts</h3>
    <div id="steamNotLinked">
      <a class="btn-steam" href="/api/steam/link" data-i18n="linkSteamAccount">Link Steam Account</a>
    </div>
    <div id="steamLinked" hidden>
      <div id="steamPersonaLabel"></div>
      <button id="steamImportBtn" data-i18n="importFromSteam">Import from Steam</button>
      <p class="settings-hint" data-i18n="steamPrivacyHint">
        Requires your Steam profile's game details and wishlist to be set to Public — check steamcommunity.com/my/edit/settings.
      </p>
      <div id="steamImportSummary"></div>
      <button id="steamUnlinkBtn" class="btn-danger" data-i18n="unlinkSteamAccount">Unlink</button>
    </div>
  </div>
```

- [ ] **Step 2: Add the frontend logic to `public/app.js`**

Add API helpers to the `Object.assign(api, {...})` block (from the accounts plan's Task 12):

```js
  steamStatus()  { return api.json('/api/steam/status'); },
  steamUnlink()  { return fetch('/api/steam/unlink', { method: 'POST' }); },
  steamImport()  { return fetch('/api/steam/import', { method: 'POST' }); },
```

Add a new function, called whenever the settings page opens:

```js
async function refreshSteamStatus() {
  const status = await api.steamStatus().catch(() => ({ linked: false, personaName: null }));
  $('steamNotLinked').hidden = status.linked;
  $('steamLinked').hidden = !status.linked;
  if (status.linked) {
    $('steamPersonaLabel').textContent = t('linkedAsSteam')(status.personaName || 'Steam User');
  }
  $('steamImportSummary').textContent = '';
}

function initSteamSettings() {
  $('steamImportBtn').addEventListener('click', async () => {
    $('steamImportBtn').disabled = true;
    const res = await api.steamImport();
    $('steamImportBtn').disabled = false;
    if (!res.ok) {
      $('steamImportSummary').textContent = t('steamImportFailed');
      return;
    }
    const body = await res.json();
    $('steamImportSummary').textContent = t('steamImportSummary')(body.ownedCount, body.wishlistCount);
  });

  $('steamUnlinkBtn').addEventListener('click', async () => {
    if (!confirm(t('unlinkSteamConfirm'))) return;
    await api.steamUnlink();
    await refreshSteamStatus();
  });
}
```

In `openAccountSettings()` (from the accounts plan's Task 16), add a call to `refreshSteamStatus();` at the end of the function body.

Wire initialization into `init()`: add `initSteamSettings();` right after `initAccountSettings();`.

Handle the post-redirect toast — in `init()`, after `await refreshAuthState();`, add:

```js
  const params = new URLSearchParams(location.search);
  if (params.get('steamLinked') === '1') {
    showToast(t('steamLinkedToast'));
    history.replaceState(null, '', location.pathname);
  } else if (params.get('steamError')) {
    const errorKey = { already_linked: 'steamErrorAlreadyLinked', verification_failed: 'steamErrorVerification', link_failed: 'steamErrorGeneric' }[params.get('steamError')] || 'steamErrorGeneric';
    showToast(t(errorKey));
    history.replaceState(null, '', location.pathname);
  }
```

This references a `showToast(message)` helper. If one doesn't already exist elsewhere in `app.js` (check for an existing toast/notification pattern first — this codebase already has `showError()` for a different purpose), add a minimal one:

```js
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
```

- [ ] **Step 3: i18n keys**

Add to each language object in `public/i18n.js`:

```js
    connectedAccounts:       'Connected Accounts',
    linkSteamAccount:        'Link Steam Account',
    importFromSteam:         'Import from Steam',
    unlinkSteamAccount:      'Unlink',
    unlinkSteamConfirm:      'Unlink your Steam account? Already-imported games will stay, but they will no longer be kept in sync.',
    steamPrivacyHint:        "Requires your Steam profile's game details and wishlist to be set to Public — check steamcommunity.com/my/edit/settings.",
    linkedAsSteam:           name => `Linked as ${name}`,
    steamImportFailed:       'Import failed. Please try again.',
    steamImportSummary:      (owned, wishlist) => `You now have ${owned} owned games and ${wishlist} wishlist items tracked.`,
    steamLinkedToast:        'Steam account linked!',
    steamErrorAlreadyLinked: 'That Steam account is already linked to a different SteamUReady account.',
    steamErrorVerification:  'Steam sign-in could not be verified. Please try again.',
    steamErrorGeneric:       'Something went wrong linking your Steam account. Please try again.',
```

- [ ] **Step 4: Styles**

Append to `public/style.css`:

```css
.settings-hint { font-size: .85rem; opacity: .75; margin: .5rem 0; }
.toast {
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-elevated, #1e1e1e);
  border: 1px solid var(--border, #444);
  padding: .75rem 1.25rem;
  border-radius: 8px;
  z-index: 100;
}
```

- [ ] **Step 5: Manual verification**

Open Account Settings while your SteamUReady account has no Steam account linked yet — confirm only the "Link Steam Account" button shows (the privacy hint is part of the linked view, since it's only relevant once there's an Import button to explain). Click it, complete the Steam login, confirm you land back on the settings page with a "Steam account linked!" toast and the linked view (persona name, Import button, privacy hint, Unlink button). Click Import and confirm the summary text updates. Click Unlink and confirm it reverts to the "Link Steam Account" view.

- [ ] **Step 6: Commit**

```
git add public/index.html public/app.js public/style.css public/i18n.js
git commit -m "Add Connected Accounts (Steam) section to account settings"
```

---

## Self-Review Notes

- **Spec coverage:** Every section of `docs/superpowers/specs/2026-07-22-steam-import-design.md` maps to a task — data model (Task 1), one-time linking vs. ongoing reads (Tasks 3-4), verified API details (Tasks 3-4, cited directly in code comments), routes (Task 6), import logic (Task 5), frontend UI (Task 7), security (steam_id uniqueness in Task 1, server-side-only keys throughout, session-derived auth in every route in Task 6).
- **Cross-plan consistency:** `resyncOwnedFromSteam`'s wishlist cross-removal (Task 5) matches the rule already implemented in the accounts plan's `services/wishlist.js` `addOwned` — both independently enforce "owning it clears the wishlist," so a game marked owned via either path behaves identically.
- **Type/name consistency check:** `itad_id` (string) is the consistent join key from `resolveAppIdsToItadIds`'s `Map<appId, itadId>` through `resyncOwnedFromSteam`/`resyncWishlistFromSteam` into the same `owned_games`/`wishlist_items` tables the accounts plan defined — no new identifier scheme introduced. `steamId` (string, not parsed as a number) is used consistently from `extractSteamId` through `services/auth.js`'s helpers to `owned`/`wishlist` resync, avoiding the classic SteamID64-exceeds-safe-integer-range bug.
