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
// for lockId; skips fn() (logging via onSkip) if the lock is still held after
// exhausting retries. Used to keep two concurrently-booting instances from
// redundantly running the same expensive background job (see server.js's
// warmCaches()).
//
// Retries with a delay rather than checking once: during a rolling ECS
// deploy, old and new tasks briefly coexist. An old task can still be
// mid-warm (genuinely holding the lock) at the exact moment new tasks boot
// and do their check — a one-shot check makes every new task give up
// permanently, even though the old task is killed moments later and the
// lock frees up. Retrying gives a new task a chance to pick up the lock once
// the outgoing task's connection is torn down (which releases the lock).
async function tryWithAdvisoryLock(lockId, fn, onSkip, { retries = 5, retryDelayMs = 30000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const client = await pool.connect();
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockId]);
      if (rows[0].locked) {
        try {
          await fn();
        } finally {
          await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
        }
        return;
      }
    } finally {
      client.release();
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, retryDelayMs));
  }
  if (onSkip) onSkip();
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

    CREATE TABLE IF NOT EXISTS users (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email              TEXT UNIQUE NOT NULL,
      password_hash      TEXT NOT NULL,
      preferences        JSONB DEFAULT '{}',
      hide_owned_default BOOLEAN NOT NULL DEFAULT FALSE,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wishlist_items (
      user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
      itad_id    TEXT NOT NULL,
      added_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, itad_id)
    );

    CREATE TABLE IF NOT EXISTS owned_games (
      user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
      itad_id    TEXT NOT NULL,
      source     TEXT DEFAULT 'manual',
      added_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, itad_id)
    );

    CREATE TABLE IF NOT EXISTS hidden_games (
      user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
      itad_id    TEXT NOT NULL,
      added_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, itad_id)
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS alert_mode TEXT DEFAULT 'sale_period';
    ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS last_alerted_price NUMERIC;
    ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS last_alerted_deal_since TIMESTAMPTZ;

    ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_id TEXT UNIQUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_persona_name TEXT;
    ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';

    CREATE TABLE IF NOT EXISTS email_tokens (
      token       TEXT PRIMARY KEY,
      user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
      purpose     TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    DO $$ BEGIN
      ALTER TABLE users ADD CONSTRAINT users_alert_mode_check
        CHECK (alert_mode IN ('price_drop', 'sale_period', 'historical_low'));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);
  console.log('[DB] schema ready');
}

module.exports = { pool, init, tryWithAdvisoryLock };
