# Accounts, Wishlist & Owned Games Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional email/password accounts to SteamUReady, letting logged-in users mark games as wishlisted or owned, hide owned games from search results, and sync their filter preferences to their account instead of localStorage.

**Architecture:** Express routes (`routes/auth.js`, `routes/me.js`) backed by new Postgres tables (`users`, `wishlist_items`, `owned_games`) and Redis-backed sessions (`express-session` + `connect-redis`, reusing the existing `ioredis` client). Frontend additions are vanilla JS/HTML/CSS following the existing patterns in `public/app.js` (no build step, no framework). Backend auth/session/wishlist logic gets automated tests (Node's built-in `node:test` + `supertest`); frontend changes are verified manually per existing project convention (no frontend test tooling exists and none is being introduced).

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`), Redis (`ioredis`), `bcrypt`, `express-session`, `connect-redis`, `node:test`, `supertest`.

## Global Constraints

- Password hashing: bcrypt, cost factor 12 — never log or return a password or hash in any API response.
- Session cookie: `httpOnly: true`, `sameSite: 'lax'`, `secure: true` in production.
- Wishlist/owned rows key on `itad_id` (ITAD's UUID from `game_titles`), not `steam_app_id`.
- No email verification or password-reset flow in this plan — deferred to the alerts spec, which needs email infra anyway.
- Auth endpoints (`/api/auth/signup`, `/api/auth/login`) are rate-limited separately from the existing `gamesRateLimiter` (5 requests/min/IP).
- No route may trust a client-supplied user id — every `/api/me/*` route derives the user id from `req.session.userId`.
- Login failures return the same generic `"Invalid email or password"` message regardless of whether the email exists.
- Environment is Windows/PowerShell — every command below is a plain `npm`/`node`/`git` invocation with no bash-specific syntax (no `&&` chains, no heredocs), so it runs the same in PowerShell or Bash.
- This repo has no existing test framework; this plan introduces `node:test` (built into Node 20+, which the project already requires) + `supertest` as a devDependency — nothing heavier.
- Local dev requires Redis + Postgres running (`docker compose up -d`, per the existing README) before running any test in this plan.

---

## Task 1: Test tooling + make `server.js` testable

**Files:**
- Modify: `package.json`
- Modify: `server.js:528-546` (final block)
- Create: `test/server.test.js`

**Interfaces:**
- Produces: `module.exports = app` from `server.js` — every later test file does `const app = require('../server')`.

`server.js` currently starts listening and kicks off `warmCaches()` as a side effect of being loaded (lines 528-546). Tests need to `require('../server')` to get the Express `app` for `supertest` without opening a real port or making live EmuReady/ITAD calls. Guard the startup block behind `require.main === module` and export `app` unconditionally.

- [ ] **Step 1: Add `supertest` devDependency and a `test` script**

Edit `package.json`:

```json
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "test": "node --test test/"
  },
  "dependencies": {
```

Add to `devDependencies`:

```json
  "devDependencies": {
    "nodemon": "^3.1.0",
    "supertest": "^7.0.0"
  }
```

- [ ] **Step 2: Install**

```
npm install
```

- [ ] **Step 3: Guard the startup block in `server.js`**

Replace lines 528-546 (from `const PORT = process.env.PORT || 3000;` to the closing `});` of the `.catch`) with:

```js
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  db.init().then(() => {
    const server = app.listen(PORT, () => {
      console.log(`\n🎮  SteamUReady Running`);
      warmCaches();
    });

    // ── Graceful shutdown (ECS/ALB task draining) ───────────────────────────────
    process.on('SIGTERM', () => {
      console.log('[shutdown] SIGTERM received — draining connections…');
      server.close(() => {
        console.log('[shutdown] all connections closed, exiting');
        process.exit(0);
      });
    });
  }).catch(e => {
    console.error('[DB] init failed:', e.message);
    process.exit(1);
  });
}

module.exports = app;
```

- [ ] **Step 4: Write the first test — verify the export and an existing route**

Create `test/server.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');

test('GET /api/status returns ok without touching a live network call', async () => {
  const res = await request(app).get('/api/status');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'ok');
});
```

- [ ] **Step 5: Run it**

```
npm test
```

Expected: `test/server.test.js` passes (1 test, 0 failures). This confirms both the `node --test` setup and the `server.js` export refactor work together.

- [ ] **Step 6: Manually confirm normal startup still works**

```
npm start
```

Expected: same console output as before (`🎮  SteamUReady Running`, then cache warm-up logs). Stop with Ctrl+C once confirmed.

- [ ] **Step 7: Add a shared test helper for unique per-test IPs**

`routes/auth.js` (Task 6) rate-limits `/signup` and `/login` per-IP at 5 requests/60s. Every test file below that calls either endpoint via `supertest` needs its own simulated IP so it doesn't share a rate-limit bucket with every other test in the suite — `node --test` runs files in parallel by default, and this project's tests collectively make well over 5 such calls. `server.js` already has `app.set('trust proxy', 1)`, so an `X-Forwarded-For` header on a direct `supertest` request is honored as `req.ip`.

Create `test/helpers/testIp.js`:

```js
let counter = 0;

// Each call returns a distinct IPv4-shaped string so tests that hit
// rate-limited endpoints (routes/auth.js's authRateLimiter) don't share a
// bucket with other tests running in the same `npm test` invocation.
function nextTestIp() {
  counter += 1;
  return `10.123.${Math.floor(counter / 255) % 255}.${counter % 255}`;
}

module.exports = { nextTestIp };
```

Every test below that calls `/api/auth/signup` or `/api/auth/login` (directly, or indirectly via a helper like `signupAgent`) chains `.set('X-Forwarded-For', testIp)` on those specific calls, using one `testIp` obtained via `nextTestIp()` per test.

- [ ] **Step 8: Commit**

```
git add package.json package-lock.json server.js test/server.test.js test/helpers/testIp.js
git commit -m "Add node:test + supertest tooling, make server.js testable, add per-test IP helper"
```

---

## Task 2: DB schema — `users`, `wishlist_items`, `owned_games`

**Files:**
- Modify: `services/db.js:17-50` (`init()` function)
- Create: `test/db.test.js`

**Interfaces:**
- Produces: three tables — `users(id UUID, email, password_hash, preferences JSONB, created_at)`, `wishlist_items(user_id UUID, itad_id, added_at)`, `owned_games(user_id UUID, itad_id, source, added_at)` — consumed by `services/auth.js` and `services/wishlist.js` in later tasks.

- [ ] **Step 1: Add the three tables to `init()`**

In `services/db.js`, add inside the template string in `init()` (after the existing `igdb_ratings` table, before the closing `` ` ``):

```sql

    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      preferences   JSONB DEFAULT '{}',
      created_at    TIMESTAMPTZ DEFAULT NOW()
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
```

- [ ] **Step 2: Write the failing test**

Create `test/db.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { pool, init } = require('../services/db');

test('init() creates users, wishlist_items, owned_games with expected columns', async () => {
  await init();

  const { rows } = await pool.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_name IN ('users', 'wishlist_items', 'owned_games')
    ORDER BY table_name, ordinal_position
  `);

  const byTable = {};
  for (const r of rows) {
    (byTable[r.table_name] ??= []).push(r.column_name);
  }

  assert.deepStrictEqual(byTable.users, ['id', 'email', 'password_hash', 'preferences', 'created_at']);
  assert.deepStrictEqual(byTable.wishlist_items, ['user_id', 'itad_id', 'added_at']);
  assert.deepStrictEqual(byTable.owned_games, ['user_id', 'itad_id', 'source', 'added_at']);
});
```

- [ ] **Step 3: Run it to verify it fails first (before Step 1 lands, or re-check by temporarily reverting)**

If Step 1 is already applied, instead just run it now and confirm it passes — the important check is that the column lists are exact:

```
npm test
```

Expected: `test/db.test.js` passes.

- [ ] **Step 4: Commit**

```
git add services/db.js test/db.test.js
git commit -m "Add users, wishlist_items, owned_games tables"
```

---

## Task 3: Password hashing (`services/auth.js`, part 1)

**Files:**
- Modify: `package.json`
- Create: `services/auth.js`
- Create: `test/auth.test.js`

**Interfaces:**
- Produces: `hashPassword(password: string): Promise<string>`, `verifyPassword(password: string, hash: string): Promise<boolean>` — consumed by `routes/auth.js` in Task 6.

- [ ] **Step 1: Add `bcrypt` dependency**

```
npm install bcrypt@^5.1.1
```

- [ ] **Step 2: Write the failing test**

Create `test/auth.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword } = require('../services/auth');

test('hashPassword produces a bcrypt hash distinct from the input, and verifyPassword round-trips', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.notStrictEqual(hash, 'correct horse battery staple');
  assert.match(hash, /^\$2[aby]\$12\$/); // cost factor 12

  assert.strictEqual(await verifyPassword('correct horse battery staple', hash), true);
  assert.strictEqual(await verifyPassword('wrong password', hash), false);
});

test('hashPassword salts each call, producing different hashes for the same password', async () => {
  const [h1, h2] = await Promise.all([hashPassword('same password'), hashPassword('same password')]);
  assert.notStrictEqual(h1, h2);
});
```

- [ ] **Step 3: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `Cannot find module '../services/auth'`.

- [ ] **Step 4: Create `services/auth.js` with the hashing functions**

```js
const bcrypt = require('bcrypt');

const BCRYPT_COST = 12;

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

module.exports = { hashPassword, verifyPassword };
```

- [ ] **Step 5: Run test to verify it passes**

```
npm test
```

Expected: `test/auth.test.js` passes (2 tests).

- [ ] **Step 6: Commit**

```
git add package.json package-lock.json services/auth.js test/auth.test.js
git commit -m "Add bcrypt password hashing helpers"
```

---

## Task 4: User CRUD (`services/auth.js`, part 2)

**Files:**
- Modify: `services/auth.js`
- Modify: `test/auth.test.js`

**Interfaces:**
- Consumes: `pool` from `services/db.js` (`const { pool } = require('./db')`).
- Produces: `createUser(email, passwordHash): Promise<{id, email, preferences, created_at}>` (rejects with `.code === '23505'` on duplicate email), `findUserByEmail(email): Promise<user|null>` (includes `password_hash`), `findUserById(id): Promise<{id,email,preferences,created_at}|null>`, `updatePasswordHash(id, passwordHash): Promise<void>`, `updatePreferences(id, preferences): Promise<object>`, `deleteUser(id): Promise<void>` — all consumed by `routes/auth.js` (Task 6) and `routes/me.js` (Task 7).

- [ ] **Step 1: Write the failing tests**

Append to `test/auth.test.js`:

```js
const { pool } = require('../services/db');
const {
  createUser, findUserByEmail, findUserById,
  updatePasswordHash, updatePreferences, deleteUser,
} = require('../services/auth');

test('createUser + findUserByEmail + findUserById + updatePreferences + updatePasswordHash + deleteUser', async () => {
  const email = `crud-test-${Date.now()}@example.com`;
  const hash = await hashPassword('initial-password');

  const created = await createUser(email, hash);
  assert.strictEqual(created.email, email);
  assert.deepStrictEqual(created.preferences, {});

  const byEmail = await findUserByEmail(email);
  assert.strictEqual(byEmail.id, created.id);
  assert.strictEqual(byEmail.password_hash, hash);

  const byId = await findUserById(created.id);
  assert.strictEqual(byId.email, email);
  assert.strictEqual('password_hash' in byId, false); // never expose the hash from findUserById

  const savedPrefs = await updatePreferences(created.id, { region: 'us' });
  assert.deepStrictEqual(savedPrefs, { region: 'us' });

  const newHash = await hashPassword('new-password');
  await updatePasswordHash(created.id, newHash);
  const afterPwUpdate = await findUserByEmail(email);
  assert.strictEqual(afterPwUpdate.password_hash, newHash);

  await deleteUser(created.id);
  assert.strictEqual(await findUserById(created.id), null);
});

test('createUser rejects a duplicate email with a Postgres unique_violation', async () => {
  const email = `dup-test-${Date.now()}@example.com`;
  const hash = await hashPassword('password123');
  const first = await createUser(email, hash);

  await assert.rejects(
    () => createUser(email, hash),
    err => err.code === '23505'
  );

  await deleteUser(first.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `createUser is not a function`.

- [ ] **Step 3: Implement the CRUD functions**

Append to `services/auth.js`:

```js
const { pool } = require('./db');

async function createUser(email, passwordHash) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     RETURNING id, email, preferences, created_at`,
    [email, passwordHash]
  );
  return rows[0];
}

async function findUserByEmail(email) {
  const { rows } = await pool.query(
    'SELECT id, email, password_hash, preferences, created_at FROM users WHERE email = $1',
    [email]
  );
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await pool.query(
    'SELECT id, email, preferences, created_at FROM users WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

async function updatePasswordHash(id, passwordHash) {
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
}

async function updatePreferences(id, preferences) {
  const { rows } = await pool.query(
    'UPDATE users SET preferences = $1 WHERE id = $2 RETURNING preferences',
    [JSON.stringify(preferences), id]
  );
  return rows[0]?.preferences;
}

async function deleteUser(id) {
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
}
```

And update the final `module.exports` in `services/auth.js` to:

```js
module.exports = {
  hashPassword, verifyPassword,
  createUser, findUserByEmail, findUserById,
  updatePasswordHash, updatePreferences, deleteUser,
};
```

- [ ] **Step 4: Run test to verify it passes**

```
npm test
```

Expected: all tests in `test/auth.test.js` pass (4 tests).

- [ ] **Step 5: Commit**

```
git add services/auth.js test/auth.test.js
git commit -m "Add user CRUD functions"
```

---

## Task 5: Redis-backed sessions (`middleware/session.js`)

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Create: `middleware/session.js`
- Create: `test/session.test.js`

**Interfaces:**
- Consumes: `redis` from `services/cache.js` (`const { redis } = require('../services/cache')`).
- Produces: `sessionMiddleware` (an Express middleware — mount with `app.use(sessionMiddleware)`), `requireAuth(req, res, next)` (401s if `req.session.userId` is unset) — both consumed by `server.js` (Task 6) and `routes/me.js` (Task 7, 10).

- [ ] **Step 1: Add dependencies**

```
npm install express-session@^1.18.1 connect-redis@^6.1.3
```

- [ ] **Step 2: Add `SESSION_SECRET` to `.env.example`**

Append to `.env.example`:

```
# Secret used to sign session cookies. Generate one with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=
```

Set a real value in your local `.env` before continuing — `express-session` throws at startup if `secret` is undefined.

- [ ] **Step 3: Write the failing test**

Create `test/session.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { sessionMiddleware, requireAuth } = require('../middleware/session');

test('requireAuth blocks requests with no session userId, allows requests with one', async () => {
  const app = express();
  app.use(sessionMiddleware);
  app.get('/anon-ok', (req, res) => res.json({ hasSession: !!req.session }));
  app.post('/login-stub', (req, res) => { req.session.userId = 'test-user-id'; res.json({ ok: true }); });
  app.get('/whoami', requireAuth, (req, res) => res.json({ userId: req.session.userId }));

  const anonRes = await request(app).get('/anon-ok');
  assert.strictEqual(anonRes.status, 200);
  assert.strictEqual(anonRes.body.hasSession, true);

  const blocked = await request(app).get('/whoami');
  assert.strictEqual(blocked.status, 401);

  const agent = request.agent(app);
  await agent.post('/login-stub').expect(200);
  const allowed = await agent.get('/whoami');
  assert.strictEqual(allowed.status, 200);
  assert.strictEqual(allowed.body.userId, 'test-user-id');
});
```

- [ ] **Step 4: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `Cannot find module '../middleware/session'`.

- [ ] **Step 5: Implement `middleware/session.js`**

```js
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

module.exports = { sessionMiddleware, requireAuth };
```

- [ ] **Step 6: Run test to verify it passes**

```
npm test
```

Expected: `test/session.test.js` passes (1 test).

- [ ] **Step 7: Wire the middleware into `server.js`**

In `server.js`, add near the other top-of-file requires (after `const db = require('./services/db');`):

```js
const { sessionMiddleware } = require('./middleware/session');
```

And after `app.use(express.json({ limit: '16kb' }));` (currently line 24), add:

```js
app.use(sessionMiddleware);
```

- [ ] **Step 8: Manually confirm the server still starts**

```
npm start
```

Expected: same startup output as before, no errors from the new middleware. Stop with Ctrl+C.

- [ ] **Step 9: Commit**

```
git add package.json package-lock.json .env.example middleware/session.js test/session.test.js server.js
git commit -m "Add Redis-backed session middleware"
```

---

## Task 6: Auth routes — signup, login, logout, me

**Files:**
- Create: `routes/auth.js`
- Modify: `server.js`
- Create: `test/auth-routes.test.js`

**Interfaces:**
- Consumes: `services/auth.js` (Tasks 3-4), `services/cache.js`'s `redis`, `req.session` (Task 5).
- Produces: mounted at `/api/auth` — `POST /signup`, `POST /login`, `POST /logout`, `GET /me`. Response shape on success: `{email, preferences}`.

- [ ] **Step 1: Write the failing tests**

Create `test/auth-routes.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { pool } = require('../services/db');
const { nextTestIp } = require('./helpers/testIp');

function uniqueEmail(tag) {
  return `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function cleanupUser(email) {
  await pool.query('DELETE FROM users WHERE email = $1', [email]);
}

test('signup: creates a user, sets a session cookie, rejects duplicates and weak input', async () => {
  const email = uniqueEmail('signup');
  const testIp = nextTestIp();
  const agent = request.agent(app);

  const ok = await agent.post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email, password: 'password123' });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.body.email, email);
  assert.deepStrictEqual(ok.body.preferences, {});

  const dup = await request(app).post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email, password: 'password123' });
  assert.strictEqual(dup.status, 409);

  const weakPw = await request(app).post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email: uniqueEmail('weak'), password: 'short' });
  assert.strictEqual(weakPw.status, 400);

  const badEmail = await request(app).post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email: 'not-an-email', password: 'password123' });
  assert.strictEqual(badEmail.status, 400);

  await cleanupUser(email);
});

test('login: succeeds with correct credentials, generic 401 on wrong password or unknown email', async () => {
  const email = uniqueEmail('login');
  const testIp = nextTestIp();
  await request(app).post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email, password: 'password123' }).expect(201);

  const wrongPw = await request(app).post('/api/auth/login').set('X-Forwarded-For', testIp).send({ email, password: 'wrong-password' });
  assert.strictEqual(wrongPw.status, 401);
  assert.strictEqual(wrongPw.body.error, 'Invalid email or password');

  const unknownEmail = await request(app).post('/api/auth/login').set('X-Forwarded-For', testIp).send({ email: uniqueEmail('nope'), password: 'password123' });
  assert.strictEqual(unknownEmail.status, 401);
  assert.strictEqual(unknownEmail.body.error, 'Invalid email or password');

  const ok = await request(app).post('/api/auth/login').set('X-Forwarded-For', testIp).send({ email, password: 'password123' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.email, email);

  await cleanupUser(email);
});

test('logout clears the session, and /me reflects logged-in vs logged-out state', async () => {
  const email = uniqueEmail('me');
  const testIp = nextTestIp();
  const agent = request.agent(app);

  const loggedOut = await agent.get('/api/auth/me');
  assert.strictEqual(loggedOut.status, 401);

  await agent.post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email, password: 'password123' }).expect(201);

  const loggedIn = await agent.get('/api/auth/me');
  assert.strictEqual(loggedIn.status, 200);
  assert.strictEqual(loggedIn.body.email, email);

  await agent.post('/api/auth/logout').expect(200);

  const afterLogout = await agent.get('/api/auth/me');
  assert.strictEqual(afterLogout.status, 401);

  await cleanupUser(email);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npm test
```

Expected: FAIL — `/api/auth/signup` returns 404 (route doesn't exist yet).

- [ ] **Step 3: Implement `routes/auth.js`**

```js
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
    res.status(201).json({ email: user.email, preferences: user.preferences });
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
    res.json({ email: user.email, preferences: user.preferences });
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
  const user = await auth.findUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ email: user.email, preferences: user.preferences });
});

module.exports = router;
```

- [ ] **Step 4: Mount the router in `server.js`**

Add near the other route requires at the top of `server.js`:

```js
const authRouter = require('./routes/auth');
```

Add right after `app.use(sessionMiddleware);`:

```js
app.use('/api/auth', authRouter);
```

- [ ] **Step 5: Run tests to verify they pass**

```
npm test
```

Expected: `test/auth-routes.test.js` passes (3 tests).

- [ ] **Step 6: Commit**

```
git add routes/auth.js server.js test/auth-routes.test.js
git commit -m "Add signup/login/logout/me auth routes"
```

---

## Task 7: Preferences endpoint

**Files:**
- Create: `routes/me.js`
- Modify: `server.js`
- Create: `test/me-preferences.test.js`

**Interfaces:**
- Consumes: `requireAuth` (Task 5), `auth.updatePreferences` (Task 4).
- Produces: mounted at `/api/me` — `PUT /preferences`, consumed by the frontend in Task 17.

- [ ] **Step 1: Write the failing test**

Create `test/me-preferences.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { pool } = require('../services/db');
const { nextTestIp } = require('./helpers/testIp');

test('PUT /api/me/preferences requires auth and persists a preferences object', async () => {
  const anon = await request(app).put('/api/me/preferences').send({ region: 'us' });
  assert.strictEqual(anon.status, 401);

  const email = `prefs-test-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email, password: 'password123' }).expect(201);

  const invalid = await agent.put('/api/me/preferences').send([1, 2, 3]);
  assert.strictEqual(invalid.status, 400);

  const saved = await agent.put('/api/me/preferences').send({ region: 'de', deviceIds: ['abc'] });
  assert.strictEqual(saved.status, 200);
  assert.deepStrictEqual(saved.body.preferences, { region: 'de', deviceIds: ['abc'] });

  const me = await agent.get('/api/auth/me');
  assert.deepStrictEqual(me.body.preferences, { region: 'de', deviceIds: ['abc'] });

  await pool.query('DELETE FROM users WHERE email = $1', [email]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `PUT /api/me/preferences` returns 404.

- [ ] **Step 3: Implement `routes/me.js`**

```js
const express = require('express');
const { requireAuth } = require('../middleware/session');
const auth = require('../services/auth');

const router = express.Router();
router.use(requireAuth);

router.put('/preferences', async (req, res) => {
  const prefs = req.body;
  if (typeof prefs !== 'object' || prefs === null || Array.isArray(prefs)) {
    return res.status(400).json({ error: 'preferences must be an object' });
  }
  try {
    const saved = await auth.updatePreferences(req.session.userId, prefs);
    res.json({ preferences: saved });
  } catch (e) {
    console.error('[/api/me/preferences]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
```

- [ ] **Step 4: Mount the router in `server.js`**

Add near the other route requires:

```js
const meRouter = require('./routes/me');
```

Add right after `app.use('/api/auth', authRouter);`:

```js
app.use('/api/me', meRouter);
```

- [ ] **Step 5: Run test to verify it passes**

```
npm test
```

Expected: `test/me-preferences.test.js` passes.

- [ ] **Step 6: Commit**

```
git add routes/me.js server.js test/me-preferences.test.js
git commit -m "Add PUT /api/me/preferences endpoint"
```

---

## Task 8: Wishlist/owned DB service

**Files:**
- Create: `services/wishlist.js`
- Create: `test/wishlist-service.test.js`

**Interfaces:**
- Consumes: `pool` from `services/db.js`.
- Produces: `addWishlistItem(userId, itadId)`, `removeWishlistItem(userId, itadId)`, `listWishlistItadIds(userId): Promise<string[]>`, `addOwned(userId, itadId, source = 'manual')` (also deletes any `wishlist_items` row for the same `userId`/`itadId` — owning a game always implies not wanting it on the wishlist, regardless of how either state was set), `removeOwned(userId, itadId)`, `listOwnedItadIds(userId): Promise<string[]>` — consumed by `routes/me.js` in Task 10 and the hide-owned filter in Task 11.

- [ ] **Step 1: Write the failing test**

Create `test/wishlist-service.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { pool } = require('../services/db');
const { createUser, deleteUser, hashPassword } = require('../services/auth');
const {
  addWishlistItem, removeWishlistItem, listWishlistItadIds,
  addOwned, removeOwned, listOwnedItadIds,
} = require('../services/wishlist');

async function makeTestUser(tag) {
  const email = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  return createUser(email, await hashPassword('password123'));
}

test('wishlist add/list/remove is idempotent and scoped per user', async () => {
  const user = await makeTestUser('wish-svc');
  const itadId = 'itad-test-aaa';

  await addWishlistItem(user.id, itadId);
  await addWishlistItem(user.id, itadId); // duplicate add must not throw
  assert.deepStrictEqual(await listWishlistItadIds(user.id), [itadId]);

  await removeWishlistItem(user.id, itadId);
  assert.deepStrictEqual(await listWishlistItadIds(user.id), []);

  await deleteUser(user.id);
});

test('owned add/list/remove defaults source to manual', async () => {
  const user = await makeTestUser('owned-svc');
  const itadId = 'itad-test-bbb';

  await addOwned(user.id, itadId);
  const { rows } = await pool.query('SELECT source FROM owned_games WHERE user_id = $1 AND itad_id = $2', [user.id, itadId]);
  assert.strictEqual(rows[0].source, 'manual');
  assert.deepStrictEqual(await listOwnedItadIds(user.id), [itadId]);

  await removeOwned(user.id, itadId);
  assert.deepStrictEqual(await listOwnedItadIds(user.id), []);

  await deleteUser(user.id);
});

test('addOwned removes any existing wishlist entry for the same game', async () => {
  const user = await makeTestUser('owned-wishlist-svc');
  const itadId = 'itad-test-ccc';

  await addWishlistItem(user.id, itadId);
  assert.deepStrictEqual(await listWishlistItadIds(user.id), [itadId]);

  await addOwned(user.id, itadId);
  assert.deepStrictEqual(await listOwnedItadIds(user.id), [itadId]);
  assert.deepStrictEqual(await listWishlistItadIds(user.id), []); // owning it clears the wishlist entry

  await deleteUser(user.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `Cannot find module '../services/wishlist'`.

- [ ] **Step 3: Implement `services/wishlist.js`**

```js
const { pool } = require('./db');

async function addWishlistItem(userId, itadId) {
  await pool.query(
    `INSERT INTO wishlist_items (user_id, itad_id) VALUES ($1, $2)
     ON CONFLICT (user_id, itad_id) DO NOTHING`,
    [userId, itadId]
  );
}

async function removeWishlistItem(userId, itadId) {
  await pool.query('DELETE FROM wishlist_items WHERE user_id = $1 AND itad_id = $2', [userId, itadId]);
}

async function listWishlistItadIds(userId) {
  const { rows } = await pool.query(
    'SELECT itad_id FROM wishlist_items WHERE user_id = $1 ORDER BY added_at DESC',
    [userId]
  );
  return rows.map(r => r.itad_id);
}

// Owning a game always implies it shouldn't stay on the wishlist, regardless
// of how it got there (manually added, or previously imported from Steam).
async function addOwned(userId, itadId, source = 'manual') {
  await pool.query(
    `INSERT INTO owned_games (user_id, itad_id, source) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, itad_id) DO NOTHING`,
    [userId, itadId, source]
  );
  await removeWishlistItem(userId, itadId);
}

async function removeOwned(userId, itadId) {
  await pool.query('DELETE FROM owned_games WHERE user_id = $1 AND itad_id = $2', [userId, itadId]);
}

async function listOwnedItadIds(userId) {
  const { rows } = await pool.query(
    'SELECT itad_id FROM owned_games WHERE user_id = $1 ORDER BY added_at DESC',
    [userId]
  );
  return rows.map(r => r.itad_id);
}

module.exports = {
  addWishlistItem, removeWishlistItem, listWishlistItadIds,
  addOwned, removeOwned, listOwnedItadIds,
};
```

- [ ] **Step 4: Run test to verify it passes**

```
npm test
```

Expected: `test/wishlist-service.test.js` passes (3 tests).

- [ ] **Step 5: Commit**

```
git add services/wishlist.js test/wishlist-service.test.js
git commit -m "Add wishlist/owned DB service"
```

---

## Task 9: Price lookup by `itad_id` (`services/store.js`)

**Files:**
- Modify: `services/store.js`
- Create: `test/store-itad-ids.test.js`

**Interfaces:**
- Consumes: `pool`, `redis`, `fetchOverviewAPI`, `toNum`, `REGIONS`, `OVERVIEW_TTL` — all already defined in `services/store.js`.
- Produces: `getDealsForItadIds(itadIds, cc, shops): Promise<Map<itadId, dealEntry>>` and `buildItadIdEntry(itadId, titleRow, item, cc): dealEntry` (exported specifically so it can be unit-tested without a live ITAD API call) — consumed by `routes/me.js` in Task 10.

This mirrors `getDealsForTitles` but looks games up directly by `itad_id` (wishlist/owned rows already store the ITAD id, so there's no title-matching step). The network-calling half (`fetchOverviewAPI`) already has no automated tests anywhere in this codebase (`getDealsForTitles` doesn't either) — introducing an HTTP-mocking library isn't in scope for this plan's testing decision, which was about auth/session/wishlist logic. Instead, the pure assembly logic is factored into `buildItadIdEntry` and tested directly with a synthetic ITAD overview object, and the network-calling path is verified manually in Step 6.

- [ ] **Step 1: Write the failing test**

Create `test/store-itad-ids.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { buildItadIdEntry } = require('../services/store');

test('buildItadIdEntry formats a discounted entry with historical low', () => {
  const item = {
    current: {
      price: { amount: '19.99', currency: 'USD' },
      regular: { amount: '39.99' },
      cut: 50,
      shop: { name: 'Steam' },
      url: 'https://store.steampowered.com/app/123',
      timestamp: '2026-01-01T00:00:00Z',
      expiry: null,
    },
    lowest: {
      price: { amount: '9.99' },
      cut: 75,
      shop: { name: 'GOG' },
      timestamp: '2025-06-01T00:00:00Z',
    },
  };
  const titleRow = { match_title: 'Example Game', steam_app_id: '123', image_url: 'https://example.com/img.jpg' };

  const entry = buildItadIdEntry('itad-uuid-1', titleRow, item, 'us');

  assert.strictEqual(entry.appId, 'itad-uuid-1');
  assert.strictEqual(entry.name, 'Example Game');
  assert.strictEqual(entry.price, 19.99);
  assert.strictEqual(entry.priceFormatted, '$19.99');
  assert.strictEqual(entry.discountPercent, 50);
  assert.strictEqual(entry.historicalLow.priceFormatted, '$9.99');
});

test('buildItadIdEntry falls back to sane defaults when titleRow/lowest are missing', () => {
  const item = { current: { price: { amount: '0' }, cut: 0, shop: {}, url: '' }, lowest: null };
  const entry = buildItadIdEntry('itad-uuid-2', undefined, item, 'us');
  assert.strictEqual(entry.name, '');
  assert.strictEqual(entry.priceFormatted, 'Free');
  assert.strictEqual(entry.historicalLow, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `buildItadIdEntry is not a function`.

- [ ] **Step 3: Implement in `services/store.js`**

Add before the `module.exports` line at the end of `services/store.js`:

```js
// ── Price lookup by itad_id (wishlist/owned games) ────────────────────────────
function buildItadIdEntry(itadId, titleRow, item, cc) {
  const sym = REGIONS[cc]?.sym ?? '$';
  const current = item.current;
  const lowest = item.lowest ?? null;
  const price = toNum(current.price?.amount);
  const originalPrice = toNum(current.regular?.amount ?? current.price?.amount);

  return {
    appId: itadId,
    name: titleRow?.match_title ?? '',
    steamAppId: titleRow?.steam_app_id ?? null,
    storeName: current.shop?.name ?? 'Store',
    imageUrl: titleRow?.image_url ?? '',
    storeUrl: current.url,
    discountPercent: current.cut ?? 0,
    price,
    originalPrice,
    priceFormatted: price === 0 ? 'Free' : `${sym}${price.toFixed(2)}`,
    originalPriceFormatted: (current.cut ?? 0) > 0 ? `${sym}${originalPrice.toFixed(2)}` : '',
    currency: current.price?.currency ?? cc.toUpperCase(),
    dealSince: current.timestamp ?? null,
    dealExpiry: current.expiry ?? null,
    historicalLow: lowest ? {
      price: toNum(lowest.price?.amount),
      cut: lowest.cut ?? 0,
      shop: lowest.shop?.name ?? '',
      timestamp: lowest.timestamp ?? null,
      priceFormatted: toNum(lowest.price?.amount) === 0
        ? 'Free'
        : `${sym}${toNum(lowest.price?.amount).toFixed(2)}`,
    } : null,
  };
}

async function getDealsForItadIds(itadIds, cc = 'us', shops = []) {
  if (!itadIds.length) return new Map();
  const shopsKey = shops.length ? shops.slice().sort().join(',') : 'all';

  const { rows } = await pool.query(
    'SELECT itad_id, match_title, steam_app_id, image_url FROM game_titles WHERE itad_id = ANY($1)',
    [itadIds]
  );
  const titleByItadId = new Map(rows.map(r => [r.itad_id, r]));

  const overviewKey = `store:overview:${cc}:${shopsKey}`;
  const overviewRaw = await redis.get(overviewKey);
  const overviewMap = overviewRaw ? new Map(JSON.parse(overviewRaw)) : new Map();

  const missing = itadIds.filter(id => !overviewMap.has(id));
  if (missing.length) {
    const pairs = await fetchOverviewAPI(missing, cc, shops);
    pairs.forEach(([id, item]) => overviewMap.set(id, item));
    await redis.set(overviewKey, JSON.stringify([...overviewMap.entries()]), 'PX', OVERVIEW_TTL);
  }

  const result = new Map();
  for (const itadId of itadIds) {
    const item = overviewMap.get(itadId);
    if (!item?.current) continue;
    result.set(itadId, buildItadIdEntry(itadId, titleByItadId.get(itadId), item, cc));
  }
  return result;
}
```

Update the `module.exports` at the end of `services/store.js` to:

```js
module.exports = { getDealsForTitles, getDealsForItadIds, buildItadIdEntry, getShops, clearCache, REGIONS, STEAM_SHOP_ID };
```

- [ ] **Step 4: Run test to verify it passes**

```
npm test
```

Expected: `test/store-itad-ids.test.js` passes (2 tests).

- [ ] **Step 5: Commit**

```
git add services/store.js test/store-itad-ids.test.js
git commit -m "Add itad_id-keyed price lookup for wishlist/owned games"
```

- [ ] **Step 6: Manual verification of the network-calling path**

This step has no automated test — it exercises live ITAD API calls, same as the untested `getDealsForTitles`. Verify manually once Task 10 wires this into a route (defer running this check until Task 10, Step 6).

---

## Task 10: Wishlist/owned routes

**Files:**
- Modify: `routes/me.js`
- Create: `test/me-wishlist-owned.test.js`

**Interfaces:**
- Consumes: `services/wishlist.js` (Task 8), `store.getDealsForItadIds` (Task 9).
- Produces: mounted under `/api/me` — `GET /wishlist`, `POST /wishlist/:itadId`, `DELETE /wishlist/:itadId`, `GET /owned`, `POST /owned/:itadId`, `DELETE /owned/:itadId`. `GET` responses: `{games: [dealEntry, ...]}`.

- [ ] **Step 1: Write the failing test**

Create `test/me-wishlist-owned.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { pool } = require('../services/db');
const { redis } = require('../services/cache');
const { nextTestIp } = require('./helpers/testIp');

async function seedGameTitleAndOverview(itadId, steamAppId) {
  await pool.query(
    `INSERT INTO game_titles (title_lower, itad_id, match_title, steam_app_id, image_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (title_lower) DO UPDATE SET itad_id = EXCLUDED.itad_id, steam_app_id = EXCLUDED.steam_app_id`,
    [`test wishlist game ${itadId}`, itadId, `Test Wishlist Game ${itadId}`, steamAppId, 'https://example.com/img.jpg']
  );
  const overviewEntry = {
    current: {
      price: { amount: '9.99', currency: 'USD' },
      regular: { amount: '19.99' },
      cut: 50,
      shop: { name: 'Steam' },
      url: `https://store.steampowered.com/app/${steamAppId}`,
    },
    lowest: null,
  };
  await redis.set('store:overview:us:all', JSON.stringify([[itadId, overviewEntry]]), 'PX', 60000);
}

async function cleanup(email, itadId) {
  await pool.query('DELETE FROM users WHERE email = $1', [email]);
  await pool.query('DELETE FROM game_titles WHERE itad_id = $1', [itadId]);
  await redis.del('store:overview:us:all');
}

test('wishlist: unauthenticated requests are rejected, authenticated add/list/remove works', async () => {
  const anon = await request(app).get('/api/me/wishlist');
  assert.strictEqual(anon.status, 401);

  const itadId = `itad-wishlist-test-${Date.now()}`;
  await seedGameTitleAndOverview(itadId, '900001');

  const email = `wishlist-route-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email, password: 'password123' }).expect(201);

  await agent.post(`/api/me/wishlist/${itadId}`).expect(204);

  const list1 = await agent.get('/api/me/wishlist');
  assert.strictEqual(list1.status, 200);
  assert.strictEqual(list1.body.games.length, 1);
  assert.strictEqual(list1.body.games[0].appId, itadId);
  assert.strictEqual(list1.body.games[0].name, `Test Wishlist Game ${itadId}`);

  await agent.delete(`/api/me/wishlist/${itadId}`).expect(204);
  const list2 = await agent.get('/api/me/wishlist');
  assert.strictEqual(list2.body.games.length, 0);

  await cleanup(email, itadId);
});

test('owned: add/list/remove works, and marking owned removes the game from the wishlist', async () => {
  const itadId = `itad-owned-test-${Date.now()}`;
  await seedGameTitleAndOverview(itadId, '900002');

  const email = `owned-route-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email, password: 'password123' }).expect(201);

  // Wishlist it first, to prove marking it owned clears the wishlist entry.
  await agent.post(`/api/me/wishlist/${itadId}`).expect(204);

  await agent.post(`/api/me/owned/${itadId}`).expect(204);
  const owned = await agent.get('/api/me/owned');
  assert.strictEqual(owned.body.games.length, 1);

  const wishlist = await agent.get('/api/me/wishlist');
  assert.strictEqual(wishlist.body.games.length, 0); // owning it cleared the wishlist entry

  await agent.delete(`/api/me/owned/${itadId}`).expect(204);
  const ownedAfter = await agent.get('/api/me/owned');
  assert.strictEqual(ownedAfter.body.games.length, 0);

  await cleanup(email, itadId);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `GET /api/me/wishlist` returns 404.

- [ ] **Step 3: Add the routes to `routes/me.js`**

Add near the top of `routes/me.js`, alongside the existing requires:

```js
const wishlist = require('../services/wishlist');
const store = require('../services/store');
```

Add after the `/preferences` route, before `module.exports`:

```js
async function listWithCards(itadIds, cc) {
  if (!itadIds.length) return [];
  const dealMap = await store.getDealsForItadIds(itadIds, cc, []);
  return itadIds.map(id => dealMap.get(id)).filter(Boolean);
}

router.get('/wishlist', async (req, res) => {
  try {
    const itadIds = await wishlist.listWishlistItadIds(req.session.userId);
    const games = await listWithCards(itadIds, req.query.cc || 'us');
    res.json({ games });
  } catch (e) {
    console.error('[/api/me/wishlist]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/wishlist/:itadId', async (req, res) => {
  await wishlist.addWishlistItem(req.session.userId, req.params.itadId);
  res.status(204).end();
});

router.delete('/wishlist/:itadId', async (req, res) => {
  await wishlist.removeWishlistItem(req.session.userId, req.params.itadId);
  res.status(204).end();
});

router.get('/owned', async (req, res) => {
  try {
    const itadIds = await wishlist.listOwnedItadIds(req.session.userId);
    const games = await listWithCards(itadIds, req.query.cc || 'us');
    res.json({ games });
  } catch (e) {
    console.error('[/api/me/owned]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/owned/:itadId', async (req, res) => {
  await wishlist.addOwned(req.session.userId, req.params.itadId);
  res.status(204).end();
});

router.delete('/owned/:itadId', async (req, res) => {
  await wishlist.removeOwned(req.session.userId, req.params.itadId);
  res.status(204).end();
});
```

- [ ] **Step 4: Run test to verify it passes**

```
npm test
```

Expected: `test/me-wishlist-owned.test.js` passes (2 tests).

- [ ] **Step 5: Commit**

```
git add routes/me.js test/me-wishlist-owned.test.js
git commit -m "Add wishlist/owned CRUD routes"
```

- [ ] **Step 6: Manually verify the live-network path from Task 9**

With the dev server running (`npm start`) and a real wishlisted game (one actually in `game_titles` from normal app usage), hit `GET /api/me/wishlist` (with a valid session cookie from a browser login) and confirm price data comes back correctly when the Redis overview cache is cold — this exercises `fetchOverviewAPI` for real.

- [ ] **Step 7: Update the API table in `README.md`**

Add rows to the existing `## API` table in `README.md` (after the `POST /api/refresh` row):

```markdown
| `POST /api/auth/signup` | Create an account (params: `email`, `password`) |
| `POST /api/auth/login` | Log in (params: `email`, `password`) |
| `POST /api/auth/logout` | Log out |
| `GET /api/auth/me` | Current user's email + preferences, or `401` |
| `PUT /api/me/preferences` | Save filter preferences for the logged-in user |
| `GET /api/me/wishlist` | Logged-in user's wishlisted games |
| `POST /api/me/wishlist/:itadId` | Add a game to the wishlist |
| `DELETE /api/me/wishlist/:itadId` | Remove a game from the wishlist |
| `GET /api/me/owned` | Logged-in user's owned games |
| `POST /api/me/owned/:itadId` | Mark a game as owned |
| `DELETE /api/me/owned/:itadId` | Unmark a game as owned |
```

- [ ] **Step 8: Commit**

```
git add README.md
git commit -m "Document account/wishlist/owned API endpoints"
```

---

## Task 11: Hide-owned filter on `/api/games`

**Files:**
- Create: `services/gameFilters.js`
- Modify: `server.js`
- Create: `test/gameFilters.test.js`

**Interfaces:**
- Produces: `excludeOwned(games, ownedItadIds): games[]` — a pure function, unit-tested directly; wired into the existing `/api/games` handler in `server.js`.

Recall from `server.js` that each entry in the `/api/games` response already carries `appId: sg.appId`, and `sg.appId` is the ITAD id (`store.js` sets `appId: titleEntry.id`, where `titleEntry.id` is the resolved ITAD id — regardless of whether it was resolved via the exact Steam-App-ID path or the title-lookup fallback introduced by the exact-correlation rework) — so filtering by the user's owned `itad_id`s against `g.appId` requires no extra join.

- [ ] **Step 1: Write the failing test**

Create `test/gameFilters.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { excludeOwned } = require('../services/gameFilters');

test('excludeOwned removes games whose appId is in the owned set', () => {
  const games = [{ appId: 'a' }, { appId: 'b' }, { appId: 'c' }];
  assert.deepStrictEqual(excludeOwned(games, ['b']).map(g => g.appId), ['a', 'c']);
});

test('excludeOwned returns the input unchanged when ownedItadIds is empty', () => {
  const games = [{ appId: 'a' }];
  assert.deepStrictEqual(excludeOwned(games, []), games);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `Cannot find module '../services/gameFilters'`.

- [ ] **Step 3: Implement `services/gameFilters.js`**

```js
function excludeOwned(games, ownedItadIds) {
  if (!ownedItadIds || !ownedItadIds.length) return games;
  const ownedSet = new Set(ownedItadIds);
  return games.filter(g => !ownedSet.has(g.appId));
}

module.exports = { excludeOwned };
```

- [ ] **Step 4: Run test to verify it passes**

```
npm test
```

Expected: `test/gameFilters.test.js` passes (2 tests).

- [ ] **Step 5: Wire it into the `/api/games` handler in `server.js`**

Add near the other requires at the top of `server.js`:

```js
const { excludeOwned } = require('./services/gameFilters');
const wishlist = require('./services/wishlist');
```

In the `/api/games` handler, immediately after the existing `minRating` filter block (the block ending `filtered = filtered.filter(g => g.igdbRating?.igdbRating != null && ...)`), add:

```js
    if (req.session?.userId && req.query.hideOwned === '1') {
      const ownedIds = await wishlist.listOwnedItadIds(req.session.userId);
      filtered = excludeOwned(filtered, ownedIds);
    }
```

- [ ] **Step 6: Manually verify**

With the dev server running and a logged-in browser session that has at least one owned game marked (once Task 13's UI exists — for now, mark one via `curl`/Postman against `POST /api/me/owned/:itadId`), confirm `GET /api/games?...&hideOwned=1` excludes it and `hideOwned` omitted or `0` includes it.

- [ ] **Step 7: Commit**

```
git add services/gameFilters.js server.js test/gameFilters.test.js
git commit -m "Add hide-owned filter to /api/games"
```

---

## Task 12: Frontend — account menu + login/signup modal

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`
- Modify: `public/i18n.js`

**Interfaces:**
- Produces: `AuthState` object on `window`-scope in `app.js` (`{loggedIn, email, preferences}`), `refreshAuthState()` (calls `GET /api/auth/me`, updates the header UI), `openAuthModal(mode)` / `closeAuthModal()` — consumed by Tasks 13, 14, 15, 16, 17.

This task has no automated test (no frontend test tooling in this project, and none is being introduced — see Global Constraints). Verify manually via the `run` skill in a browser after each step.

- [ ] **Step 1: Add the login/signup modal markup to `public/index.html`**

Add immediately after the existing `<!-- Preferred Settings Modal -->` block (after its closing `</div>`, i.e. after current line 108's `</div>` that closes `prefDevicesModal`):

```html
<!-- Auth Modal -->
<div class="modal-overlay" id="authModal" hidden>
  <div class="modal">
    <div class="modal-header">
      <h2 data-i18n="authTitle">Log in</h2>
    </div>
    <div class="modal-body">
      <div class="auth-tabs">
        <button class="disc-btn active" id="authTabLogin" data-i18n="authTabLogin">Log in</button>
        <button class="disc-btn" id="authTabSignup" data-i18n="authTabSignup">Sign up</button>
      </div>
      <form id="authForm">
        <label class="filter-label" data-i18n="authEmailLabel">Email</label>
        <input type="email" id="authEmail" required autocomplete="username" style="width:100%;margin-top:.35rem" />
        <label class="filter-label" style="margin-top:.75rem;display:block" data-i18n="authPasswordLabel">Password</label>
        <input type="password" id="authPassword" required minlength="8" autocomplete="current-password" style="width:100%;margin-top:.35rem" />
        <div id="authError" class="auth-error" hidden></div>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn-modal-skip" id="authCancel" data-i18n="authCancel">Cancel</button>
      <button class="btn-modal-save" id="authSubmit" data-i18n="authSubmitLogin">Log in</button>
    </div>
  </div>
</div>
```

Replace the `<div class="lang-switcher">...</div>` block inside `<div class="header-actions">` — keep it, but add the account menu right after it (still inside `header-actions`):

```html
      <div class="account-menu" id="accountMenu">
        <button class="account-menu-btn" id="accountMenuBtn" data-i18n="logIn">Log in</button>
        <div class="account-dropdown" id="accountDropdown" hidden>
          <div class="account-email" id="accountEmailLabel"></div>
          <button data-view="wishlist" data-i18n="myWishlist">My Wishlist</button>
          <button data-view="owned" data-i18n="myGames">My Games</button>
          <button data-view="settings" data-i18n="accountSettings">Account Settings</button>
          <button id="logoutBtn" data-i18n="logOut">Log out</button>
        </div>
      </div>
```

- [ ] **Step 2: Add i18n keys**

In `public/i18n.js`, add to each of the `fr`, `en`, `de`, `es` objects (matching the existing per-language structure — English shown below; translate the values for the other three, keeping the same keys):

```js
    authTitle:            'Log in',
    authTabLogin:         'Log in',
    authTabSignup:        'Sign up',
    authEmailLabel:       'Email',
    authPasswordLabel:    'Password',
    authCancel:           'Cancel',
    authSubmitLogin:      'Log in',
    authSubmitSignup:     'Sign up',
    authInvalidCreds:     'Invalid email or password',
    authEmailTaken:       'Email already registered',
    logIn:                'Log in',
    logOut:               'Log out',
    myWishlist:           'My Wishlist',
    myGames:              'My Games',
    accountSettings:      'Account Settings',
```

- [ ] **Step 3: Add the auth state + modal logic to `public/app.js`**

Add after the `api` object definition (after its closing `};`, currently ending around line 99):

```js
Object.assign(api, {
  authMe()               { return api.json('/api/auth/me').catch(() => null); },
  authSignup(email, pw)  { return fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) }); },
  authLogin(email, pw)   { return fetch('/api/auth/login',  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) }); },
  authLogout()           { return fetch('/api/auth/logout', { method: 'POST' }); },
});

/* ── Auth state ────────────────────────────────────────────────────────────── */
const authState = { loggedIn: false, email: null, preferences: null };

async function refreshAuthState() {
  const res = await fetch('/api/auth/me');
  if (res.status === 200) {
    const body = await res.json();
    authState.loggedIn = true;
    authState.email = body.email;
    authState.preferences = body.preferences;
  } else {
    authState.loggedIn = false;
    authState.email = null;
    authState.preferences = null;
  }
  renderAuthMenu();
}

function renderAuthMenu() {
  const btn = $('accountMenuBtn');
  const emailLabel = $('accountEmailLabel');
  if (authState.loggedIn) {
    btn.textContent = authState.email;
    emailLabel.textContent = authState.email;
  } else {
    btn.textContent = t('logIn');
    emailLabel.textContent = '';
  }
}

/* ── Auth modal ────────────────────────────────────────────────────────────── */
const authEl = {
  modal:     $('authModal'),
  tabLogin:  $('authTabLogin'),
  tabSignup: $('authTabSignup'),
  email:     $('authEmail'),
  password:  $('authPassword'),
  error:     $('authError'),
  submit:    $('authSubmit'),
  cancel:    $('authCancel'),
};
let authMode = 'login';

function openAuthModal(mode = 'login') {
  authMode = mode;
  authEl.error.hidden = true;
  authEl.email.value = '';
  authEl.password.value = '';
  authEl.tabLogin.classList.toggle('active', mode === 'login');
  authEl.tabSignup.classList.toggle('active', mode === 'signup');
  authEl.submit.textContent = mode === 'login' ? t('authSubmitLogin') : t('authSubmitSignup');
  authEl.modal.hidden = false;
  authEl.email.focus();
}

function closeAuthModal() {
  authEl.modal.hidden = true;
}

function initAuthModal() {
  authEl.tabLogin.addEventListener('click', () => openAuthModal('login'));
  authEl.tabSignup.addEventListener('click', () => openAuthModal('signup'));
  authEl.cancel.addEventListener('click', closeAuthModal);

  authEl.submit.addEventListener('click', async () => {
    const email = authEl.email.value.trim();
    const password = authEl.password.value;
    authEl.error.hidden = true;

    const res = authMode === 'login'
      ? await api.authLogin(email, password)
      : await api.authSignup(email, password);

    if (res.status === 200 || res.status === 201) {
      await refreshAuthState();
      closeAuthModal();
      fetchGames(false);
      return;
    }
    const body = await res.json().catch(() => ({}));
    authEl.error.textContent = body.error || t('authInvalidCreds');
    authEl.error.hidden = false;
  });

  $('accountMenuBtn').addEventListener('click', () => {
    if (authState.loggedIn) {
      $('accountDropdown').hidden = !$('accountDropdown').hidden;
    } else {
      openAuthModal('login');
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    await api.authLogout();
    $('accountDropdown').hidden = true;
    await refreshAuthState();
    fetchGames(false);
  });
}
```

- [ ] **Step 4: Wire initialization into `init()`**

In `public/app.js`, inside `init()` (currently starting at line 119), add `initAuthModal();` and `await refreshAuthState();` right after `initPreferredDevicesModal();` (currently line 148):

```js
    initPreferredDevicesModal();
    initAuthModal();
    await refreshAuthState();
```

- [ ] **Step 5: Add styles**

Append to `public/style.css`:

```css
/* ── Account menu ─────────────────────────────────────────────────────────── */
.account-menu { position: relative; }
.account-menu-btn {
  background: transparent;
  border: 1px solid var(--border, #444);
  color: inherit;
  padding: .35rem .75rem;
  border-radius: 6px;
  cursor: pointer;
}
.account-dropdown {
  position: absolute;
  right: 0;
  top: 100%;
  margin-top: .35rem;
  background: var(--bg-elevated, #1e1e1e);
  border: 1px solid var(--border, #444);
  border-radius: 8px;
  min-width: 180px;
  display: flex;
  flex-direction: column;
  z-index: 50;
}
.account-dropdown button, .account-email {
  padding: .5rem .75rem;
  text-align: left;
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
}
.account-email { opacity: .7; font-size: .85rem; cursor: default; }
.account-dropdown button:hover { background: rgba(255,255,255,.08); }
.auth-tabs { display: flex; gap: .5rem; margin-bottom: .75rem; }
.auth-error { color: #e57373; margin-top: .5rem; font-size: .85rem; }
```

- [ ] **Step 6: Manual verification**

Start the app (`npm start`), open it in a browser: confirm the header shows "Log in", clicking it opens the modal, switching tabs changes the button label, signing up with a new email logs you in and the header shows your email, clicking your email opens the dropdown, "Log out" logs you out and reverts the header. Try logging in with a wrong password and confirm the generic error message shows.

- [ ] **Step 7: Commit**

```
git add public/index.html public/app.js public/style.css public/i18n.js
git commit -m "Add account menu and login/signup modal"
```

---

## Task 13: Frontend — wishlist/owned toggle buttons on game cards

**Files:**
- Modify: `public/app.js`
- Modify: `public/style.css`
- Modify: `public/i18n.js`

**Interfaces:**
- Consumes: `authState` (Task 12), `POST/DELETE /api/me/wishlist/:itadId` and `/api/me/owned/:itadId` (Task 10).
- Produces: buttons dispatch a custom event `wishlist-changed` / `owned-changed` on `document` — consumed by Task 14 (My Wishlist/My Games view) to know when to refresh.

- [ ] **Step 1: Add wishlist/owned API helpers**

In `public/app.js`, extend the `Object.assign(api, {...})` block added in Task 12, Step 3:

```js
  addWishlist(itadId)    { return fetch(`/api/me/wishlist/${encodeURIComponent(itadId)}`, { method: 'POST' }); },
  removeWishlist(itadId) { return fetch(`/api/me/wishlist/${encodeURIComponent(itadId)}`, { method: 'DELETE' }); },
  addOwned(itadId)       { return fetch(`/api/me/owned/${encodeURIComponent(itadId)}`, { method: 'POST' }); },
  removeOwned(itadId)    { return fetch(`/api/me/owned/${encodeURIComponent(itadId)}`, { method: 'DELETE' }); },
```

- [ ] **Step 2: Add the buttons to `buildCard()`**

In `public/app.js`, inside `buildCard(g)` (starting at line 1241), modify the `card-footer` markup to include two toggle buttons before the existing links:

```js
    <div class="card-footer">
      <button class="btn-wishlist${g.isWishlisted ? ' active' : ''}" data-itad-id="${escHtml(g.appId)}" data-kind="wishlist" ${authState.loggedIn ? '' : 'disabled title="' + escHtml(t('logInToTrack')) + '"'}>♥</button>
      <button class="btn-owned${g.isOwned ? ' active' : ''}" data-itad-id="${escHtml(g.appId)}" data-kind="owned" ${authState.loggedIn ? '' : 'disabled title="' + escHtml(t('logInToTrack')) + '"'}>✓</button>
      <a href="${escHtml(g.storeUrl)}" target="_blank" rel="noopener" class="btn-steam">
```

(Leave the rest of `card-footer` — the two existing `<a>` links — unchanged.)

After the existing `img.addEventListener('error', ...)` block in `buildCard`, before `return div;`, add the click handlers:

```js
  div.querySelectorAll('.btn-wishlist, .btn-owned').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!authState.loggedIn) return;
      const itadId = btn.dataset.itadId;
      const kind = btn.dataset.kind;
      const wasActive = btn.classList.contains('active');
      btn.classList.toggle('active', !wasActive); // optimistic

      // Marking owned always clears the wishlist too (backend enforces this
      // unconditionally in services/wishlist.js's addOwned) — reflect it
      // immediately in this card rather than waiting for a refetch.
      const wishlistBtn = div.querySelector('.btn-wishlist');
      const wishlistWasActive = wishlistBtn?.classList.contains('active');
      if (kind === 'owned' && !wasActive && wishlistBtn) {
        wishlistBtn.classList.remove('active');
      }

      const call = kind === 'wishlist'
        ? (wasActive ? api.removeWishlist(itadId) : api.addWishlist(itadId))
        : (wasActive ? api.removeOwned(itadId) : api.addOwned(itadId));
      try {
        await call;
        document.dispatchEvent(new CustomEvent(`${kind}-changed`, { detail: { itadId, active: !wasActive } }));
        if (kind === 'owned' && !wasActive && wishlistWasActive) {
          document.dispatchEvent(new CustomEvent('wishlist-changed', { detail: { itadId, active: false } }));
        }
      } catch {
        btn.classList.toggle('active', wasActive); // revert on failure
        if (kind === 'owned' && !wasActive && wishlistBtn && wishlistWasActive) {
          wishlistBtn.classList.add('active'); // revert the wishlist side-effect too
        }
      }
    });
  });
```

- [ ] **Step 3: `g.isWishlisted` / `g.isOwned` on `/api/games` results**

`buildCard` now reads `g.isWishlisted`/`g.isOwned`, but `/api/games` doesn't return those fields yet. In `server.js`, inside the `/api/games` handler, right after the `hideOwned` block added in Task 11 Step 5, add:

```js
    if (req.session?.userId) {
      const [wishlistIds, ownedIds] = await Promise.all([
        wishlist.listWishlistItadIds(req.session.userId),
        wishlist.listOwnedItadIds(req.session.userId),
      ]);
      const wishlistSet = new Set(wishlistIds);
      const ownedSet = new Set(ownedIds);
      filtered = filtered.map(g => ({ ...g, isWishlisted: wishlistSet.has(g.appId), isOwned: ownedSet.has(g.appId) }));
    }
```

- [ ] **Step 4: i18n key**

Add to each language object in `public/i18n.js`:

```js
    logInToTrack: 'Log in to track this game',
```

- [ ] **Step 5: Styles**

Append to `public/style.css`:

```css
.btn-wishlist, .btn-owned {
  border: 1px solid var(--border, #444);
  background: transparent;
  color: inherit;
  border-radius: 6px;
  padding: .25rem .5rem;
  cursor: pointer;
}
.btn-wishlist.active { color: #e05a7a; border-color: #e05a7a; }
.btn-owned.active { color: #4caf50; border-color: #4caf50; }
.btn-wishlist:disabled, .btn-owned:disabled { opacity: .35; cursor: not-allowed; }
```

- [ ] **Step 6: Manual verification**

With a logged-in session, click the heart/checkmark on a few cards, reload the page, and confirm the active state persists (comes from `g.isWishlisted`/`g.isOwned` on the next `/api/games` fetch). Log out and confirm both buttons appear greyed out with a tooltip, and clicking them does nothing. Also: wishlist a game, then click its owned button — confirm the heart deactivates immediately in the same card without a reload, and stays deactivated after a reload.

- [ ] **Step 7: Commit**

```
git add public/app.js public/style.css public/i18n.js server.js
git commit -m "Add wishlist/owned toggle buttons to game cards"
```

---

## Task 14: Frontend — My Wishlist / My Games view

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`
- Modify: `public/i18n.js`

**Interfaces:**
- Consumes: `GET /api/me/wishlist`, `GET /api/me/owned` (Task 10), `buildCard()` (Task 13), the `data-view` buttons added to the account dropdown in Task 12.

- [ ] **Step 1: Add a view container to `public/index.html`**

Add right after the closing `</div>` of `<div class="layout">`'s main content area (find the element with `id="gamesGrid"` and add a sibling section after its parent container — insert this immediately before the closing tag of the element that wraps `gamesGrid`, `resultsCount`, and `pagination`):

```html
<section id="trackedView" hidden>
  <h2 id="trackedViewTitle"></h2>
  <div class="grid" id="trackedGrid"></div>
  <div class="state-box" id="trackedEmpty" hidden>
    <div class="icon">🎮</div>
    <p id="trackedEmptyMsg"></p>
  </div>
</section>
```

- [ ] **Step 2: Add view-switching + fetch logic to `public/app.js`**

Add after `initAuthModal()`'s definition:

```js
/* ── Tracked view (My Wishlist / My Games) ───────────────────────────────────── */
async function openTrackedView(kind) {
  $('accountDropdown').hidden = true;
  document.querySelector('.layout').hidden = true;
  $('trackedView').hidden = false;
  $('trackedViewTitle').textContent = kind === 'wishlist' ? t('myWishlist') : t('myGames');

  const res = await fetch(kind === 'wishlist' ? '/api/me/wishlist' : '/api/me/owned');
  const body = await res.json();
  const grid = $('trackedGrid');
  grid.innerHTML = '';
  if (!body.games.length) {
    $('trackedEmpty').hidden = false;
    $('trackedEmptyMsg').textContent = kind === 'wishlist' ? t('emptyWishlistMsg') : t('emptyOwnedMsg');
    return;
  }
  $('trackedEmpty').hidden = true;
  body.games.forEach(g => grid.appendChild(buildCard({ ...g, gameName: g.name })));
}

function closeTrackedView() {
  $('trackedView').hidden = true;
  document.querySelector('.layout').hidden = false;
}

function initTrackedView() {
  document.querySelectorAll('#accountDropdown button[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === 'settings') { openAccountSettings(); return; }
      openTrackedView(view);
    });
  });

  document.addEventListener('wishlist-changed', () => {
    if (!$('trackedView').hidden && $('trackedViewTitle').textContent === t('myWishlist')) openTrackedView('wishlist');
  });
  document.addEventListener('owned-changed', () => {
    if (!$('trackedView').hidden && $('trackedViewTitle').textContent === t('myGames')) openTrackedView('owned');
  });
}
```

(`openAccountSettings` is implemented in Task 16 — leave the reference; it will exist by the time this runs since Task 16 comes before this is exercised in a real login session, and JS only resolves the reference at click time, not at parse time.)

- [ ] **Step 3: Wire initialization into `init()`**

In `init()`, add `initTrackedView();` right after `initAuthModal();` (added in Task 12, Step 4).

- [ ] **Step 4: i18n keys**

Add to each language object in `public/i18n.js`:

```js
    emptyWishlistMsg: "You haven't wishlisted any games yet.",
    emptyOwnedMsg:    "You haven't marked any games as owned yet.",
```

- [ ] **Step 5: Styles**

Append to `public/style.css`:

```css
#trackedView { padding: 1rem; }
#trackedView h2 { margin-bottom: 1rem; }
```

- [ ] **Step 6: Add a way back to the main view**

Add a "back" affordance — in `public/index.html`, inside the `#trackedView` section added in Step 1, add before the `<h2>`:

```html
  <button class="btn-modal-skip" id="trackedBackBtn" data-i18n="backToSearch">&larr; Back</button>
```

In `public/app.js`, in `initTrackedView()`, add:

```js
  $('trackedBackBtn').addEventListener('click', closeTrackedView);
```

Add the i18n key `backToSearch: '← Back to search'` (translate per language) to `public/i18n.js`.

- [ ] **Step 7: Manual verification**

Log in, wishlist 2-3 games from the main grid, open "My Wishlist" from the account menu, confirm they render as cards with live prices. Toggle one off from within the tracked view (the wishlist button on its card should still work there) and confirm the view refreshes. Click "Back" and confirm the main grid reappears unchanged. Repeat for "My Games" / owned.

- [ ] **Step 8: Commit**

```
git add public/index.html public/app.js public/style.css public/i18n.js
git commit -m "Add My Wishlist / My Games view"
```

---

## Task 15: Frontend — hide-owned filter checkbox

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/i18n.js`

**Interfaces:**
- Consumes: `hideOwned=1` query param support added to `/api/games` in Task 11.
- Produces: `state.filters.hideOwned` (boolean), read by `readFilters()` and sent by `fetchGames()`.

- [ ] **Step 1: Add the checkbox to the sidebar filters in `public/index.html`**

Add next to the existing "Historical low" checkbox (find the element with `id="histLowCheck"` and add this as a sibling right after its containing `<label>`):

```html
<label class="filter-checkbox" id="hideOwnedRow" hidden>
  <input type="checkbox" id="hideOwnedCheck" />
  <span data-i18n="hideOwnedFilter">Hide games I own</span>
</label>
```

(`hidden` by default — Step 4 reveals it only when logged in, since it's meaningless when logged out.)

- [ ] **Step 2: Add to `state.filters` and `el`**

In `public/app.js`, add `hideOwned: false,` to the `filters` object in `state` (after the `histLow: false,` line, currently line 23).

Add `hideOwnedCheck: $('hideOwnedCheck'),` and `hideOwnedRow: $('hideOwnedRow'),` to the `el` object (after the `histLowCheck` line, currently line 66).

- [ ] **Step 3: Read it in `readFilters()` and send it in `fetchGames()`**

In `readFilters()` (starting at line 1176), add after the `state.filters.histLow = el.histLowCheck.checked;` line:

```js
  state.filters.hideOwned = el.hideOwnedCheck.checked;
```

In `fetchGames()` (starting at line 1096), find where `state.filters` is spread into the params passed to `api.games(...)` and confirm `hideOwned` passes through automatically (it will, since `api.games` iterates `Object.entries(params)` — just needs the boolean converted to `'1'`/omitted). Change the call site to convert it:

```js
const { hideOwned, ...restFilters } = state.filters;
const params = { ...restFilters, hideOwned: hideOwned ? '1' : undefined };
```

Use `params` in place of `state.filters` wherever `fetchGames()` currently passes filters to `api.games(...)`.

- [ ] **Step 4: Show/hide the row based on login state**

In `renderAuthMenu()` (added in Task 12, Step 3), add:

```js
  el.hideOwnedRow.hidden = !authState.loggedIn;
```

- [ ] **Step 5: i18n key**

Add to each language object in `public/i18n.js`:

```js
    hideOwnedFilter: 'Hide games I own',
```

- [ ] **Step 6: Manual verification**

Log in, mark a game owned, check "Hide games I own", click Apply/search, confirm that game disappears from results. Uncheck and confirm it reappears. Log out and confirm the checkbox row is hidden entirely.

- [ ] **Step 7: Commit**

```
git add public/index.html public/app.js public/i18n.js
git commit -m "Add hide-owned filter checkbox"
```

---

## Task 16: Frontend — account settings page

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`
- Modify: `public/i18n.js`
- Create: `routes/me.js` additions (change password, delete account)
- Create: `test/me-account.test.js`

**Interfaces:**
- Produces backend: `PUT /api/me/password` (`{currentPassword, newPassword}`), `DELETE /api/me` — both under `requireAuth`.
- Produces frontend: `openAccountSettings()` (referenced from Task 14's dropdown wiring).

- [ ] **Step 1: Write the failing backend tests**

Create `test/me-account.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { pool } = require('../services/db');
const { nextTestIp } = require('./helpers/testIp');

test('PUT /api/me/password requires the current password and updates the hash', async () => {
  const email = `pw-change-${Date.now()}@example.com`;
  const testIp = nextTestIp();
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email, password: 'password123' }).expect(201);

  const wrongCurrent = await agent.put('/api/me/password').send({ currentPassword: 'nope', newPassword: 'newpassword456' });
  assert.strictEqual(wrongCurrent.status, 401);

  const ok = await agent.put('/api/me/password').send({ currentPassword: 'password123', newPassword: 'newpassword456' });
  assert.strictEqual(ok.status, 200);

  await agent.post('/api/auth/logout');
  const loginOld = await request(app).post('/api/auth/login').set('X-Forwarded-For', testIp).send({ email, password: 'password123' });
  assert.strictEqual(loginOld.status, 401);
  const loginNew = await request(app).post('/api/auth/login').set('X-Forwarded-For', testIp).send({ email, password: 'newpassword456' });
  assert.strictEqual(loginNew.status, 200);

  await pool.query('DELETE FROM users WHERE email = $1', [email]);
});

test('DELETE /api/me removes the account and its session', async () => {
  const email = `delete-acct-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email, password: 'password123' }).expect(201);

  await agent.delete('/api/me').expect(200);

  const me = await agent.get('/api/auth/me');
  assert.strictEqual(me.status, 401);

  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  assert.strictEqual(rows.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npm test
```

Expected: FAIL — `PUT /api/me/password` returns 404.

- [ ] **Step 3: Add a password-hash-by-id lookup to `services/auth.js`**

`findUserById` deliberately excludes `password_hash` (Task 4) since it backs `GET /api/auth/me`, which must never leak it. Changing a password needs the hash without a second round-trip through email, so add a narrow, purpose-built lookup instead of loosening `findUserById`.

Add to `services/auth.js`:

```js
async function findPasswordHashById(id) {
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [id]);
  return rows[0]?.password_hash ?? null;
}
```

Add `findPasswordHashById` to the `module.exports` list in `services/auth.js`.

- [ ] **Step 4: Implement the routes in `routes/me.js`**

Add near the top, alongside the other requires:

```js
const { verifyPassword, hashPassword, updatePasswordHash, findPasswordHashById, deleteUser } = require('../services/auth');
```

Add before `module.exports`:

```js
router.put('/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'currentPassword and a newPassword of at least 8 characters are required' });
  }
  const currentHash = await findPasswordHashById(req.session.userId);
  const valid = currentHash ? await verifyPassword(currentPassword, currentHash) : false;
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const newHash = await hashPassword(newPassword);
  await updatePasswordHash(req.session.userId, newHash);
  res.json({ ok: true });
});

router.delete('/', async (req, res) => {
  const userId = req.session.userId;
  req.session.destroy(async err => {
    if (err) {
      console.error('[DELETE /api/me]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    res.clearCookie('connect.sid');
    await deleteUser(userId);
    res.json({ ok: true });
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

```
npm test
```

Expected: `test/me-account.test.js` passes (2 tests).

- [ ] **Step 6: Commit the backend half**

```
git add routes/me.js test/me-account.test.js
git commit -m "Add change-password and delete-account endpoints"
```

- [ ] **Step 7: Add the settings page markup to `public/index.html`**

Add right after the `#trackedView` section from Task 14:

```html
<section id="settingsView" hidden>
  <button class="btn-modal-skip" id="settingsBackBtn" data-i18n="backToSearch">&larr; Back</button>
  <h2 data-i18n="accountSettings">Account Settings</h2>

  <div class="settings-block">
    <label class="filter-label" data-i18n="authEmailLabel">Email</label>
    <div id="settingsEmail"></div>
  </div>

  <div class="settings-block">
    <h3 data-i18n="changePassword">Change password</h3>
    <input type="password" id="settingsCurrentPw" data-i18n-placeholder="currentPasswordPlaceholder" placeholder="Current password" autocomplete="current-password" />
    <input type="password" id="settingsNewPw" data-i18n-placeholder="newPasswordPlaceholder" placeholder="New password" autocomplete="new-password" />
    <button id="settingsSavePw" data-i18n="saveBtn">Save</button>
    <div id="settingsPwError" class="auth-error" hidden></div>
  </div>

  <div class="settings-block">
    <h3 data-i18n="preferredSettingsTitle">Preferred Settings</h3>
    <button id="settingsEditPrefs" data-i18n="editPreferences">Edit preferred settings</button>
  </div>

  <div class="settings-block">
    <h3 data-i18n="dangerZone">Danger zone</h3>
    <button id="settingsDeleteAccount" class="btn-danger" data-i18n="deleteAccount">Delete account</button>
  </div>
</section>
```

- [ ] **Step 8: Add the frontend logic to `public/app.js`**

```js
function openAccountSettings() {
  $('accountDropdown').hidden = true;
  document.querySelector('.layout').hidden = true;
  $('settingsView').hidden = false;
  $('settingsEmail').textContent = authState.email;
  $('settingsCurrentPw').value = '';
  $('settingsNewPw').value = '';
  $('settingsPwError').hidden = true;
}

function closeAccountSettings() {
  $('settingsView').hidden = true;
  document.querySelector('.layout').hidden = false;
}

function initAccountSettings() {
  $('settingsBackBtn').addEventListener('click', closeAccountSettings);

  $('settingsSavePw').addEventListener('click', async () => {
    const currentPassword = $('settingsCurrentPw').value;
    const newPassword = $('settingsNewPw').value;
    const res = await fetch('/api/me/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (res.ok) {
      $('settingsCurrentPw').value = '';
      $('settingsNewPw').value = '';
      $('settingsPwError').hidden = true;
      return;
    }
    const body = await res.json().catch(() => ({}));
    $('settingsPwError').textContent = body.error || t('authInvalidCreds');
    $('settingsPwError').hidden = false;
  });

  $('settingsEditPrefs').addEventListener('click', () => {
    closeAccountSettings();
    openPreferredDevicesModal();
  });

  $('settingsDeleteAccount').addEventListener('click', async () => {
    if (!confirm(t('deleteAccountConfirm'))) return;
    await fetch('/api/me', { method: 'DELETE' });
    closeAccountSettings();
    await refreshAuthState();
    fetchGames(false);
  });
}
```

Wire it into `init()`: add `initAccountSettings();` right after `initTrackedView();` (added in Task 14, Step 3).

- [ ] **Step 9: i18n keys**

Add to each language object in `public/i18n.js`:

```js
    changePassword:            'Change password',
    currentPasswordPlaceholder:'Current password',
    newPasswordPlaceholder:    'New password',
    editPreferences:           'Edit preferred settings',
    dangerZone:                'Danger zone',
    deleteAccount:             'Delete account',
    deleteAccountConfirm:      'This permanently deletes your account, wishlist, and owned games. Continue?',
```

- [ ] **Step 10: Styles**

Append to `public/style.css`:

```css
#settingsView { padding: 1rem; max-width: 480px; }
.settings-block { margin-top: 1.5rem; }
.settings-block input { display: block; width: 100%; margin-top: .5rem; }
.settings-block button { margin-top: .5rem; }
.btn-danger { background: #b3261e; color: #fff; border: none; padding: .5rem 1rem; border-radius: 6px; cursor: pointer; }
```

- [ ] **Step 11: Manual verification**

Log in, open Account Settings from the menu, change your password (wrong current password shows an error; correct one succeeds — verify by logging out and back in with the new password), open preferred settings from within the page, and finally delete the account and confirm it logs you out and the account no longer exists (signup with the same email should succeed again).

- [ ] **Step 12: Commit**

```
git add public/index.html public/app.js public/style.css public/i18n.js
git commit -m "Add account settings page (password change, delete account)"
```

---

## Task 17: Frontend — sync filter preferences to the account

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- Consumes: `authState.preferences` (Task 12), `PUT /api/me/preferences` (Task 7).
- Produces: on login, server preferences override localStorage-derived filters; on any filter change while logged in, the change is pushed to the server instead of localStorage.

- [ ] **Step 1: Build a preferences snapshot helper**

In `public/app.js`, add a function that converts the current localStorage-driven preference state into the same shape the server stores:

```js
function currentPreferencesSnapshot() {
  return {
    filterMode:   loadFilterMode(),
    deviceIds:    loadPreferredDeviceIds() || [],
    socIds:       loadPreferredSocIds() || [],
    compatId:     loadPreferredCompatId(),
    region:       loadPreferredRegion(),
    storeIds:     loadPreferredStoreIds() || [],
  };
}

function applyPreferencesSnapshot(prefs) {
  if (!prefs || Object.keys(prefs).length === 0) return false;
  if (prefs.filterMode) saveFilterMode(prefs.filterMode);
  if (prefs.deviceIds) savePreferredDeviceIds(prefs.deviceIds);
  if (prefs.socIds) savePreferredSocIds(prefs.socIds);
  if (prefs.compatId != null) savePreferredCompatId(prefs.compatId);
  if (prefs.region) savePreferredRegion(prefs.region);
  if (prefs.storeIds) savePreferredStoreIds(prefs.storeIds);

  const filterMode = loadFilterMode();
  applyFilterMode(filterMode);
  if (filterMode === 'chipset') applyPreferredSoc(); else applyPreferredDevices();
  applyPreferredCompat();
  applyPreferredRegion();
  applyPreferredStores();
  return true;
}

async function syncPreferencesToServer() {
  if (!authState.loggedIn) return;
  await fetch('/api/me/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(currentPreferencesSnapshot()),
  });
}
```

- [ ] **Step 2: Apply server preferences on login, and start syncing going forward**

In `refreshAuthState()` (Task 12, Step 3), change the body of the `if (res.status === 200)` branch to also apply server preferences the first time they're seen:

```js
  if (res.status === 200) {
    const body = await res.json();
    const wasLoggedIn = authState.loggedIn;
    authState.loggedIn = true;
    authState.email = body.email;
    authState.preferences = body.preferences;
    if (!wasLoggedIn) {
      const applied = applyPreferencesSnapshot(body.preferences);
      if (applied) fetchGames();
    }
  } else {
```

- [ ] **Step 3: Push to the server whenever preferences are saved locally**

In `public/app.js`, each `save*` preference function (`saveFilterMode`, `savePreferredDeviceIds`, `savePreferredCompatId`, `savePreferredRegion`, `savePreferredStoreIds`, `savePreferredSocIds`) already writes to localStorage. Add a call to `syncPreferencesToServer()` at the end of each — for example, `savePreferredDeviceIds` (currently lines 480-482) becomes:

```js
function savePreferredDeviceIds(ids) {
  localStorage.setItem(PREF_KEY, JSON.stringify(ids));
  syncPreferencesToServer();
}
```

Apply the same one-line addition to the other five `save*` functions listed above (`saveFilterMode` at line 440, `savePreferredCompatId` at line 497, `savePreferredRegion` at line 515, `savePreferredStoreIds` at line 532, `savePreferredSocIds` at line 551).

- [ ] **Step 4: Manual verification**

While logged out, set some preferences (device, region) via the preferred-settings modal — confirm no `PUT /api/me/preferences` network call fires (check browser devtools). Log in and confirm those same preferences now sync (change one, check devtools for the `PUT` call, then check `GET /api/auth/me` reflects it). Log out and back in from a different browser profile (or after clearing localStorage) and confirm the account's saved preferences are applied automatically instead of showing the first-visit device-picker modal.

- [ ] **Step 5: Commit**

```
git add public/app.js
git commit -m "Sync filter preferences to the account when logged in"
```

---

## Self-Review Notes

- **Spec coverage:** Every section of `docs/superpowers/specs/2026-07-22-accounts-wishlist-owned-design.md` maps to a task — data model (Tasks 2, 8), auth flow (Tasks 3-6), preferences (Tasks 7, 17), wishlist/owned API (Tasks 8-10), hide-owned filter (Task 11), UI (Tasks 12-16), security (bcrypt cost 12 in Task 3, session cookie flags in Task 5, rate limiting in Task 6, generic login errors in Task 6, session-derived auth in Task 5/7/10).
- **Deferred by design (per spec):** email verification, password reset, price-drop alerts, platform import — none of these have tasks here, matching the spec's explicit scope cut.
- **Type/name consistency check:** `itad_id` is used consistently as the join key across `services/wishlist.js`, `services/store.js` (`getDealsForItadIds`, `buildItadIdEntry`), and the `/api/games` `g.appId` field (confirmed to already be the ITAD id, not the Steam app id, by reading `services/store.js`'s existing `getDealsForTitles`). `req.session.userId` is the single source of truth for the authenticated user across all `/api/me/*` routes and the hide-owned filter — no route reads a user id from the request body or params.
- **Amendment (post-hoc, from the Steam import spec's brainstorm):** Task 8's `addOwned` and Task 10's owned-route test were updated so marking a game owned always removes any matching wishlist entry, superseding the originally-independent behavior. Task 13's card-button click handler was updated to reflect this in the UI immediately rather than waiting for a refetch. This keeps the accounts spec/plan and the Steam import spec (`docs/superpowers/specs/2026-07-22-steam-import-design.md`) consistent with each other, since the import spec's resync logic relies on this same rule being enforced unconditionally in `services/wishlist.js`, not duplicated in the import code.
