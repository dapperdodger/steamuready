const { Pool } = require('pg');

const ssl = process.env.DATABASE_URL &&
  !process.env.DATABASE_URL.includes('localhost') &&
  !process.env.DATABASE_URL.includes('127.0.0.1')
  ? { rejectUnauthorized: false }
  : false;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_titles (
      title_lower  TEXT PRIMARY KEY,
      itad_id      TEXT,
      match_title  TEXT,
      steam_app_id TEXT,
      image_url    TEXT,
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS controller_support (
      steam_app_id TEXT PRIMARY KEY,
      support      TEXT CHECK (support IN ('full', 'partial', 'none')),
      checked_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS igdb_mappings (
      steam_app_id TEXT PRIMARY KEY,
      igdb_game_id INTEGER,
      checked_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS igdb_ratings (
      itad_id           TEXT PRIMARY KEY,
      igdb_rating       REAL,
      igdb_rating_count INTEGER,
      user_rating       REAL,
      critic_rating     REAL,
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('[DB] schema ready');
}

module.exports = { pool, init };
