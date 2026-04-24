/**
 * Queries Steam's appdetails API for every steam_app_id in the game_titles table
 * and writes the results to seeds/controller_support.json.
 *
 * Usage:
 *   node scripts/seed-controller-support.js
 *
 * Requires DATABASE_URL in environment (or .env file).
 * Results are written incrementally — safe to Ctrl+C and resume.
 * Uses exponential backoff on rate limits so no entries are skipped.
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const REQUEST_DELAY   = 1500;          // ms between requests — ~40/min
const BACKOFF_INITIAL = 15_000;        // first 429 wait: 15s
const BACKOFF_MAX     = 5 * 60_000;   // cap backoff at 5 min
const MAX_RETRIES     = 10;
const CAT_FULL        = 28;
const CAT_PARTIAL     = 18;
const OUT_FILE        = path.join(__dirname, '..', 'seeds', 'controller_support.json');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchOne(steamAppId) {
  const res = await axios.get('https://store.steampowered.com/api/appdetails', {
    params: { appids: steamAppId, filters: 'categories' },
    timeout: 8000,
  });
  const entry = res.data?.[steamAppId];
  if (!entry?.success || !entry.data) return 'none';
  const cats = (entry.data.categories ?? []).map(c => c.id);
  if (cats.includes(CAT_FULL))    return 'full';
  if (cats.includes(CAT_PARTIAL)) return 'partial';
  return 'none';
}

// Retries on 429 and transient network errors with exponential backoff.
// Returns support string, or null for permanently-skippable entries (403).
async function fetchWithBackoff(steamAppId, done, total) {
  let delay = BACKOFF_INITIAL;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchOne(steamAppId);
    } catch (e) {
      const status = e.response?.status;

      if (status === 403) {
        return null; // age-gated / region-locked — no data available
      }

      const retriable = status === 429 || status >= 500 || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED';

      if (!retriable) {
        process.stdout.write(`\n[warn] ${steamAppId}: ${e.message}\n`);
        return null;
      }

      if (attempt === MAX_RETRIES) {
        process.stdout.write(`\n[error] ${steamAppId}: gave up after ${MAX_RETRIES} retries\n`);
        return null;
      }

      const waitSecs = (delay / 1000).toFixed(0);
      process.stdout.write(`\n[${done}/${total}] rate limited — waiting ${waitSecs}s (attempt ${attempt + 1}/${MAX_RETRIES})…\n`);
      await sleep(delay);
      delay = Math.min(delay * 2, BACKOFF_MAX);
    }
  }
}

async function main() {
  const { rows } = await pool.query(
    'SELECT DISTINCT steam_app_id FROM game_titles WHERE steam_app_id IS NOT NULL ORDER BY steam_app_id'
  );
  await pool.end();

  if (!rows.length) {
    console.error('No steam_app_ids found in game_titles. Run the app first to populate the table.');
    process.exit(1);
  }

  // Load existing results so we can resume a partial run
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  let results = [];
  if (fs.existsSync(OUT_FILE)) {
    try {
      results = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      console.log(`Resuming — ${results.length} entries already in seed file.`);
    } catch {
      console.warn('Could not parse existing seed file — starting fresh.');
    }
  }
  const alreadyDone = new Set(results.map(r => r.steam_app_id));
  const todo = rows.filter(r => !alreadyDone.has(r.steam_app_id));

  if (!todo.length) {
    console.log('All entries already seeded.');
    process.exit(0);
  }

  console.log(`${todo.length} remaining (${alreadyDone.size} already done, ${rows.length} total).`);
  console.log(`Estimated time: ~${Math.ceil(todo.length * REQUEST_DELAY / 60000)} minutes at 1 req/1.5s`);
  console.log('');

  let done = alreadyDone.size;
  const total = rows.length;

  for (const { steam_app_id } of todo) {
    const support = await fetchWithBackoff(steam_app_id, done, total);

    // Only write non-null (403s produce null and are excluded from the seed)
    if (support !== null) {
      results.push({ steam_app_id, support });
      // Write after every entry so a crash doesn't lose progress
      fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
    }

    done++;
    process.stdout.write(`\r[${done}/${total}] ${steam_app_id} → ${support ?? 'skipped (403)'}`);

    if (done < total) await sleep(REQUEST_DELAY);
  }

  console.log(`\n\nDone. ${results.length} entries written to ${OUT_FILE}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
