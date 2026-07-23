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

// Run fn() only if this process wins a Postgres session-level advisory lock
// for lockId; skips fn() (logging via onSkip) if another process already
// holds it. Used to keep two concurrently-booting instances from redundantly
// running the same expensive background job (see server.js's warmCaches()).
async function tryWithAdvisoryLock(lockId, fn, onSkip) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockId]);
    if (!rows[0].locked) {
      if (onSkip) onSkip();
      return;
    }
    try {
      await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
    }
  } finally {
    client.release();
  }
}

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

    ALTER TABLE game_titles ADD COLUMN IF NOT EXISTS resolved_via TEXT;

    DO $$ BEGIN
      ALTER TABLE game_titles ADD CONSTRAINT game_titles_resolved_via_check
        CHECK (resolved_via IS NULL OR resolved_via IN ('steam', 'title'));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;

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

module.exports = { pool, init, tryWithAdvisoryLock };
