# Exact Steam-App-ID Correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SteamUReady's fuzzy title-matching correlation with exact Steam-App-ID matching, now that EmuReady's `games.getBestSteamAppId` works again (EmuReady PR #342, verified live). Delete the fuzzy path as the primary mechanism, keeping it only as a fallback for the minority of games with no resolvable Steam App ID.

**Architecture:** `services/emuready.js` gains `getBestSteamAppId(title)` (EmuReady tRPC, one call per title — no batch name→App-ID endpoint exists). `services/store.js`'s `resolveTitlesBatch` is rewritten to a four-phase flow: (A) resolve every title's Steam App ID via EmuReady, (B) batch-resolve the found App IDs to `itad_id` via ITAD's exact shop lookup, (C) fall back to the existing ITAD title lookup for anything not resolved in A/B, (D) persist, stamping each row with `resolved_via` so re-resolution is self-limiting. This is **sequenced first**, before the accounts/Steam-import/email-alerts plans, since it corrects the data flow they build on — this repo has no test framework yet, so this plan stands up `node:test` itself (the accounts plan's Task 1 will find it already present and only need to add `supertest`).

**Tech Stack:** `node:test` (built into Node 20+), `axios` (already a dependency), PostgreSQL.

## Global Constraints

- `steam_app_id` becomes authoritative (sourced from EmuReady), not derived secondhand from ITAD.
- The fuzzy ITAD title lookup (`/lookup/id/title/v1`) is kept **only** as a fallback for titles `getBestSteamAppId` can't resolve — never the primary path.
- Fallback-path entries have `steam_app_id = NULL` (no secondary reverse-derivation from the fallback's ITAD UUID) — this is a deliberate simplification already approved in the spec, not an oversight.
- `game_titles` stays keyed on `title_lower`; only one column is added (`resolved_via`).
- `itad_id` stays the key for deals/wishlist/owned — this plan touches no other table.
- The re-resolution of already-cached rows must be **fully automatic and self-limiting**: gated on `resolved_via IS NULL`, no manual script, each title re-resolves exactly once ever.
- Environment is Windows/PowerShell — no bash-specific command syntax.
- Local dev requires Redis + Postgres running (`docker compose up -d`) before running any test in this plan.
- Automated tests cover pure logic only (response parsing, entry assembly); live EmuReady/ITAD network calls are verified manually — consistent with this codebase's existing pattern (`services/store.js`'s `fetchOverviewAPI`, `services/steamcontroller.js` have no automated tests for their network calls either).

---

## Task 1: Test tooling + `resolved_via` schema

**Files:**
- Modify: `package.json`
- Modify: `services/db.js`
- Create: `test/db-correlation.test.js`

**Interfaces:**
- Produces: `game_titles.resolved_via` (TEXT, nullable, checked against `'steam'|'title'`) — consumed by every later task in this plan.

This repo has no test framework yet. Unlike the accounts plan's Task 1 (which also adds `supertest` for HTTP route tests), this plan touches no HTTP routes — only service-level functions — so it needs `node:test` alone.

- [ ] **Step 1: Add the `test` script**

Edit `package.json`:

```json
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "test": "node --test test/"
  },
```

- [ ] **Step 2: Add the schema change to `services/db.js`**

Add inside the template string in `init()`, right after the `game_titles` table definition:

```sql

    ALTER TABLE game_titles ADD COLUMN IF NOT EXISTS resolved_via TEXT;

    DO $$ BEGIN
      ALTER TABLE game_titles ADD CONSTRAINT game_titles_resolved_via_check
        CHECK (resolved_via IS NULL OR resolved_via IN ('steam', 'title'));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
```

(The `DO $$ ... EXCEPTION WHEN duplicate_object` guard makes adding the constraint idempotent across repeated `db.init()` calls — `ADD COLUMN IF NOT EXISTS` alone doesn't cover a constraint that may already exist from a prior run.)

- [ ] **Step 3: Write the schema test**

Create `test/db-correlation.test.js`:

```js
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

  await assert.rejects(
    () => pool.query("UPDATE game_titles SET resolved_via = 'bogus' WHERE FALSE"),
    /violates check constraint|game_titles_resolved_via_check/
  );
});
```

- [ ] **Step 4: Run the test**

```
npm test
```

Expected: `test/db-correlation.test.js` passes (1 test).

- [ ] **Step 5: Commit**

```
git add package.json services/db.js test/db-correlation.test.js
git commit -m "Add node:test tooling and game_titles.resolved_via column"
```

---

## Task 2: `getBestSteamAppId` wrapper (`services/emuready.js`)

**Files:**
- Modify: `services/emuready.js`
- Create: `test/emuready-steamAppId.test.js`

**Interfaces:**
- Produces: `getBestSteamAppId(gameName): Promise<{found: boolean, appId: string|null}>` and `parseBestSteamAppIdResponse(data)` (exported for unit testing without a live call) — consumed by `services/store.js` in Task 5.

Response shape verified live (2026-07-22) against the real endpoint, not assumed: a hit returns `{success:true, appId:"367520", query:"...", found:true}`; a miss (tested with both a gibberish title and a real EmuReady title known not to resolve) returns `{success:true, appId:null, query:"...", found:false}` — never a thrown error or a missing `found` key for a clean miss.

- [ ] **Step 1: Write the failing tests**

Create `test/emuready-steamAppId.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { parseBestSteamAppIdResponse } = require('../services/emuready');

test('parseBestSteamAppIdResponse extracts a found appId as a string', () => {
  const data = { success: true, appId: '367520', query: 'Hollow Knight', found: true };
  assert.deepStrictEqual(parseBestSteamAppIdResponse(data), { found: true, appId: '367520' });
});

test('parseBestSteamAppIdResponse treats found:false as a clean miss', () => {
  const data = { success: true, appId: null, query: 'Not A Real Game', found: false };
  assert.deepStrictEqual(parseBestSteamAppIdResponse(data), { found: false, appId: null });
});

test('parseBestSteamAppIdResponse treats a missing/malformed response as a miss, not a crash', () => {
  assert.deepStrictEqual(parseBestSteamAppIdResponse(null), { found: false, appId: null });
  assert.deepStrictEqual(parseBestSteamAppIdResponse({}), { found: false, appId: null });
  assert.deepStrictEqual(parseBestSteamAppIdResponse({ found: true }), { found: false, appId: null }); // found:true but no appId is not trustworthy
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `parseBestSteamAppIdResponse is not a function`.

- [ ] **Step 3: Implement in `services/emuready.js`**

Add before `module.exports`:

```js
function parseBestSteamAppIdResponse(data) {
  if (data?.found && data?.appId) return { found: true, appId: String(data.appId) };
  return { found: false, appId: null };
}

async function getBestSteamAppId(gameName) {
  try {
    const data = await trpcGet('games.getBestSteamAppId', { gameName });
    return parseBestSteamAppIdResponse(data);
  } catch (e) {
    console.error('[EmuReady] getBestSteamAppId error:', e.message);
    return { found: false, appId: null };
  }
}
```

Update the `module.exports` line at the end of `services/emuready.js` to:

```js
module.exports = { getDevices, getSocs, getPerformanceScales, getListings, getAllListings, getBestSteamAppId, parseBestSteamAppIdResponse, clearCache };
```

- [ ] **Step 4: Run test to verify it passes**

```
npm test
```

Expected: `test/emuready-steamAppId.test.js` passes (3 tests).

- [ ] **Step 5: Commit**

```
git add services/emuready.js test/emuready-steamAppId.test.js
git commit -m "Add getBestSteamAppId wrapper to services/emuready.js"
```

- [ ] **Step 6: Manual verification (deferred to Task 7)**

The live call itself is exercised end-to-end once wired into `resolveTitlesBatch` (Task 5) and run against the real catalog (Task 7).

---

## Task 3: Exact Steam-App-ID → itad_id resolver (`services/store.js`)

**Files:**
- Modify: `services/store.js`

**Interfaces:**
- Produces: `resolveSteamAppIdsToItadIds(steamAppIds): Promise<Map<steamAppId, itadId>>` — consumed by `resolveTitlesBatch` in Task 5. Exported so the Steam-import plan can reuse it later instead of reimplementing the identical ITAD call (see Task 8 below).

Response shape verified live (2026-07-22): `POST /lookup/id/shop/61/v1` with body `["app/367520", "app/588650", "app/999999999"]` (a bogus id included to check the miss case) returns
`{"app/367520": "018d937f-...", "app/588650": "018d937f-...", "app/999999999": null}` — a flat object keyed by the `app/<id>` string, value is the ITAD UUID string or `null`. This confirms the extraction logic below (`if (itadId)`) is correct; no array-wrapping to unwrap, unlike the *reverse* lookup (`/lookup/shop/{id}/id/v1`, used elsewhere in this file) which returns arrays.

No automated test for this function — it's a thin network wrapper with the same shape as the already-untested `fetchOverviewAPI` in this file (a Postgres-free unit test would just be testing that `axios.post` was called, which doesn't verify real behavior). Verified manually in Task 7.

- [ ] **Step 1: Implement `resolveSteamAppIdsToItadIds` in `services/store.js`**

Add after `fetchOverviewAPI`:

```js
// Resolve Steam App IDs → ITAD ids via ITAD's exact shop lookup (batched 200/call).
// Returns Map(steamAppId → itadId). Steam App IDs ITAD doesn't recognize are omitted.
async function resolveSteamAppIdsToItadIds(steamAppIds) {
  const result = new Map();
  for (let i = 0; i < steamAppIds.length; i += 200) {
    const batch = steamAppIds.slice(i, i + 200).map(id => `app/${id}`);
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
      console.warn(`[Store] Steam appId → itad_id lookup failed (offset ${i}):`, e.message);
    }
  }
  return result;
}
```

- [ ] **Step 2: Update `module.exports`**

Update the `module.exports` line at the end of `services/store.js` to:

```js
module.exports = { getDealsForTitles, resolveSteamAppIdsToItadIds, getShops, clearCache, REGIONS, STEAM_SHOP_ID };
```

(Exported now, not deferred to a later task, since it has no test in this task that would otherwise catch a missing export — and the Steam-import plan's reuse of this function depends on it being reachable via `require('../services/store')`.)

- [ ] **Step 3: Manual verification (deferred to Task 7)**

Exercised end-to-end once wired into `resolveTitlesBatch` (Task 5).

- [ ] **Step 4: Commit**

```
git add services/store.js
git commit -m "Add resolveSteamAppIdsToItadIds (exact Steam App ID -> itad_id)"
```

---

## Task 4: Entry-assembly pure helpers (`services/store.js`)

**Files:**
- Modify: `services/store.js`
- Create: `test/store-resolution.test.js`

**Interfaces:**
- Produces: `buildExactEntry(title, steamAppId, itadId): entry` and `buildFallbackEntry(title, itadId): entry` (both pure, exported for testing) — consumed by `resolveTitlesBatch` in Task 5. `entry` shape: `{id, matchTitle, steamAppId, imageUrl, resolvedVia}` (or `{id: null, resolvedVia: 'title'}` for an unresolved fallback).

- [ ] **Step 1: Write the failing tests**

Create `test/store-resolution.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { buildExactEntry, buildFallbackEntry } = require('../services/store');

test('buildExactEntry assembles a steam-resolved-and-verified entry with a Steam header image', () => {
  const entry = buildExactEntry('Hollow Knight', '367520', '018d937f-1ae9-734c-ba47-bd357cf07edd');
  assert.deepStrictEqual(entry, {
    id: '018d937f-1ae9-734c-ba47-bd357cf07edd',
    matchTitle: 'Hollow Knight',
    steamAppId: '367520',
    imageUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/367520/header.jpg',
    resolvedVia: 'steam',
  });
});

test('buildExactEntry returns null when there is no itad_id (caller must fall back)', () => {
  assert.strictEqual(buildExactEntry('Hollow Knight', '367520', null), null);
});

test('buildFallbackEntry assembles a title-resolved entry with steamAppId left null', () => {
  const entry = buildFallbackEntry('Verdun Soundtrack', '0191ccea-f986-7119-8d93-d043727298f0');
  assert.deepStrictEqual(entry, {
    id: '0191ccea-f986-7119-8d93-d043727298f0',
    matchTitle: 'Verdun Soundtrack',
    steamAppId: null,
    imageUrl: '',
    resolvedVia: 'title',
  });
});

test('buildFallbackEntry marks a fully unresolved title so it is cached as a permanent miss', () => {
  assert.deepStrictEqual(buildFallbackEntry('Some Unmatchable Title', null), { id: null, resolvedVia: 'title' });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `buildExactEntry is not a function`.

- [ ] **Step 3: Implement in `services/store.js`**

Add after `resolveSteamAppIdsToItadIds`:

```js
// Pure: assemble a game_titles entry for a title EmuReady resolved to an exact,
// ITAD-verified Steam App ID. Returns null if ITAD doesn't recognize that App
// ID (caller falls back to the title-lookup path).
function buildExactEntry(title, steamAppId, itadId) {
  if (!itadId) return null;
  return {
    id: itadId,
    matchTitle: title,
    steamAppId,
    imageUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${steamAppId}/header.jpg`,
    resolvedVia: 'steam',
  };
}

// Pure: assemble a game_titles entry from the ITAD title-lookup fallback.
// steamAppId is deliberately left null here (no secondary reverse-derivation)
// — this is the minority fallback path for games with no resolvable Steam App ID.
function buildFallbackEntry(title, itadId) {
  if (!itadId) return { id: null, resolvedVia: 'title' };
  return { id: itadId, matchTitle: title, steamAppId: null, imageUrl: '', resolvedVia: 'title' };
}
```

- [ ] **Step 4: Update `module.exports`**

Update the `module.exports` line at the end of `services/store.js` (added by Task 3) to:

```js
module.exports = { getDealsForTitles, resolveSteamAppIdsToItadIds, buildExactEntry, buildFallbackEntry, getShops, clearCache, REGIONS, STEAM_SHOP_ID };
```

(Required for this task's own test — `test/store-resolution.test.js` imports both functions via `require('../services/store')`, which returns `undefined` for anything not in this list.)

- [ ] **Step 5: Run test to verify it passes**

```
npm test
```

Expected: `test/store-resolution.test.js` passes (4 tests).

- [ ] **Step 6: Commit**

```
git add services/store.js test/store-resolution.test.js
git commit -m "Add pure entry-assembly helpers for exact and fallback correlation"
```

---

## Task 5: Rewrite `resolveTitlesBatch` to the four-phase exact flow

**Files:**
- Modify: `services/store.js`

**Interfaces:**
- Consumes: `emuready.getBestSteamAppId` (Task 2), `resolveSteamAppIdsToItadIds` (Task 3), `buildExactEntry`/`buildFallbackEntry` (Task 4).
- Modifies: `resolveTitlesBatch(titles): Promise<{[titleLower]: entry}>` — same signature and return shape as before, so `getDealsForTitles` (Task 6) needs no interface change, only the cache-gate SELECT.

- [ ] **Step 1: Add the `emuready` require**

Add near the top of `services/store.js`, alongside the other requires:

```js
const emuready = require('./emuready');
```

- [ ] **Step 2: Replace `resolveTitlesBatch`**

Replace the entire existing `resolveTitlesBatch` function (from `// ── Phase 1: Batch title → ITAD ID resolution...` through its closing `}`) with:

```js
// ── Resolve titles to itad_ids via exact Steam App ID matching, falling
// back to ITAD's fuzzy title lookup only for what can't be resolved exactly.
// Returns { [titleLower]: entry } for all resolved titles.
async function resolveTitlesBatch(titles) {
  const entries = {};

  // Phase A: title → steamAppId via EmuReady. No batch name→App-ID endpoint
  // exists, so this is one call per title (this only ever runs for titles
  // not already cached in game_titles — see the resolved_via gate in
  // getDealsForTitles — so it's a one-time cost per title, not per request).
  const steamResultByTitle = new Map(); // titleLower → {found, appId}
  for (const title of titles) {
    steamResultByTitle.set(title.toLowerCase(), await emuready.getBestSteamAppId(title));
  }

  // Phase B: batch-resolve the found steamAppIds → itad_id (exact, 200/call).
  const exactAppIds = [...new Set(
    [...steamResultByTitle.values()].filter(r => r.found).map(r => r.appId)
  )];
  const appIdToItadId = exactAppIds.length
    ? await resolveSteamAppIdsToItadIds(exactAppIds)
    : new Map();

  const titlesNeedingFallback = [];
  for (const title of titles) {
    const steamResult = steamResultByTitle.get(title.toLowerCase());
    const itadId = steamResult.found ? appIdToItadId.get(steamResult.appId) : null;
    const entry = itadId ? buildExactEntry(title, steamResult.appId, itadId) : null;
    if (entry) {
      entries[title.toLowerCase()] = entry;
    } else {
      titlesNeedingFallback.push(title);
    }
  }

  // Phase C: fallback — ITAD title lookup for anything not resolved exactly
  // (EmuReady had no Steam App ID for it, or ITAD didn't recognize the App ID
  // EmuReady gave us — e.g. an Epic/GOG-exclusive).
  if (titlesNeedingFallback.length) {
    for (let i = 0; i < titlesNeedingFallback.length; i += 200) {
      const batch = titlesNeedingFallback.slice(i, i + 200);
      let lookupResult = {};
      try {
        const res = await axios.post(
          `${ITAD_BASE}/lookup/id/title/v1`,
          batch,
          { params: { key: process.env.ITAD_API_KEY }, timeout: 15000 }
        );
        lookupResult = res.data ?? {};
      } catch (e) {
        console.warn(`[Store] ITAD title-lookup fallback failed (offset ${i}):`, e.message);
      }
      for (const [title, itadId] of Object.entries(lookupResult)) {
        entries[title.toLowerCase()] = buildFallbackEntry(title, itadId);
      }
    }
  }

  // Phase D: persist (batched upsert, 200 rows/call).
  const vals = Object.entries(entries);
  for (let i = 0; i < vals.length; i += 200) {
    const chunk = vals.slice(i, i + 200);
    const placeholders = chunk.map((_, j) => `($${j*6+1}, $${j*6+2}, $${j*6+3}, $${j*6+4}, $${j*6+5}, $${j*6+6})`).join(', ');
    const params = chunk.flatMap(([key, e]) => [key, e.id ?? null, e.matchTitle ?? null, e.steamAppId ?? null, e.imageUrl ?? null, e.resolvedVia ?? null]);
    await pool.query(
      `INSERT INTO game_titles (title_lower, itad_id, match_title, steam_app_id, image_url, resolved_via)
       VALUES ${placeholders}
       ON CONFLICT (title_lower) DO UPDATE SET
         itad_id      = EXCLUDED.itad_id,
         match_title  = EXCLUDED.match_title,
         steam_app_id = EXCLUDED.steam_app_id,
         image_url    = EXCLUDED.image_url,
         resolved_via = EXCLUDED.resolved_via,
         updated_at   = NOW()`,
      params
    );
  }

  return entries;
}
```

- [ ] **Step 3: Confirm `module.exports` already reflects this task's additions**

Tasks 3 and 4 already updated `module.exports` to its final form for this file:

```js
module.exports = { getDealsForTitles, resolveSteamAppIdsToItadIds, buildExactEntry, buildFallbackEntry, getShops, clearCache, REGIONS, STEAM_SHOP_ID };
```

This task adds no new exported function (`resolveTitlesBatch` was never exported, before or after), so there is nothing to change here — just confirm the line still matches the above after Step 2's replacement (the replaced function body doesn't touch this line, but double-check no stray edit affected it).

- [ ] **Step 4: Run the full test suite**

```
npm test
```

Expected: all tests from Tasks 1-4 still pass (this step only rewires internals `resolveTitlesBatch` calls; it doesn't change any tested function's signature).

- [ ] **Step 5: Commit**

```
git add services/store.js
git commit -m "Rewrite resolveTitlesBatch to exact Steam-App-ID-first resolution"
```

---

## Task 6: Self-limiting re-resolution gate in `getDealsForTitles`

**Files:**
- Modify: `services/store.js`

**Interfaces:**
- Modifies: the cache-read `SELECT` inside `getDealsForTitles` — this is the mechanism that makes re-resolving every pre-existing `game_titles` row (which all have `resolved_via = NULL` after Task 1's migration) fully automatic, one-time, and self-limiting, per the spec's "Migration / re-warm" section.

- [ ] **Step 1: Update the cache-read query**

In `services/store.js`, inside `getDealsForTitles`, change:

```js
  const { rows: dbRows } = await pool.query(
    'SELECT title_lower, itad_id, match_title, steam_app_id, image_url FROM game_titles WHERE title_lower = ANY($1)',
    [titleLowers]
  );
```

to:

```js
  const { rows: dbRows } = await pool.query(
    'SELECT title_lower, itad_id, match_title, steam_app_id, image_url FROM game_titles WHERE title_lower = ANY($1) AND resolved_via IS NOT NULL',
    [titleLowers]
  );
```

A row with `resolved_via IS NULL` (every pre-existing row, immediately after this plan's migration) is now read as a cache miss, falls into `needsLookup`, and is re-resolved through the new `resolveTitlesBatch` flow — which always writes a non-null `resolved_via`, so that title is never treated as a miss again. No other code path sets `resolved_via` to NULL, so this is a one-time, self-terminating effect with no flag or cleanup step required.

- [ ] **Step 2: Run the full test suite**

```
npm test
```

Expected: all tests still pass (no test in this plan exercises `getDealsForTitles` directly — its network calls are the same untested-by-design pattern as `fetchOverviewAPI` — this is a one-line, low-risk change verified manually in Task 7).

- [ ] **Step 3: Commit**

```
git add services/store.js
git commit -m "Gate game_titles cache reads on resolved_via to self-limit re-resolution"
```

---

## Task 7: Manual end-to-end verification against the live catalog

**Files:** none (verification only).

- [ ] **Step 1: Run the app locally with the new schema**

```
docker compose up -d
npm start
```

Confirm the startup logs show `[DB] schema ready` (the new column/constraint applied without error) and the existing `warmCaches()` background warm kicks off as before.

- [ ] **Step 2: Confirm the migration actually re-resolves existing rows**

Before starting the server (or via `psql`), check the row count with `resolved_via IS NULL`:

```sql
SELECT count(*) FROM game_titles WHERE resolved_via IS NULL;
```

This should equal the total existing row count (all pre-existing rows are unstamped). After the app has been running for a few minutes (long enough for a page of `/api/games` to trigger `getDealsForTitles` for a device/region, or for `warmCaches()` to progress), re-run the query — the count of `resolved_via IS NULL` rows for titles that were actually requested should have dropped, and:

```sql
SELECT resolved_via, count(*) FROM game_titles GROUP BY resolved_via;
```

should now show a growing `'steam'` bucket and a small `'title'` bucket, roughly matching the ~95%/~5% split measured during design.

- [ ] **Step 3: Spot-check known games resolve to the correct Steam App ID**

With the dev server running, search for a few well-known games (e.g. "Hollow Knight", "Dead Cells", "Balatro") in the UI and confirm:
- The correct game card appears with the correct cover art (a real Steam header image, not blank).
- `SELECT steam_app_id, resolved_via FROM game_titles WHERE title_lower = 'hollow knight';` shows `367520` and `'steam'`.

- [ ] **Step 4: Confirm controller-support and IGDB re-warm follow the corrected App IDs**

Pick a game whose `steam_app_id` changed between the old (ITAD-derived) and new (EmuReady-authoritative) resolution — if none changed for your spot-checks, temporarily clear a `controller_support` row for a title you just re-resolved and confirm the background warm (`steamcontroller.warmMissing()`, already running per the existing `warmCaches()` call) repopulates it keyed on the new, correct App ID within its normal warm cycle.

- [ ] **Step 5: Confirm the fallback path still surfaces Epic/GOG-exclusive games**

Find or note a game in the catalog that has no Steam presence (an Epic or GOG exclusive with EmuReady listings). Confirm it still appears in results (via the title-lookup fallback) with `resolved_via = 'title'` and `steam_app_id IS NULL` in `game_titles`, and that it has no cover art (expected, per the deliberate `imageUrl: ''` in `buildFallbackEntry`) but its price/deal data is otherwise correct.

- [ ] **Step 6: Confirm no regression in existing filters**

Run through the existing filter set (device, chipset, compat range, store, price, discount, controller support, IGDB rating) once against a device with a reasonable number of listings, and confirm result counts look sane compared to before this change (no games silently disappearing due to a resolution regression).

---

## Self-Review Notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-07-22-exact-correlation-design.md` maps to a task — new data flow (Tasks 2-5), data model (Task 1), migration/re-warm (Task 6, verified in Task 7). Impact on the three written feature specs required no code task here (they only consume `itad_id`-keyed functions untouched by this plan) — the one concrete cross-plan follow-up (Steam-import's `resolveAppIdsToItadIds` duplicating this plan's `resolveSteamAppIdsToItadIds`) was applied directly to `docs/superpowers/plans/2026-07-22-steam-import.md` as a same-session documentation edit rather than as a task in this plan, since it edits a sibling planning document, not application code — see that plan's own commit history.
- **API shapes verified live, not assumed:** `getBestSteamAppId` hit and miss shapes (Task 2), `/lookup/id/shop/61/v1`'s flat `{"app/id": itadId|null}` response shape (Task 3) — the latter specifically because earlier design work had only verified the *reverse* direction (`/lookup/shop/{id}/id/v1`, which returns arrays) and this plan depends on a different, previously-unverified direction.
- **Type/name consistency check:** `entries` objects flow with a consistent shape (`{id, matchTitle, steamAppId, imageUrl, resolvedVia}` or `{id: null, resolvedVia}`) from `buildExactEntry`/`buildFallbackEntry` (Task 4) through `resolveTitlesBatch`'s Phase D upsert (Task 5) — same field names used in the pre-existing `titleCache` entry shape read back in `getDealsForTitles`, so no downstream consumer needed updating.
- **Sequencing dependency confirmed:** Task 1 stands up `node:test` fresh (no `supertest`, since this plan adds no HTTP routes) — the accounts plan's own Task 1 will find `node:test` already present (harmless, `npm install` is idempotent) and only need to add `supertest` for its route tests.
