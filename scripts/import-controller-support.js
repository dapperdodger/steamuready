/**
 * Imports seeds/controller_support.json into the controller_support table.
 * Safe to re-run — uses ON CONFLICT DO NOTHING so existing rows are untouched.
 *
 * Usage:
 *   node scripts/import-controller-support.js
 *
 * Requires DATABASE_URL in environment (or .env file).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const SEED_FILE  = path.join(__dirname, '..', 'seeds', 'controller_support.json');
const BATCH_SIZE = 500;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

async function main() {
  if (!fs.existsSync(SEED_FILE)) {
    console.error(`Seed file not found: ${SEED_FILE}`);
    console.error('Run node scripts/seed-controller-support.js first.');
    process.exit(1);
  }

  const records = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  console.log(`Importing ${records.length} records…`);

  // Ensure table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS controller_support (
      steam_app_id TEXT PRIMARY KEY,
      support      TEXT CHECK (support IN ('full', 'partial', 'none')),
      checked_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  let inserted = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(', ');
    const params = batch.flatMap(r => [r.steam_app_id, r.support]);
    await pool.query(
      `INSERT INTO controller_support (steam_app_id, support) VALUES ${placeholders} ON CONFLICT (steam_app_id) DO NOTHING`,
      params
    );
    inserted += batch.length;
    process.stdout.write(`\r${inserted}/${records.length}`);
  }

  await pool.end();
  console.log(`\nDone.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
