const session = require('express-session');
const RedisStore = require('connect-redis')(session);
const { redis } = require('../services/cache');

const sessionMiddleware = session({
  store: new RedisStore({ client: redis, prefix: 'sess:' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
});

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  next();
}

// Scans the session keyspace (same SCAN pattern as delPattern in
// services/cache.js) and deletes every session belonging to userId — used
// after a password reset so a compromised session doesn't survive it.
async function invalidateUserSessions(userId) {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'sess:*', 'COUNT', 100);
    cursor = next;
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      try {
        if (JSON.parse(raw).userId === userId) await redis.del(key);
      } catch { /* malformed session data — skip */ }
    }
  } while (cursor !== '0');
}

module.exports = { sessionMiddleware, requireAuth, invalidateUserSessions };
