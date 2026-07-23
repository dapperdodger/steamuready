const express = require('express');
const auth = require('../services/auth');
const { redis } = require('../services/cache');

const router = express.Router();

// Structurally valid bcrypt hash with no real matching password — compared against
// on a "user not found" login attempt so response timing doesn't reveal whether
// the email exists.
const DUMMY_HASH = '$2b$12$CwTycUXWue0Thq9StjUM0uJ8p9qE95VvoVzysmuMZ.J.79M8j2vTC';

const AUTH_RATE_WINDOW_MS = 60 * 1000;
const AUTH_RATE_MAX = 5;

async function authRateLimiter(req, res, next) {
  const key = `ratelimit:auth:${req.ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.pexpire(key, AUTH_RATE_WINDOW_MS);
  if (count > AUTH_RATE_MAX) {
    const ttl = await redis.pttl(key);
    return res.status(429).json({
      error: 'Too many attempts. Please wait before trying again.',
      retryAfter: Math.ceil(ttl / 1000),
    });
  }
  next();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/signup', authRateLimiter, async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Valid email is required' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const passwordHash = await auth.hashPassword(password);
    const user = await auth.createUser(email.toLowerCase(), passwordHash);
    req.session.userId = user.id;
    res.status(201).json({ email: user.email, preferences: user.preferences, hideOwnedDefault: user.hide_owned_default });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    console.error('[/api/auth/signup]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', authRateLimiter, async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  try {
    const user = await auth.findUserByEmail(email.toLowerCase());
    const valid = await auth.verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    req.session.userId = user.id;
    res.json({ email: user.email, preferences: user.preferences, hideOwnedDefault: user.hide_owned_default });
  } catch (e) {
    console.error('[/api/auth/login]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('[/api/auth/logout]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/me', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in' });
  try {
    const user = await auth.findUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    res.json({ email: user.email, preferences: user.preferences, hideOwnedDefault: user.hide_owned_default });
  } catch (e) {
    console.error('[/api/auth/me]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
