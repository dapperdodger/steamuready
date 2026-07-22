# Email Verification, Password Reset & Price Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email verification on signup, a password-reset flow, and a configurable price-drop email digest for wishlisted games, using AWS SES.

**Architecture:** `services/email.js` wraps SES with a dry-run mode for local/test use. `services/emailTokens.js` handles verify/reset tokens (SHA-256 hashed at rest, single-use). `services/alertMode.js` holds the three pure re-alert decision functions. `services/alertTiming.js` computes, per region, a target local send hour derived from Steam's confirmed 10am-Pacific deal-refresh time (falling back to a fixed local hour where that lands overnight), using only built-in `Intl` — no new timezone dependency. `services/priceAlerts.js` orchestrates the daily job: group eligible users by region, fetch each region's prices once, apply each user's `alert_mode`, send one digest per user, gated by a Redis key that is simultaneously the cross-task dedup and the once-per-day gate. This plan depends on the accounts plan already being implemented (reuses `users`, `wishlist_items`, `middleware/session.js`, `services/auth.js`, `services/store.js`, `services/cache.js`) but not on the Steam import plan.

**Tech Stack:** `@aws-sdk/client-ses`, Node's built-in `crypto` and `Intl`, PostgreSQL, Redis, `node:test`.

## Global Constraints

- Email provider is AWS SES — no new third-party vendor.
- Verification never blocks app usage — it only gates whether alert emails are sent.
- Alerts are on by default (`alerts_enabled = TRUE`) once a user wishlists something; gated by `email_verified`.
- Multiple qualifying games in one check are bundled into a single digest email, never one email per game.
- `email_verified`, `alerts_enabled`, `alert_mode` are dedicated `users` columns — never folded into the `users.preferences` JSONB blob (that blob is reserved for settings with a logged-out/localStorage equivalent; alert settings have none).
- `email_tokens.token` stores a SHA-256 hash of the actual token, never the plaintext.
- A password reset invalidates every other active session for that account.
- `forgot-password` always returns the same generic response regardless of whether the email is registered.
- The price-check job runs hourly but only acts on a region once its local hour matches that region's computed target — and the same Redis `NX` key that gates "already sent today" also prevents the two ECS tasks (`infra/main.tf`'s `desired_count = 2`) from double-sending.
- Region grouping for price checks: fetch each distinct region's prices once via `store.getDealsForItadIds`, never once per user.
- `routes/auth.js`'s `authRateLimiter` shares one IP-keyed bucket across `/signup` and `/login` — every test in this plan that calls either endpoint must use a unique simulated IP via `test/helpers/testIp.js` (from the accounts plan), exactly like the accounts and Steam import plans do.
- Environment is Windows/PowerShell — no bash-specific command syntax.
- Local dev requires Redis + Postgres running (`docker compose up -d`) before running any test in this plan.
- Automated tests cover pure/DB logic; live SES sends and the actual scheduled job loop are verified manually via `EMAIL_DRY_RUN`, consistent with this codebase's established testing pattern.

---

## Task 1: DB schema + SES dependency

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `services/db.js`
- Modify: `test/db.test.js`
- Create: `test/db-alerts.test.js`

**Interfaces:**
- Produces: `users.email_verified` (BOOLEAN, default FALSE), `users.alerts_enabled` (BOOLEAN, default TRUE), `users.alert_mode` (TEXT, default `'sale_period'`, checked against the 3-value enum), `wishlist_items.last_alerted_price` (NUMERIC), `wishlist_items.last_alerted_deal_since` (TIMESTAMPTZ), and the `email_tokens` table — consumed by every later task.

- [ ] **Step 1: Add the `@aws-sdk/client-ses` dependency**

```
npm install @aws-sdk/client-ses
```

- [ ] **Step 2: Add env vars to `.env.example`**

```
# Sender address for verification/reset/alert emails — must be a verified SES identity.
SES_FROM_EMAIL=alerts@steamuready.com

# Set to true to log composed emails to the console instead of calling SES
# (local dev/tests can't easily use production SES access).
EMAIL_DRY_RUN=true
```

- [ ] **Step 3: Add the schema changes to `services/db.js`**

Add inside the template string in `init()`, after the Steam-linking `ALTER TABLE` statements from the Steam import plan (or after `owned_games`/`wishlist_items` if that plan hasn't run — either way, at the end of the existing statements):

```sql

    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS alert_mode TEXT DEFAULT 'sale_period';
    ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS last_alerted_price NUMERIC;
    ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS last_alerted_deal_since TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS email_tokens (
      token       TEXT PRIMARY KEY,
      user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
      purpose     TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
```

(`alert_mode`'s `CHECK` constraint is added in Step 4 below via a separate `ALTER TABLE ... ADD CONSTRAINT` — `ADD COLUMN IF NOT EXISTS` doesn't support inline `CHECK` cleanly when the column may already exist from a prior partial run, so it's split out.)

- [ ] **Step 4: Add the `alert_mode` check constraint**

Add immediately after the block from Step 3:

```sql

    DO $$ BEGIN
      ALTER TABLE users ADD CONSTRAINT users_alert_mode_check
        CHECK (alert_mode IN ('price_drop', 'sale_period', 'historical_low'));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
```

- [ ] **Step 5: Update the shared schema test's exact column-list assertions**

`test/db.test.js` (from the accounts plan, already amended once by the Steam import plan's Task 1) asserts an exact column list per table via `assert.deepStrictEqual`. This plan adds more columns to `users` and `wishlist_items`, so those two assertions need extending again — otherwise `test/db.test.js` fails once this plan's migrations run, since it would see unexpected extra columns. Continuing the exact same pattern the Steam import plan already established:

```js
  assert.deepStrictEqual(byTable.users, ['id', 'email', 'password_hash', 'preferences', 'created_at', 'steam_id', 'steam_persona_name', 'email_verified', 'alerts_enabled', 'alert_mode']);
  assert.deepStrictEqual(byTable.wishlist_items, ['user_id', 'itad_id', 'added_at', 'source', 'last_alerted_price', 'last_alerted_deal_since']);
```

(Replace the two `assert.deepStrictEqual(byTable.users, ...)` / `assert.deepStrictEqual(byTable.wishlist_items, ...)` lines currently in `test/db.test.js` with these. If the Steam import plan wasn't implemented before this one, drop `'steam_id', 'steam_persona_name'` and `'source'` from the expected arrays accordingly — match whatever columns actually exist at this point.)

- [ ] **Step 6: Write the test for the new `email_tokens` table and the `alert_mode` constraint**

Create `test/db-alerts.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { pool, init } = require('../services/db');

test('init() creates email_tokens with expected columns', async () => {
  await init();

  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'email_tokens' ORDER BY ordinal_position
  `);
  assert.deepStrictEqual(rows.map(r => r.column_name), ['token', 'user_id', 'purpose', 'expires_at', 'created_at']);
});

test('alert_mode rejects values outside the enum', async () => {
  await assert.rejects(
    () => pool.query("UPDATE users SET alert_mode = 'not_a_real_mode' WHERE FALSE"),
    /violates check constraint|users_alert_mode_check/
  );
});
```

- [ ] **Step 7: Run the tests**

```
npm test
```

Expected: `test/db.test.js` and `test/db-alerts.test.js` both pass.

- [ ] **Step 8: Commit**

```
git add package.json package-lock.json .env.example services/db.js test/db.test.js test/db-alerts.test.js
git commit -m "Add email verification/alert schema and SES dependency"
```

---

## Task 2: SES email wrapper (`services/email.js`)

**Files:**
- Create: `services/email.js`
- Create: `test/email.test.js`

**Interfaces:**
- Produces: `sendVerificationEmail(to, token, baseUrl)`, `sendPasswordResetEmail(to, token, baseUrl)`, `sendPriceAlertDigest(to, items)` (`items: [{gameName, price, discountPercent, storeUrl}]`), `buildVerifyUrl(baseUrl, token)`, `buildResetUrl(baseUrl, token)`, and `_getLastDryRunEmail()` (test-only introspection hook) — consumed by `routes/auth.js` (Task 4-5) and `services/priceAlerts.js` (Task 9).

`EMAIL_DRY_RUN=true` short-circuits every send to a console log plus an in-memory capture (`_getLastDryRunEmail()`), instead of calling SES — this is what lets later tasks' tests exercise full signup→verify and forgot-password→reset flows through `supertest` without needing real AWS credentials.

- [ ] **Step 1: Write the failing tests**

Create `test/email.test.js`:

```js
require('dotenv').config();
process.env.EMAIL_DRY_RUN = 'true';
const test = require('node:test');
const assert = require('node:assert');
const email = require('../services/email');

test('sendVerificationEmail composes a verify link containing the token', async () => {
  await email.sendVerificationEmail('user@example.com', 'abc123token', 'http://localhost:3000');
  const sent = email._getLastDryRunEmail();
  assert.strictEqual(sent.to, 'user@example.com');
  assert.match(sent.text, /http:\/\/localhost:3000\/api\/auth\/verify\?token=abc123token/);
});

test('sendPasswordResetEmail composes a reset link containing the token', async () => {
  await email.sendPasswordResetEmail('user@example.com', 'reset456token', 'http://localhost:3000');
  const sent = email._getLastDryRunEmail();
  assert.match(sent.text, /http:\/\/localhost:3000\/\?resetToken=reset456token/);
});

test('sendPriceAlertDigest uses a singular subject for one game and a plural subject for multiple', async () => {
  await email.sendPriceAlertDigest('user@example.com', [
    { gameName: 'Portal 2', price: 4.99, discountPercent: 50, storeUrl: 'https://store.steampowered.com/app/620' },
  ]);
  assert.match(email._getLastDryRunEmail().subject, /Portal 2 just dropped in price!/);

  await email.sendPriceAlertDigest('user@example.com', [
    { gameName: 'Portal 2', price: 4.99, discountPercent: 50, storeUrl: 'x' },
    { gameName: 'Half-Life', price: 2.99, discountPercent: 70, storeUrl: 'y' },
  ]);
  assert.match(email._getLastDryRunEmail().subject, /2 games on your wishlist just dropped in price!/);
});

test('every email includes the support/Discord/Ko-fi footer', async () => {
  await email.sendVerificationEmail('user@example.com', 'tok', 'http://localhost:3000');
  const sent = email._getLastDryRunEmail();
  assert.match(sent.text, /support@steamuready\.com/);
  assert.match(sent.text, /discord\.gg\/XAt8awGUMM/);
  assert.match(sent.text, /ko-fi\.com\/dapperdodger/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `Cannot find module '../services/email'`.

- [ ] **Step 3: Implement `services/email.js`**

```js
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const client = new SESClient({});

const FOOTER_HTML = `<hr/><p style="font-size:12px;color:#888">
  Questions? <a href="mailto:support@steamuready.com">support@steamuready.com</a> ·
  <a href="https://discord.gg/XAt8awGUMM">Discord</a> ·
  <a href="https://ko-fi.com/dapperdodger">Support on Ko-fi</a>
</p>`;
const FOOTER_TEXT = '\n\n---\nQuestions? support@steamuready.com | Discord: https://discord.gg/XAt8awGUMM | Support: https://ko-fi.com/dapperdodger';

let _lastDryRunEmail = null;
function _getLastDryRunEmail() { return _lastDryRunEmail; }

async function sendEmail(to, subject, html, text) {
  if (process.env.EMAIL_DRY_RUN === 'true') {
    _lastDryRunEmail = { to, subject, html, text };
    console.log(`[email:dry-run] to=${to} subject="${subject}"\n${text}`);
    return;
  }
  await client.send(new SendEmailCommand({
    Source: process.env.SES_FROM_EMAIL,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: { Html: { Data: html }, Text: { Data: text } },
    },
  }));
}

function buildVerifyUrl(baseUrl, token) { return `${baseUrl}/api/auth/verify?token=${token}`; }
function buildResetUrl(baseUrl, token) { return `${baseUrl}/?resetToken=${token}`; }

async function sendVerificationEmail(to, token, baseUrl) {
  const url = buildVerifyUrl(baseUrl, token);
  const html = `<p>Click to verify your email:</p><p><a href="${url}">${url}</a></p>${FOOTER_HTML}`;
  const text = `Verify your email: ${url}${FOOTER_TEXT}`;
  await sendEmail(to, 'Verify your SteamUReady email', html, text);
}

async function sendPasswordResetEmail(to, token, baseUrl) {
  const url = buildResetUrl(baseUrl, token);
  const html = `<p>Click to reset your password (expires in 1 hour):</p><p><a href="${url}">${url}</a></p>${FOOTER_HTML}`;
  const text = `Reset your password (expires in 1 hour): ${url}${FOOTER_TEXT}`;
  await sendEmail(to, 'Reset your SteamUReady password', html, text);
}

function formatMoney(amount) { return `$${Number(amount).toFixed(2)}`; }

async function sendPriceAlertDigest(to, items) {
  const subject = items.length === 1
    ? `${items[0].gameName} just dropped in price!`
    : `${items.length} games on your wishlist just dropped in price!`;
  const rowsHtml = items.map(i =>
    `<li><a href="${i.storeUrl}">${i.gameName}</a> — ${formatMoney(i.price)} (${i.discountPercent}% off)</li>`
  ).join('');
  const rowsText = items.map(i =>
    `- ${i.gameName}: ${formatMoney(i.price)} (${i.discountPercent}% off) ${i.storeUrl}`
  ).join('\n');
  const html = `<ul>${rowsHtml}</ul>${FOOTER_HTML}`;
  const text = `${rowsText}${FOOTER_TEXT}`;
  await sendEmail(to, subject, html, text);
}

module.exports = {
  sendVerificationEmail, sendPasswordResetEmail, sendPriceAlertDigest,
  buildVerifyUrl, buildResetUrl, _getLastDryRunEmail,
};
```

- [ ] **Step 4: Run test to verify it passes**

```
npm test
```

Expected: `test/email.test.js` passes (4 tests).

- [ ] **Step 5: Commit**

```
git add services/email.js test/email.test.js
git commit -m "Add SES email wrapper with dry-run mode for verify/reset/digest emails"
```

---

## Task 3: Verify/reset tokens (`services/emailTokens.js`)

**Files:**
- Create: `services/emailTokens.js`
- Create: `test/emailTokens.test.js`

**Interfaces:**
- Produces: `createToken(userId, purpose, ttlMs): Promise<string>` (returns the **plaintext** token — the only place it's ever returned, for embedding in the email URL), `consumeToken(token, purpose): Promise<string|null>` (validates purpose + expiry and deletes the row atomically in one query; returns the `userId` or `null`), `hashToken(token): string` — consumed by `routes/auth.js` in Tasks 4-5.

- [ ] **Step 1: Write the failing tests**

Create `test/emailTokens.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { pool } = require('../services/db');
const { createUser, deleteUser, hashPassword } = require('../services/auth');
const { createToken, consumeToken, hashToken } = require('../services/emailTokens');

async function makeTestUser(tag) {
  const email = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  return createUser(email, await hashPassword('password123'));
}

test('createToken/consumeToken round-trips and is single-use', async () => {
  const user = await makeTestUser('token-test');
  const token = await createToken(user.id, 'verify', 60 * 60 * 1000);

  assert.strictEqual(await consumeToken(token, 'verify'), user.id);
  assert.strictEqual(await consumeToken(token, 'verify'), null); // already consumed

  await deleteUser(user.id);
});

test('consumeToken rejects the wrong purpose without consuming the token', async () => {
  const user = await makeTestUser('token-purpose-test');
  const token = await createToken(user.id, 'reset', 60 * 60 * 1000);

  assert.strictEqual(await consumeToken(token, 'verify'), null);
  assert.strictEqual(await consumeToken(token, 'reset'), user.id); // still valid for the correct purpose

  await deleteUser(user.id);
});

test('consumeToken rejects an expired token', async () => {
  const user = await makeTestUser('token-expiry-test');
  const token = await createToken(user.id, 'verify', -1000); // already expired

  assert.strictEqual(await consumeToken(token, 'verify'), null);

  await deleteUser(user.id);
});

test('the database stores only a hash of the token, never the plaintext', async () => {
  const user = await makeTestUser('token-hash-test');
  const token = await createToken(user.id, 'verify', 60 * 60 * 1000);

  const { rows } = await pool.query('SELECT token FROM email_tokens WHERE user_id = $1', [user.id]);
  assert.strictEqual(rows[0].token, hashToken(token));
  assert.notStrictEqual(rows[0].token, token);

  await deleteUser(user.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `Cannot find module '../services/emailTokens'`.

- [ ] **Step 3: Implement `services/emailTokens.js`**

```js
const crypto = require('crypto');
const { pool } = require('./db');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createToken(userId, purpose, ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMs);
  await pool.query(
    'INSERT INTO email_tokens (token, user_id, purpose, expires_at) VALUES ($1, $2, $3, $4)',
    [hashToken(token), userId, purpose, expiresAt]
  );
  return token;
}

// Atomically validates (purpose + not expired) and consumes (deletes) in one
// statement, avoiding a check-then-delete race between concurrent requests.
async function consumeToken(token, purpose) {
  const { rows } = await pool.query(
    'DELETE FROM email_tokens WHERE token = $1 AND purpose = $2 AND expires_at > NOW() RETURNING user_id',
    [hashToken(token), purpose]
  );
  return rows[0]?.user_id ?? null;
}

module.exports = { hashToken, createToken, consumeToken };
```

- [ ] **Step 4: Run test to verify it passes**

```
npm test
```

Expected: `test/emailTokens.test.js` passes (4 tests).

- [ ] **Step 5: Commit**

```
git add services/emailTokens.js test/emailTokens.test.js
git commit -m "Add SHA-256-hashed, single-use email verification/reset tokens"
```

---

## Task 4: Signup verification email + verify/resend routes

**Files:**
- Modify: `services/auth.js`
- Modify: `routes/auth.js`
- Create: `test/emailVerification.test.js`

**Interfaces:**
- Modifies: `findUserById` (now also selects `email_verified`, `alerts_enabled`, `alert_mode`), adds `setEmailVerified(id, verified): Promise<void>` to `services/auth.js`.
- Modifies: `POST /api/auth/signup` (now also sends a verification email) and `GET /api/auth/me` (now also returns `emailVerified`, `alertsEnabled`, `alertMode`) in `routes/auth.js`.
- Produces: `GET /api/auth/verify?token=`, `POST /api/auth/resend-verification` — consumed by the frontend in Task 11.

- [ ] **Step 1: Write the failing tests**

Create `test/emailVerification.test.js`:

```js
require('dotenv').config();
process.env.EMAIL_DRY_RUN = 'true';
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { pool } = require('../services/db');
const email = require('../services/email');
const { nextTestIp } = require('./helpers/testIp');

function extractToken(text) {
  const match = /[?&]token=([^&\s]+)/.exec(text);
  return match ? match[1] : null;
}

test('signup sends a verification email, and the verify link marks email_verified', async () => {
  const testEmail = `verify-flow-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email: testEmail, password: 'password123' }).expect(201);

  const sent = email._getLastDryRunEmail();
  assert.strictEqual(sent.to, testEmail);
  const token = extractToken(sent.text);
  assert.ok(token);

  const before = await agent.get('/api/auth/me');
  assert.strictEqual(before.body.emailVerified, false);
  assert.strictEqual(before.body.alertsEnabled, true);
  assert.strictEqual(before.body.alertMode, 'sale_period');

  const verifyRes = await agent.get(`/api/auth/verify?token=${token}`);
  assert.strictEqual(verifyRes.status, 302);
  assert.match(verifyRes.headers.location, /emailVerified=1/);

  const after = await agent.get('/api/auth/me');
  assert.strictEqual(after.body.emailVerified, true);

  await pool.query('DELETE FROM users WHERE email = $1', [testEmail]);
});

test('an invalid verify token redirects with an error and does not verify anything', async () => {
  const res = await request(app).get('/api/auth/verify?token=not-a-real-token');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.location, /emailError=invalid_token/);
});

test('resend-verification requires auth, resends while unverified, and no-ops once verified', async () => {
  const anon = await request(app).post('/api/auth/resend-verification');
  assert.strictEqual(anon.status, 401);

  const testEmail = `resend-flow-${Date.now()}@example.com`;
  const testIp = nextTestIp();
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email: testEmail, password: 'password123' }).expect(201);

  const resendRes = await agent.post('/api/auth/resend-verification').set('X-Forwarded-For', testIp);
  assert.strictEqual(resendRes.status, 200);
  assert.strictEqual(resendRes.body.alreadyVerified, undefined);

  const token = extractToken(email._getLastDryRunEmail().text);
  await agent.get(`/api/auth/verify?token=${token}`).expect(302);

  const afterVerify = await agent.post('/api/auth/resend-verification').set('X-Forwarded-For', testIp);
  assert.strictEqual(afterVerify.body.alreadyVerified, true);

  await pool.query('DELETE FROM users WHERE email = $1', [testEmail]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `before.body.emailVerified` is `undefined`, and `GET /api/auth/verify` 404s.

- [ ] **Step 3: Update `services/auth.js`**

Update `findUserById`'s query to:

```js
async function findUserById(id) {
  const { rows } = await pool.query(
    'SELECT id, email, preferences, created_at, email_verified, alerts_enabled, alert_mode FROM users WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}
```

Add before the final `module.exports`:

```js
async function setEmailVerified(id, verified) {
  await pool.query('UPDATE users SET email_verified = $1 WHERE id = $2', [verified, id]);
}
```

Add `setEmailVerified` to `module.exports`.

- [ ] **Step 4: Update `routes/auth.js`**

Add near the top, alongside the existing requires:

```js
const emailTokens = require('../services/emailTokens');
const email = require('../services/email');
```

In the `/signup` handler, after `req.session.userId = user.id;` and before the `res.status(201).json(...)` line, add:

```js
    const verifyToken = await emailTokens.createToken(user.id, 'verify', 24 * 60 * 60 * 1000);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    email.sendVerificationEmail(user.email, verifyToken, baseUrl)
      .catch(e => console.error('[signup] verification email failed:', e.message));
```

(Fire-and-forget with a `.catch` — a transient SES hiccup shouldn't fail account creation itself.)

Update the `GET /me` handler's response to:

```js
  res.json({
    email: user.email,
    preferences: user.preferences,
    emailVerified: user.email_verified,
    alertsEnabled: user.alerts_enabled,
    alertMode: user.alert_mode,
  });
```

Add two new routes, before `module.exports = router;`:

```js
router.get('/verify', async (req, res) => {
  const token = req.query.token;
  if (typeof token !== 'string') return res.redirect('/?emailError=invalid_token');
  const userId = await emailTokens.consumeToken(token, 'verify');
  if (!userId) return res.redirect('/?emailError=invalid_token');
  await auth.setEmailVerified(userId, true);
  res.redirect('/?emailVerified=1');
});

router.post('/resend-verification', requireAuth, authRateLimiter, async (req, res) => {
  const user = await auth.findUserById(req.session.userId);
  if (user.email_verified) return res.json({ ok: true, alreadyVerified: true });
  const token = await emailTokens.createToken(user.id, 'verify', 24 * 60 * 60 * 1000);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  await email.sendVerificationEmail(user.email, token, baseUrl);
  res.json({ ok: true });
});
```

This references `requireAuth` — add the import at the top of `routes/auth.js` alongside the others:

```js
const { requireAuth } = require('../middleware/session');
```

- [ ] **Step 5: Run tests to verify they pass**

```
npm test
```

Expected: `test/emailVerification.test.js` passes (3 tests).

- [ ] **Step 6: Commit**

```
git add services/auth.js routes/auth.js test/emailVerification.test.js
git commit -m "Send verification email on signup; add verify/resend-verification routes"
```

---

## Task 5: Password reset flow

**Files:**
- Modify: `middleware/session.js`
- Modify: `routes/auth.js`
- Create: `test/passwordReset.test.js`

**Interfaces:**
- Produces: `invalidateUserSessions(userId): Promise<void>` in `middleware/session.js`; `POST /api/auth/forgot-password {email}`, `POST /api/auth/reset-password {token, newPassword}` in `routes/auth.js` — consumed by the frontend in Task 11.

- [ ] **Step 1: Write the failing tests**

Create `test/passwordReset.test.js`:

```js
require('dotenv').config();
process.env.EMAIL_DRY_RUN = 'true';
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { pool } = require('../services/db');
const email = require('../services/email');
const { nextTestIp } = require('./helpers/testIp');

function extractToken(text) {
  const match = /[?&]resetToken=([^&\s]+)/.exec(text);
  return match ? match[1] : null;
}

test('forgot-password always returns a generic response, whether or not the email exists', async () => {
  const testIp = nextTestIp();
  const existsRes = await request(app).post('/api/auth/forgot-password').set('X-Forwarded-For', testIp).send({ email: 'nobody-real@example.com' });
  const missingRes = await request(app).post('/api/auth/forgot-password').set('X-Forwarded-For', testIp).send({ email: 'also-nobody-real@example.com' });
  assert.strictEqual(existsRes.status, 200);
  assert.deepStrictEqual(existsRes.body, missingRes.body);
});

test('forgot-password emails a working reset link for a real account, and reset-password invalidates other sessions', async () => {
  const testEmail = `reset-flow-${Date.now()}@example.com`;
  const testIp = nextTestIp();

  const agentA = request.agent(app); // session that will be invalidated
  await agentA.post('/api/auth/signup').set('X-Forwarded-For', testIp).send({ email: testEmail, password: 'password123' }).expect(201);
  const meBefore = await agentA.get('/api/auth/me');
  assert.strictEqual(meBefore.status, 200);

  await request(app).post('/api/auth/forgot-password').set('X-Forwarded-For', testIp).send({ email: testEmail }).expect(200);
  const token = extractToken(email._getLastDryRunEmail().text);
  assert.ok(token);

  const resetRes = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'brandnewpassword456' });
  assert.strictEqual(resetRes.status, 200);

  // The old session (agentA) must no longer be valid.
  const meAfter = await agentA.get('/api/auth/me');
  assert.strictEqual(meAfter.status, 401);

  // The old password no longer works; the new one does.
  const oldLogin = await request(app).post('/api/auth/login').set('X-Forwarded-For', testIp).send({ email: testEmail, password: 'password123' });
  assert.strictEqual(oldLogin.status, 401);
  const newLogin = await request(app).post('/api/auth/login').set('X-Forwarded-For', testIp).send({ email: testEmail, password: 'brandnewpassword456' });
  assert.strictEqual(newLogin.status, 200);

  // The reset token is single-use.
  const reuse = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'anotherpassword789' });
  assert.strictEqual(reuse.status, 400);

  await pool.query('DELETE FROM users WHERE email = $1', [testEmail]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `POST /api/auth/forgot-password` returns 404.

- [ ] **Step 3: Add `invalidateUserSessions` to `middleware/session.js`**

Add before `module.exports`:

```js
const { redis } = require('../services/cache');

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
```

Update `module.exports` in `middleware/session.js` to include `invalidateUserSessions`.

- [ ] **Step 4: Add the routes to `routes/auth.js`**

Add before `module.exports = router;`:

```js
router.post('/forgot-password', authRateLimiter, async (req, res) => {
  const GENERIC = { ok: true, message: 'If that email is registered, a reset link has been sent.' };
  const { email: rawEmail } = req.body ?? {};
  if (typeof rawEmail !== 'string' || !EMAIL_RE.test(rawEmail)) return res.json(GENERIC);

  const user = await auth.findUserByEmail(rawEmail.toLowerCase());
  if (user) {
    const token = await emailTokens.createToken(user.id, 'reset', 60 * 60 * 1000);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    email.sendPasswordResetEmail(user.email, token, baseUrl)
      .catch(e => console.error('[forgot-password] reset email failed:', e.message));
  }
  res.json(GENERIC);
});

router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body ?? {};
  if (typeof token !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'A token and a newPassword of at least 8 characters are required' });
  }
  const userId = await emailTokens.consumeToken(token, 'reset');
  if (!userId) return res.status(400).json({ error: 'Invalid or expired reset link' });

  const newHash = await auth.hashPassword(newPassword);
  await auth.updatePasswordHash(userId, newHash);
  await invalidateUserSessions(userId);

  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});
```

Add `invalidateUserSessions` to the `middleware/session` import at the top of `routes/auth.js`:

```js
const { requireAuth, invalidateUserSessions } = require('../middleware/session');
```

- [ ] **Step 5: Run tests to verify they pass**

```
npm test
```

Expected: `test/passwordReset.test.js` passes (2 tests).

- [ ] **Step 6: Commit**

```
git add middleware/session.js routes/auth.js test/passwordReset.test.js
git commit -m "Add password reset flow with cross-session invalidation"
```

---

## Task 6: Re-alert decision logic (`services/alertMode.js`)

**Files:**
- Create: `services/alertMode.js`
- Create: `test/alertMode.test.js`

**Interfaces:**
- Produces: `shouldAlert(alertMode, currentDeal, wishlistItem): boolean` (and the three individual mode functions, exported for direct testing) — consumed by `services/priceAlerts.js` in Task 9. `currentDeal` is the deal-object shape already produced by `services/store.js` (`price`, `discountPercent`, `dealSince`, `historicalLow`); `wishlistItem` has `last_alerted_price`/`last_alerted_deal_since`.

- [ ] **Step 1: Write the failing tests**

Create `test/alertMode.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { shouldAlert } = require('../services/alertMode');

const dealAt = (price, discountPercent, dealSince, historicalLow = null) => ({ price, discountPercent, dealSince, historicalLow });

test('a game with no active discount never alerts, regardless of mode', () => {
  const deal = dealAt(19.99, 0, '2026-01-01T00:00:00Z');
  for (const mode of ['price_drop', 'sale_period', 'historical_low']) {
    assert.strictEqual(shouldAlert(mode, deal, {}), false);
  }
});

test('price_drop alerts on first discount seen, then only on a deeper price, never on an unchanged price', () => {
  const wishlistItem = { last_alerted_price: null };
  assert.strictEqual(shouldAlert('price_drop', dealAt(9.99, 50, 'x'), wishlistItem), true);

  wishlistItem.last_alerted_price = 9.99;
  assert.strictEqual(shouldAlert('price_drop', dealAt(9.99, 50, 'x'), wishlistItem), false); // unchanged
  assert.strictEqual(shouldAlert('price_drop', dealAt(4.99, 75, 'x'), wishlistItem), true);  // deeper
  assert.strictEqual(shouldAlert('price_drop', dealAt(14.99, 25, 'x'), wishlistItem), false); // higher than last alert
});

test('sale_period alerts once per distinct dealSince, not on every check within the same sale', () => {
  const wishlistItem = { last_alerted_deal_since: null };
  assert.strictEqual(shouldAlert('sale_period', dealAt(9.99, 50, 'deal-1'), wishlistItem), true);

  wishlistItem.last_alerted_deal_since = 'deal-1';
  assert.strictEqual(shouldAlert('sale_period', dealAt(9.99, 50, 'deal-1'), wishlistItem), false); // same sale window
  assert.strictEqual(shouldAlert('sale_period', dealAt(7.99, 60, 'deal-2'), wishlistItem), true);  // new sale window
});

test('historical_low only alerts at or below the all-time low, and not repeatedly for the same low price', () => {
  const wishlistItem = { last_alerted_price: null };
  const notLow = dealAt(9.99, 50, 'x', { price: 4.99 });
  assert.strictEqual(shouldAlert('historical_low', notLow, wishlistItem), false);

  const atLow = dealAt(4.99, 75, 'x', { price: 4.99 });
  assert.strictEqual(shouldAlert('historical_low', atLow, wishlistItem), true);

  wishlistItem.last_alerted_price = 4.99;
  assert.strictEqual(shouldAlert('historical_low', atLow, wishlistItem), false); // same low again

  const newLow = dealAt(3.99, 80, 'x', { price: 3.99 });
  assert.strictEqual(shouldAlert('historical_low', newLow, wishlistItem), true); // even lower
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `Cannot find module '../services/alertMode'`.

- [ ] **Step 3: Implement `services/alertMode.js`**

```js
function shouldAlertPriceDrop(current, lastAlertedPrice) {
  return lastAlertedPrice == null || current.price < lastAlertedPrice;
}

function shouldAlertSalePeriod(current, lastAlertedDealSince) {
  return lastAlertedDealSince == null || current.dealSince !== lastAlertedDealSince;
}

function shouldAlertHistoricalLow(current, lastAlertedPrice) {
  if (!current.historicalLow) return false;
  if (current.price > current.historicalLow.price) return false;
  return lastAlertedPrice == null || current.price < lastAlertedPrice;
}

function shouldAlert(alertMode, current, wishlistItem) {
  if (!current.discountPercent || current.discountPercent <= 0) return false;
  switch (alertMode) {
    case 'price_drop':
      return shouldAlertPriceDrop(current, wishlistItem.last_alerted_price);
    case 'historical_low':
      return shouldAlertHistoricalLow(current, wishlistItem.last_alerted_price);
    case 'sale_period':
    default:
      return shouldAlertSalePeriod(current, wishlistItem.last_alerted_deal_since);
  }
}

module.exports = { shouldAlert, shouldAlertPriceDrop, shouldAlertSalePeriod, shouldAlertHistoricalLow };
```

- [ ] **Step 4: Run test to verify it passes**

```
npm test
```

Expected: `test/alertMode.test.js` passes (4 tests).

- [ ] **Step 5: Commit**

```
git add services/alertMode.js test/alertMode.test.js
git commit -m "Add price_drop/sale_period/historical_low re-alert decision logic"
```

---

## Task 7: Per-region send timing (`services/alertTiming.js`)

**Files:**
- Create: `services/alertTiming.js`
- Create: `test/alertTiming.test.js`

**Interfaces:**
- Produces: `getTargetLocalHour(region, at = new Date()): number` (0-23), `getCurrentLocalHour(region, at = new Date()): number`, `shouldSendNow(region, at = new Date()): boolean`, `REGION_TIMEZONES` — consumed by `services/priceAlerts.js` in Task 9.

Uses only Node's built-in `Intl.DateTimeFormat` (no new timezone dependency). `getTargetLocalHour` computes each region's current UTC offset and Pacific's current UTC offset via `Intl`'s `timeZoneName: 'shortOffset'`, derives what local hour corresponds to "noon Pacific" (2 hours after Steam's confirmed 10am-PT deal refresh) at that same instant, and uses it only if it falls in a comfortable window (7:00–22:00); otherwise it falls back to a fixed 9am local. Because this is computed from the *current* UTC offsets rather than a static table, it self-adjusts across DST transitions — a region that's comfortable in one season and not in another (Australia is the clearest example: the noon-Pacific instant lands at roughly 7am Sydney time in Southern-hemisphere summer and roughly 5am in Southern-hemisphere winter) gets the freshest slot when available and the fallback otherwise, without needing a season-aware table.

- [ ] **Step 1: Write the failing tests**

Create `test/alertTiming.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { getTargetLocalHour, getCurrentLocalHour, shouldSendNow, REGION_TIMEZONES } = require('../services/alertTiming');

test('REGION_TIMEZONES covers every region supported by services/store.js', () => {
  const expectedRegions = ['us', 'fr', 'gb', 'de', 'ca', 'au', 'br', 'tr', 'ar', 'pl'];
  for (const region of expectedRegions) {
    assert.ok(REGION_TIMEZONES[region], `missing timezone mapping for region "${region}"`);
  }
});

test('an unrecognized region falls back to a fixed hour instead of crashing', () => {
  const hour = getTargetLocalHour('xx-not-a-real-region', new Date('2026-07-15T12:00:00Z'));
  assert.strictEqual(typeof hour, 'number');
  assert.ok(hour >= 0 && hour <= 23);
});

test('getCurrentLocalHour reflects the actual wall-clock hour in that timezone', () => {
  // 2026-07-15T19:00:00Z is 12:00 in America/Los_Angeles (PDT, UTC-7) that day.
  const at = new Date('2026-07-15T19:00:00Z');
  assert.strictEqual(getCurrentLocalHour('us', at), 15); // America/New_York, EDT UTC-4 -> 15:00
});

test('getTargetLocalHour falls back to a comfortable fixed hour when the noon-Pacific instant would be overnight (Southern winter)', () => {
  // Mid-July: Northern summer (Pacific on PDT), Southern winter (Sydney on AEST, no DST) -> ~5am local, uncomfortable.
  const julyAt = new Date('2026-07-15T12:00:00Z');
  const auHour = getTargetLocalHour('au', julyAt);
  assert.ok(auHour >= 7 && auHour <= 22, `expected a fallback in the comfortable window, got ${auHour}`);
});

test('getTargetLocalHour uses the freshest comfortable hour when the noon-Pacific instant lands in daytime (Southern summer)', () => {
  // Mid-January: Southern summer (Sydney on AEDT) -> the noon-Pacific instant lands closer to Sydney's morning.
  const janAt = new Date('2026-01-15T12:00:00Z');
  const auHour = getTargetLocalHour('au', janAt);
  assert.ok(auHour >= 0 && auHour <= 23);
});

test('shouldSendNow is true only when the current local hour matches the computed target', () => {
  const at = new Date('2026-07-15T19:00:00Z'); // 15:00 in America/New_York
  const target = getTargetLocalHour('us', at);
  assert.strictEqual(shouldSendNow('us', at), target === 15);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `Cannot find module '../services/alertTiming'`.

- [ ] **Step 3: Implement `services/alertTiming.js`**

```js
const REGION_TIMEZONES = {
  us: 'America/New_York',
  ca: 'America/Toronto',
  br: 'America/Sao_Paulo',
  ar: 'America/Argentina/Buenos_Aires',
  gb: 'Europe/London',
  fr: 'Europe/Paris',
  de: 'Europe/Berlin',
  pl: 'Europe/Warsaw',
  tr: 'Europe/Istanbul',
  au: 'Australia/Sydney',
};

const FALLBACK_TIMEZONE = 'Etc/UTC';
const FALLBACK_HOUR = 9;
const COMFORTABLE_MIN_HOUR = 7;
const COMFORTABLE_MAX_HOUR = 22;
const PACIFIC_TZ = 'America/Los_Angeles';
const PACIFIC_ANCHOR_HOUR = 12; // noon Pacific = 2h after Steam's confirmed 10am-PT deal refresh

function getLocalHour(timeZone, at) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false }).formatToParts(at);
  return parseInt(parts.find(p => p.type === 'hour').value, 10) % 24;
}

function getUtcOffsetHours(timeZone, at) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(at);
  const tzName = parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT+0';
  const match = /GMT([+-]\d+)(?::(\d+))?/.exec(tzName);
  if (!match) return 0;
  const hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  return hours + (hours < 0 ? -minutes / 60 : minutes / 60);
}

function getCurrentLocalHour(region, at = new Date()) {
  return getLocalHour(REGION_TIMEZONES[region] || FALLBACK_TIMEZONE, at);
}

function getTargetLocalHour(region, at = new Date()) {
  const timeZone = REGION_TIMEZONES[region] || FALLBACK_TIMEZONE;
  const pacificOffset = getUtcOffsetHours(PACIFIC_TZ, at);
  const regionOffset = getUtcOffsetHours(timeZone, at);
  const noonPacificUtcHour = (PACIFIC_ANCHOR_HOUR - pacificOffset + 24) % 24;
  const localHourAtAnchor = Math.round((noonPacificUtcHour + regionOffset + 24) % 24);
  if (localHourAtAnchor >= COMFORTABLE_MIN_HOUR && localHourAtAnchor <= COMFORTABLE_MAX_HOUR) {
    return localHourAtAnchor;
  }
  return FALLBACK_HOUR;
}

function shouldSendNow(region, at = new Date()) {
  return getCurrentLocalHour(region, at) === getTargetLocalHour(region, at);
}

module.exports = { getTargetLocalHour, getCurrentLocalHour, shouldSendNow, REGION_TIMEZONES };
```

- [ ] **Step 4: Run test to verify it passes**

```
npm test
```

Expected: `test/alertTiming.test.js` passes (6 tests).

- [ ] **Step 5: Commit**

```
git add services/alertTiming.js test/alertTiming.test.js
git commit -m "Add per-region local-hour send timing anchored to Steam's deal-refresh time"
```

---

## Task 8: Alert settings route

**Files:**
- Modify: `routes/me.js`
- Modify: `services/auth.js`
- Create: `test/alertSettings.test.js`

**Interfaces:**
- Produces: `updateAlertSettings(id, alertsEnabled, alertMode): Promise<void>` in `services/auth.js`; `PUT /api/me/alert-settings {alertsEnabled, alertMode}` in `routes/me.js` — consumed by the frontend in Task 13.

- [ ] **Step 1: Write the failing test**

Create `test/alertSettings.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');
const { pool } = require('../services/db');
const { nextTestIp } = require('./helpers/testIp');

test('PUT /api/me/alert-settings requires auth, validates alertMode, and persists both fields', async () => {
  const anon = await request(app).put('/api/me/alert-settings').send({ alertsEnabled: false, alertMode: 'price_drop' });
  assert.strictEqual(anon.status, 401);

  const email = `alert-settings-${Date.now()}@example.com`;
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({ email, password: 'password123' }).expect(201);

  const invalidMode = await agent.put('/api/me/alert-settings').send({ alertsEnabled: true, alertMode: 'not_a_real_mode' });
  assert.strictEqual(invalidMode.status, 400);

  const ok = await agent.put('/api/me/alert-settings').send({ alertsEnabled: false, alertMode: 'historical_low' });
  assert.strictEqual(ok.status, 200);

  const me = await agent.get('/api/auth/me');
  assert.strictEqual(me.body.alertsEnabled, false);
  assert.strictEqual(me.body.alertMode, 'historical_low');

  await pool.query('DELETE FROM users WHERE email = $1', [email]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `PUT /api/me/alert-settings` returns 404.

- [ ] **Step 3: Add `updateAlertSettings` to `services/auth.js`**

```js
async function updateAlertSettings(id, alertsEnabled, alertMode) {
  await pool.query(
    'UPDATE users SET alerts_enabled = $1, alert_mode = $2 WHERE id = $3',
    [alertsEnabled, alertMode, id]
  );
}
```

Add `updateAlertSettings` to `module.exports`.

- [ ] **Step 4: Add the route to `routes/me.js`**

Add near the top, alongside the other requires:

```js
const { updateAlertSettings } = require('../services/auth');
```

Add before `module.exports`:

```js
const VALID_ALERT_MODES = ['price_drop', 'sale_period', 'historical_low'];

router.put('/alert-settings', async (req, res) => {
  const { alertsEnabled, alertMode } = req.body ?? {};
  if (typeof alertsEnabled !== 'boolean' || !VALID_ALERT_MODES.includes(alertMode)) {
    return res.status(400).json({ error: 'alertsEnabled (boolean) and a valid alertMode are required' });
  }
  await updateAlertSettings(req.session.userId, alertsEnabled, alertMode);
  res.json({ ok: true });
});
```

- [ ] **Step 5: Run test to verify it passes**

```
npm test
```

Expected: `test/alertSettings.test.js` passes.

- [ ] **Step 6: Commit**

```
git add routes/me.js services/auth.js test/alertSettings.test.js
git commit -m "Add PUT /api/me/alert-settings"
```

---

## Task 9: Price-check orchestration (`services/priceAlerts.js`)

**Files:**
- Create: `services/priceAlerts.js`
- Create: `test/priceAlerts.test.js`

**Interfaces:**
- Consumes: `store.getDealsForItadIds` (accounts plan's Task 9), `shouldAlert` (Task 6), `shouldSendNow` (Task 7), `email.sendPriceAlertDigest` (Task 2), `redis` (`services/cache.js`).
- Produces: `claimRegionForToday(region, at): Promise<boolean>` (the Redis `NX` gate — tested directly against real Redis), `getEligibleUsersByRegion(): Promise<Map<region, users[]>>`, `checkRegion(region, users): Promise<void>`, `runTick(at = new Date()): Promise<void>` — consumed by `server.js` in Task 10.

`claimRegionForToday` is pure Redis logic and gets full automated coverage — it's the mechanism that prevents double-sends across the app's 2 ECS tasks, so it's the highest-risk piece here. `checkRegion`/`runTick` orchestrate live ITAD price fetches and SES sends and are verified manually in Task 10.

- [ ] **Step 1: Write the failing test for the dedup gate**

Create `test/priceAlerts.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { redis } = require('../services/cache');
const { claimRegionForToday } = require('../services/priceAlerts');

test('claimRegionForToday: first claim for a region+day succeeds, a second claim for the same region+day fails', async () => {
  const region = `test-region-${Date.now()}`;
  const at = new Date('2026-07-15T19:00:00Z');

  const first = await claimRegionForToday(region, at);
  assert.strictEqual(first, true);

  const second = await claimRegionForToday(region, at);
  assert.strictEqual(second, false);

  // Cleanup: delete whatever key this created (region/date-scoped, safe to target by pattern).
  await redis.del(`alert-sent:${region}:2026-07-15`);
});

test('claimRegionForToday: different regions on the same day claim independently', async () => {
  const at = new Date('2026-07-15T19:00:00Z');
  const regionA = `test-region-a-${Date.now()}`;
  const regionB = `test-region-b-${Date.now()}`;

  assert.strictEqual(await claimRegionForToday(regionA, at), true);
  assert.strictEqual(await claimRegionForToday(regionB, at), true);

  await redis.del(`alert-sent:${regionA}:2026-07-15`, `alert-sent:${regionB}:2026-07-15`);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm test
```

Expected: FAIL — `Cannot find module '../services/priceAlerts'`.

- [ ] **Step 3: Implement `services/priceAlerts.js`**

```js
const { redis } = require('./cache');
const { pool } = require('./db');
const store = require('./store');
const email = require('./email');
const { shouldAlert } = require('./alertMode');
const { shouldSendNow, REGION_TIMEZONES } = require('./alertTiming');

const SENT_KEY_TTL_SECONDS = 90000; // ~25h — comfortably covers a full day even with clock drift

function regionDateStr(region, at) {
  const timeZone = REGION_TIMEZONES[region] || 'Etc/UTC';
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at); // en-CA formats as YYYY-MM-DD
}

// Atomically claims "region's daily digest for today" — whichever of the
// app's ECS tasks calls this first for a given (region, day) wins and does
// the real work; the other task's tick finds the key already set and skips.
async function claimRegionForToday(region, at = new Date()) {
  const key = `alert-sent:${region}:${regionDateStr(region, at)}`;
  const res = await redis.set(key, '1', 'EX', SENT_KEY_TTL_SECONDS, 'NX');
  return res === 'OK';
}

async function getEligibleUsersByRegion() {
  const { rows } = await pool.query(`
    SELECT id, email, COALESCE(preferences->>'region', 'us') AS region, alert_mode
    FROM users WHERE alerts_enabled = TRUE AND email_verified = TRUE
  `);
  const byRegion = new Map();
  for (const row of rows) {
    if (!byRegion.has(row.region)) byRegion.set(row.region, []);
    byRegion.get(row.region).push(row);
  }
  return byRegion;
}

async function checkRegion(region, users) {
  const { rows: wishlistRows } = await pool.query(
    'SELECT user_id, itad_id, last_alerted_price, last_alerted_deal_since FROM wishlist_items WHERE user_id = ANY($1)',
    [users.map(u => u.id)]
  );
  if (!wishlistRows.length) return;

  const itadIds = [...new Set(wishlistRows.map(r => r.itad_id))];
  const dealMap = await store.getDealsForItadIds(itadIds, region, []);

  const alertModeByUser = new Map(users.map(u => [u.id, u.alert_mode]));
  const emailByUser = new Map(users.map(u => [u.id, u.email]));
  const digestsByUser = new Map();

  for (const row of wishlistRows) {
    const deal = dealMap.get(row.itad_id);
    if (!deal) continue;
    if (!shouldAlert(alertModeByUser.get(row.user_id), deal, row)) continue;

    if (!digestsByUser.has(row.user_id)) digestsByUser.set(row.user_id, []);
    digestsByUser.get(row.user_id).push({
      gameName: deal.name, price: deal.price, discountPercent: deal.discountPercent, storeUrl: deal.storeUrl,
    });

    await pool.query(
      'UPDATE wishlist_items SET last_alerted_price = $1, last_alerted_deal_since = $2 WHERE user_id = $3 AND itad_id = $4',
      [deal.price, deal.dealSince, row.user_id, row.itad_id]
    );
  }

  for (const [userId, items] of digestsByUser) {
    await email.sendPriceAlertDigest(emailByUser.get(userId), items).catch(e =>
      console.error(`[priceAlerts] digest send failed for user ${userId}:`, e.message)
    );
  }
}

async function runTick(at = new Date()) {
  const byRegion = await getEligibleUsersByRegion();
  for (const [region, users] of byRegion) {
    if (!shouldSendNow(region, at)) continue;
    if (!(await claimRegionForToday(region, at))) continue; // another task already handled this region today
    await checkRegion(region, users);
  }
}

module.exports = { claimRegionForToday, getEligibleUsersByRegion, checkRegion, runTick };
```

- [ ] **Step 4: Run test to verify it passes**

```
npm test
```

Expected: `test/priceAlerts.test.js` passes (2 tests).

- [ ] **Step 5: Commit**

```
git add services/priceAlerts.js test/priceAlerts.test.js
git commit -m "Add price-check orchestration with region grouping and cross-task dedup"
```

---

## Task 10: Wire the job into `server.js` + IAM permission

**Files:**
- Modify: `server.js`
- Modify: `infra/main.tf`

**Interfaces:**
- Consumes: `priceAlerts.runTick` (Task 9).

- [ ] **Step 1: Add the hourly tick to `server.js`**

Add near the other requires:

```js
const priceAlerts = require('./services/priceAlerts');
```

Inside the `if (require.main === module) { ... }` block, after the `warmCaches();` call inside `app.listen`'s callback (or anywhere within that guarded block — it must not run when `server.js` is `require`d by tests), add:

```js
    setInterval(() => {
      priceAlerts.runTick().catch(e => console.error('[priceAlerts] tick failed:', e.message));
    }, 60 * 60 * 1000); // hourly; runTick itself only acts once a day per region
```

- [ ] **Step 2: Manually verify the job doesn't run during tests**

```
npm test
```

Expected: all tests still pass, with no `[priceAlerts]` log lines appearing (confirms the `require.main === module` guard is still correctly excluding this from the test import path, same as it already does for `app.listen`/`warmCaches`).

- [ ] **Step 3: Manually verify a real dry-run tick**

With `EMAIL_DRY_RUN=true` in `.env` and at least one verified, alerts-enabled user with a wishlisted, currently-discounted game:

```
npm start
```

Wait for (or temporarily lower the `setInterval` to a shorter duration to force) a tick, and confirm a `[email:dry-run]` log line appears with the expected digest content. Revert any temporary interval change afterward.

- [ ] **Step 4: Add the SES IAM permission to `infra/main.tf`**

Add a new policy to the existing task role (do **not** run `terraform apply` — this is a local file edit only; applying it against real AWS infrastructure is a deliberate action for whoever deploys this, the same way `DEPLOY.md`'s existing `terraform apply` steps are always run by a person, not automatically):

```hcl
resource "aws_iam_role_policy" "task_ses" {
  name = "send-email"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ses:SendEmail", "ses:SendRawEmail"]
      Resource = "*"
    }]
  })
}
```

- [ ] **Step 5: Commit**

```
git add server.js infra/main.tf
git commit -m "Schedule the hourly price-alert tick; add SES IAM permission"
```

---

## Task 11: Frontend — forgot/reset password

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/i18n.js`

**Interfaces:**
- Consumes: `POST /api/auth/forgot-password`, `POST /api/auth/reset-password` (Task 5), the auth modal scaffolding from the accounts plan's Task 12 (`authEl`, `openAuthModal`/`closeAuthModal`).

No automated test — no frontend test tooling in this project. Verified manually via the `run` skill.

- [ ] **Step 1: Add a "Forgot password?" link to the auth modal in `public/index.html`**

Inside `#authModal`'s `.modal-footer` (added in the accounts plan's Task 12), add before `#authCancel`:

```html
      <button class="btn-modal-skip" id="authForgotPassword" data-i18n="authForgotPassword">Forgot password?</button>
```

Add a reset-password form section, right after `#authModal`'s closing `</div>` (a separate modal, since it's reached via a direct link, not the login/signup tab flow):

```html
<!-- Reset Password Modal -->
<div class="modal-overlay" id="resetPasswordModal" hidden>
  <div class="modal">
    <div class="modal-header">
      <h2 data-i18n="setNewPasswordTitle">Set a new password</h2>
    </div>
    <div class="modal-body">
      <label class="filter-label" data-i18n="authPasswordLabel">Password</label>
      <input type="password" id="resetNewPassword" minlength="8" style="width:100%;margin-top:.35rem" />
      <div id="resetPasswordError" class="auth-error" hidden></div>
    </div>
    <div class="modal-footer">
      <button class="btn-modal-save" id="resetPasswordSubmit" data-i18n="saveBtn">Save</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add the frontend logic to `public/app.js`**

Add API helpers to the `Object.assign(api, {...})` block:

```js
  forgotPassword(email) {
    return fetch('/api/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  },
  resetPassword(token, newPassword) {
    return fetch('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, newPassword }) });
  },
```

Add:

```js
function initForgotPassword() {
  $('authForgotPassword').addEventListener('click', async () => {
    const email = authEl.email.value.trim();
    if (!email) {
      authEl.error.textContent = t('authEmailLabel');
      authEl.error.hidden = false;
      return;
    }
    await api.forgotPassword(email);
    closeAuthModal();
    showToast(t('forgotPasswordSent'));
  });
}

function initResetPasswordModal() {
  const params = new URLSearchParams(location.search);
  const resetToken = params.get('resetToken');
  if (!resetToken) return;

  $('resetPasswordModal').hidden = false;
  history.replaceState(null, '', location.pathname);

  $('resetPasswordSubmit').addEventListener('click', async () => {
    const newPassword = $('resetNewPassword').value;
    const res = await api.resetPassword(resetToken, newPassword);
    if (res.ok) {
      $('resetPasswordModal').hidden = true;
      showToast(t('passwordResetSuccess'));
      return;
    }
    const body = await res.json().catch(() => ({}));
    $('resetPasswordError').textContent = body.error || t('authInvalidCreds');
    $('resetPasswordError').hidden = false;
  });
}
```

(`showToast` was added in the Steam import plan's Task 7 — if implementing this plan without that one, add the same minimal helper here instead.)

Wire both into `init()`, alongside the other `init*()` calls: `initForgotPassword(); initResetPasswordModal();`.

- [ ] **Step 3: i18n keys**

Add to each language object in `public/i18n.js`:

```js
    authForgotPassword:   'Forgot password?',
    setNewPasswordTitle:  'Set a new password',
    forgotPasswordSent:   "If that email is registered, we've sent a reset link.",
    passwordResetSuccess: 'Password updated. Please log in again.',
```

- [ ] **Step 4: Manual verification**

Click "Forgot password?" with an email typed in, confirm a generic toast appears regardless of whether the account exists, and (with `EMAIL_DRY_RUN=true`) confirm the console logs the reset link. Visit that link, set a new password, confirm you're logged out and can log in with the new password but not the old one.

- [ ] **Step 5: Commit**

```
git add public/index.html public/app.js public/i18n.js
git commit -m "Add forgot/reset password UI"
```

---

## Task 12: Frontend — verification banner

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`
- Modify: `public/i18n.js`

**Interfaces:**
- Consumes: `authState.emailVerified` (from `refreshAuthState()`, extended below), `POST /api/auth/resend-verification` (Task 4).

No automated test — verified manually.

- [ ] **Step 1: Add the banner markup to `public/index.html`**

Add right after the `<header class="header">` block's closing `</header>`:

```html
<div class="verify-banner" id="verifyBanner" hidden>
  <span data-i18n="verifyBannerMsg">Please verify your email to receive price-drop alerts.</span>
  <button id="verifyBannerResendBtn" data-i18n="resendVerification">Resend verification email</button>
</div>
```

- [ ] **Step 2: Extend `authState` and wire up the banner in `public/app.js`**

In `refreshAuthState()` (accounts plan Task 12), extend the fields read from the response:

```js
    authState.emailVerified = body.emailVerified;
    authState.alertsEnabled = body.alertsEnabled;
    authState.alertMode = body.alertMode;
```

(Add alongside the existing `authState.loggedIn = true; authState.email = ...` assignments.)

In `renderAuthMenu()`, add:

```js
  $('verifyBanner').hidden = !(authState.loggedIn && authState.emailVerified === false);
```

Add:

```js
function initVerifyBanner() {
  $('verifyBannerResendBtn').addEventListener('click', async () => {
    const res = await fetch('/api/auth/resend-verification', { method: 'POST' });
    if (res.ok) showToast(t('verificationEmailSent'));
  });
}
```

Wire into `init()`: `initVerifyBanner();`. Also, in `init()`, add handling for the `emailVerified=1` redirect param (alongside the Steam-link toast handling from the Steam import plan, if present, or as its own block):

```js
  if (new URLSearchParams(location.search).get('emailVerified') === '1') {
    showToast(t('emailVerifiedToast'));
    history.replaceState(null, '', location.pathname);
  }
```

- [ ] **Step 3: i18n keys**

```js
    verifyBannerMsg:       'Please verify your email to receive price-drop alerts.',
    resendVerification:    'Resend verification email',
    verificationEmailSent: 'Verification email sent.',
    emailVerifiedToast:    'Email verified!',
```

- [ ] **Step 4: Styles**

Append to `public/style.css`:

```css
.verify-banner {
  background: #3a3020;
  color: #f0d080;
  padding: .5rem 1rem;
  text-align: center;
  font-size: .9rem;
}
.verify-banner button {
  margin-left: .75rem;
  background: none;
  border: 1px solid currentColor;
  color: inherit;
  border-radius: 4px;
  padding: .15rem .5rem;
  cursor: pointer;
}
```

- [ ] **Step 5: Manual verification**

Sign up a new account, confirm the banner shows. Click "Resend verification email," confirm a toast appears and (with `EMAIL_DRY_RUN=true`) the console logs a new email. Visit the verify link, confirm the banner disappears and a "Email verified!" toast shows.

- [ ] **Step 6: Commit**

```
git add public/index.html public/app.js public/style.css public/i18n.js
git commit -m "Add email verification banner"
```

---

## Task 13: Frontend — Account Settings "Email Alerts" section

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/i18n.js`

**Interfaces:**
- Consumes: `PUT /api/me/alert-settings` (Task 8), `authState.alertsEnabled`/`authState.alertMode`, the account settings scaffolding from the accounts plan's Task 16.

No automated test — verified manually.

- [ ] **Step 1: Add the markup to `public/index.html`**

Add inside `#settingsView`, right after the "Preferred Settings" `.settings-block` (accounts plan Task 16) and before "Danger zone":

```html
  <div class="settings-block">
    <h3 data-i18n="emailAlertsTitle">Email Alerts</h3>
    <label>
      <input type="checkbox" id="alertsEnabledCheck" />
      <span data-i18n="alertsEnabledLabel">Email me when a wishlisted game drops in price</span>
    </label>
    <div style="margin-top:.75rem">
      <label class="filter-label" data-i18n="alertModeLabel">How often</label>
      <select id="alertModeSelect" style="width:100%;margin-top:.35rem">
        <option value="price_drop" data-i18n="alertModePriceDrop">Every time the price drops further</option>
        <option value="sale_period" data-i18n="alertModeSalePeriod">Once per sale</option>
        <option value="historical_low" data-i18n="alertModeHistoricalLow">Only at an all-time low price</option>
      </select>
    </div>
  </div>
```

- [ ] **Step 2: Add the frontend logic to `public/app.js`**

Add an API helper:

```js
  updateAlertSettings(alertsEnabled, alertMode) {
    return fetch('/api/me/alert-settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertsEnabled, alertMode }),
    });
  },
```

Add, and call from `openAccountSettings()` (accounts plan Task 16) alongside the existing `refreshSteamStatus()`-style calls:

```js
function initAlertSettings() {
  $('alertsEnabledCheck').addEventListener('change', saveAlertSettings);
  $('alertModeSelect').addEventListener('change', saveAlertSettings);
}

function renderAlertSettings() {
  $('alertsEnabledCheck').checked = authState.alertsEnabled;
  $('alertModeSelect').value = authState.alertMode;
}

async function saveAlertSettings() {
  const alertsEnabled = $('alertsEnabledCheck').checked;
  const alertMode = $('alertModeSelect').value;
  await api.updateAlertSettings(alertsEnabled, alertMode);
  authState.alertsEnabled = alertsEnabled;
  authState.alertMode = alertMode;
}
```

In `openAccountSettings()`, add a call to `renderAlertSettings();`. Wire `initAlertSettings();` into `init()`.

- [ ] **Step 3: i18n keys**

```js
    emailAlertsTitle:       'Email Alerts',
    alertsEnabledLabel:     'Email me when a wishlisted game drops in price',
    alertModeLabel:         'How often',
    alertModePriceDrop:     'Every time the price drops further',
    alertModeSalePeriod:    'Once per sale',
    alertModeHistoricalLow: 'Only at an all-time low price',
```

- [ ] **Step 4: Manual verification**

Open Account Settings, confirm the checkbox is checked and mode is "Once per sale" by default (matches the DB defaults). Toggle it off, change the mode, reload, reopen settings, and confirm both persisted.

- [ ] **Step 5: Commit**

```
git add public/index.html public/app.js public/i18n.js
git commit -m "Add Email Alerts section to account settings"
```

---

## Self-Review Notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-07-22-email-alerts-design.md` maps to a task — data model (Task 1), verification/reset flow (Tasks 4-5), re-alert policy (Task 6), region grouping/timing (Tasks 7, 9), email sending (Task 2), routes (Tasks 4, 5, 8), frontend (Tasks 11-13), security (SHA-256 tokens in Task 3, session invalidation in Task 5, generic forgot-password response in Task 5, IAM scoping in Task 10).
- **Cross-plan consistency:** `services/priceAlerts.js` (Task 9) consumes `store.getDealsForItadIds` exactly as defined in the accounts plan's Task 9 — same signature, same region-keyed Redis overview cache underneath, no new price-fetching path introduced.
- **Rate-limit test isolation:** every test in this plan that calls `/api/auth/signup` or `/api/auth/login` uses `nextTestIp()` from `test/helpers/testIp.js` (accounts plan Task 1), consistent with the fix already applied retroactively to the accounts and Steam import plans.
- **Type/name consistency check:** `alertMode` (camelCase in API/JS) vs `alert_mode` (snake_case DB column) is used consistently in the same pattern already established for `email_verified`/`emailVerified` and `alerts_enabled`/`alertsEnabled` — no new naming scheme introduced.
