# Email Verification, Password Reset & Price-Drop Alerts

Status: Draft — approved for planning
Date: 2026-07-22

## Summary

The third and final spec in the accounts/wishlist initiative (see the
accounts spec and the Steam import spec). Adds: email verification on
signup, a password reset flow, and the headline feature this whole
initiative was built for — emailing users when a wishlisted game's price
drops, on a schedule they can configure. All three share one dependency
(transactional email sending), which is why they're one spec rather than
three.

## Scope

- **Email provider: AWS SES.** Stays entirely within the existing AWS
  account (ECS, Secrets Manager, ElastiCache) rather than adding a new
  third-party vendor. New AWS accounts start in the SES sandbox (can only
  send to pre-verified addresses) until production access is requested from
  AWS — a manual approval step, similar in spirit to the manual ITAD/IGDB
  key signup already documented in the README. This must be requested before
  this spec can go live in production.
- **Verification does not gate app usage.** An unverified user can still use
  every feature (wishlist, owned, Steam import, etc.). Verification only
  gates whether alert emails get sent — the actual risk being mitigated is
  emailing an unverified or typo'd address, not restricting the product.
- **Alerts are on by default** once a user wishlists something (that's the
  core value proposition), gated only by `email_verified`. A user can turn
  them off entirely, or tune how often they fire, in Account Settings.
- **Digest, not per-game emails.** If multiple wishlisted games qualify for
  an alert in the same check, they're bundled into one email.
- **Once-daily checks, not hourly.** Sending a "your wishlist changed"
  digest doesn't need to be near-real-time; the timing design below exists
  to land in a comfortable local hour rather than to be maximally frequent.

## Data model

```sql
ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN alerts_enabled BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN alert_mode TEXT DEFAULT 'sale_period'
  CHECK (alert_mode IN ('price_drop', 'sale_period', 'historical_low'));

ALTER TABLE wishlist_items ADD COLUMN last_alerted_price NUMERIC;
ALTER TABLE wishlist_items ADD COLUMN last_alerted_deal_since TIMESTAMPTZ;

CREATE TABLE email_tokens (
  token       TEXT PRIMARY KEY,   -- SHA-256 hash of the actual token, not the token itself
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

Notes:

- `email_verified`, `alerts_enabled`, `alert_mode` are **dedicated columns**,
  deliberately not folded into `users.preferences` (the JSONB blob from the
  accounts spec). That blob is reserved for filter settings that also have a
  logged-out/localStorage equivalent (devices, region, etc.) — alert settings
  have no anonymous equivalent, so they get their own columns. (This
  boundary is saved to memory for future work on this project.)
- `last_alerted_price`/`last_alerted_deal_since` live on `wishlist_items`
  itself so they disappear automatically when a wishlist entry is removed —
  no orphaned alert-history cleanup needed. They reuse the `dealSince`/price
  fields already produced by `services/store.js`'s deal objects.
- `email_tokens.token` stores a **SHA-256 hash**, not the plaintext token —
  mirroring the bcrypt precedent from the accounts spec so a database leak
  doesn't hand out usable verification/reset links. The plaintext token only
  ever appears in the emailed URL.
- One shared table for both verify and reset tokens (`purpose` column)
  rather than two near-identical tables, since both need the same shape.

## Verification & password reset flow

- **Verification**: generated on signup (24h expiry), emailed via SES with a
  link to `GET /api/auth/verify?token=...`. Visiting it hashes the token,
  looks it up, checks expiry, sets `email_verified = true`, deletes the
  token, redirects to `/?emailVerified=1`. A "Resend verification email"
  action is available (rate-limited, reusing the existing auth
  rate-limiter pattern) for unverified accounts.
- **Password reset**: "Forgot password?" on the login modal →
  `POST /api/auth/forgot-password {email}` always returns the same generic
  response regardless of whether the email exists (no enumeration) — if it
  does, a reset token (1h expiry) is generated and emailed.
  `POST /api/auth/reset-password {token, newPassword}` validates the token,
  updates the password hash, deletes the token, **invalidates every other
  session for that user** (Redis `SCAN` over `sess:*`, parsing each
  session's `userId` — same pattern as `delPattern` in `services/cache.js`),
  and destroys the current session too, so the user logs in fresh with the
  new password.
- Visiting `/?resetToken=...` shows a "Set new password" form in the SPA
  (not a separate page) that calls `reset-password` with the token read from
  the URL.

## Re-alert policy (`alert_mode`, user-configurable, default `sale_period`)

Applied per wishlist item, per check, using the item's current deal data
(`price`, `discountPercent`, `dealSince`, `historicalLow` — all already
produced by `services/store.js`) against `last_alerted_price`/
`last_alerted_deal_since`:

- **`price_drop`**: alert if `last_alerted_price IS NULL OR currentPrice <
  last_alerted_price`. Catches a deepening discount (20% → 50% off) but
  never repeats for an unchanged price. After alerting, set
  `last_alerted_price = currentPrice`.
- **`sale_period`** (default): alert if `last_alerted_deal_since IS NULL OR
  currentDealSince != last_alerted_deal_since` — i.e., a new, distinct sale
  window started. After alerting, set both `last_alerted_price` and
  `last_alerted_deal_since` from the current deal.
- **`historical_low`**: alert only if `currentPrice <= historicalLow.price
  AND (last_alerted_price IS NULL OR currentPrice < last_alerted_price)` —
  strictly the rarest, highest-signal option. After alerting, set
  `last_alerted_price = currentPrice`.
- A game with no active discount is simply skipped — `last_alerted_*` fields
  are left untouched so a later, genuinely new sale is still recognized
  correctly under `sale_period`.

## Price-check job: region grouping, efficiency, and timing

**Region grouping (efficiency):** rather than fetching prices per user, the
job groups by each distinct region actually in use:

1. `SELECT id, email, preferences->>'region' AS region, alert_mode FROM
   users WHERE alerts_enabled AND email_verified` (region defaults to `'us'`
   if unset), grouped in application code by region.
2. For each **distinct region present** (bounded by the ~10 supported
   regions, realistically far fewer), gather the union of `itad_id`s
   wishlisted by users in that group and call
   `store.getDealsForItadIds(itadIds, region, [])` **once per region** (it
   already batches 200 ids per ITAD call internally).
3. Each user's wishlist items are evaluated against their region's
   already-fetched price map, applying their own `alert_mode`.

**Timing (once daily, at a comfortable local hour, anchored to Steam's
actual deal-refresh time where that's still comfortable):** Steam's Daily
Deal rotation and most sales refresh at **10am Pacific Time**, confirmed
directly against Steamworks' own documentation (not assumed). The target is
2 hours after that (noon Pacific) — a single fixed global instant. Converted
to each region's representative timezone:

| region | timezone | local time at noon-Pacific | comfortable? |
|---|---|---|---|
| us, ca | America/New_York, America/Toronto | ~3pm | yes |
| br, ar | America/Sao_Paulo, America/Argentina/Buenos_Aires | ~4pm | yes |
| gb | Europe/London | ~8pm | yes |
| fr, de, pl | Europe/Paris, Europe/Berlin, Europe/Warsaw | ~9pm | yes (borderline) |
| tr | Europe/Istanbul | ~10pm | borderline |
| au | Australia/Sydney | ~5-6am | **no** |

**Rule:** for each region, compute the local hour corresponding to "noon
Pacific today" (via `Intl.DateTimeFormat` with a `timeZone` option — built
into Node, DST-aware, no new dependency). If that hour falls in a
comfortable window (7:00–22:00 local), use it — that region gets the
freshest-feeling digest. If not (only `au` fails this as of today's
timezone data), fall back to a fixed comfortable local hour (9am local) for
that region instead, trading freshness for not landing at 5am. Any region
not in the table above (future regions, or unrecognized values) falls back
to the same rule anchored to `Etc/UTC` with a 9am-UTC fallback — this is the
"catch-all" behavior so a new region never crashes the job or silently never
sends.

**Cadence & cross-task dedup (solves both problems with one mechanism):**
the job ticks **hourly** (cheap — it's just a local-hour check, not a price
fetch) but only does real work for a region once its current local hour
matches that region's target hour, gated by
`redis.set('alert-sent:' + region + ':' + dateStr, '1', 'EX', 90000, 'NX')`.
Because this project's ECS service runs `desired_count = 2` (confirmed in
`infra/main.tf`), both tasks tick hourly — whichever task's tick wins the
atomic `NX` set is the one that fetches prices and sends that region's
digests for the day; the other task's tick finds the key already set and
skips. This is the same mechanism that would otherwise need a separate
"cycle lock" — one Redis key does both jobs.

## Email sending

- `services/email.js` wraps `@aws-sdk/client-ses` (same AWS SDK v3 family
  already used for Secrets Manager). Requires a verified sender identity in
  SES — **`no-reply@steamuready.com`**, not a monitored inbox — and a new
  `ses:SendEmail`/`ses:SendRawEmail` IAM permission added to the existing ECS
  task role in `infra/main.tf` (which already has
  `secretsmanager:GetSecretValue`).
- Every email sets **`Reply-To: support@steamuready.com`** so a reply to a
  no-reply address still reaches a monitored inbox instead of silently
  bouncing or vanishing.
- `EMAIL_DRY_RUN=true` logs the composed email (subject + body) to the
  console instead of calling SES — mirrors the existing `SKIP_CTRL_WARM`
  escape hatch, since real sends can't easily be tested locally without
  production SES access.
- Email HTML is built with plain template literals (no templating engine —
  consistent with how `buildCard()` in `public/app.js` already builds HTML
  this way; no new dependency).
- **Every email** (verification, reset, and price-alert digest) shares one
  footer with the support email, Discord link, and Ko-fi link already used
  on the site (`public/index.html`): `support@steamuready.com`,
  `https://discord.gg/XAt8awGUMM`, `https://ko-fi.com/dapperdodger`.

### Raw MIME sending (needed for custom headers)

SES's simple `SendEmailCommand` API cannot set arbitrary headers —
`Reply-To` has a dedicated field, but `List-Unsubscribe` (see below) does
not. `services/email.js` therefore builds a raw MIME message (a
`multipart/alternative` string with `text/plain` and `text/html` parts, via
plain template literals — no new dependency, e.g. no `nodemailer`) and sends
it with `SendRawEmailCommand` for every email, not just the digest. This
keeps one send code path instead of branching between simple and raw
sending depending on message type.

## Deliverability & SES-production-access compliance

AWS reviews every SES production-access request (moving off the sandbox,
which can otherwise only send to pre-verified addresses) against a short,
predictable checklist: how you obtain consent, how you handle bounces and
complaints, and whether there's a working unsubscribe. Addressing all three
up front is the whole point of this section — it avoids a round trip with
AWS support after the fact.

- **Unsubscribe (price-alert digest only — verification/reset are
  transactional, not marketing, and carry no unsubscribe link):**
  - `services/unsubscribeTokens.js` exports `generateUnsubscribeToken(userId)`
    / `verifyUnsubscribeToken(userId, token)`, an **HMAC-SHA256 token keyed
    by a new `UNSUBSCRIBE_SECRET` env var**, not a database row. It's
    stateless (nothing to store or garbage-collect) and non-expiring,
    appropriate because the only action it can ever trigger is flipping
    `alerts_enabled` to `false` — a low-stakes, fully reversible action the
    user can undo in Account Settings, not something that needs per-token
    revocation.
  - Every digest email includes both a human-readable unsubscribe link in
    the body and, per **RFC 8058 (one-click unsubscribe)**, a
    `List-Unsubscribe: <https://.../api/alerts/unsubscribe?u=<userId>&token=...>`
    header plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Mailbox
    providers (Gmail, Outlook, etc.) surface this as a native "Unsubscribe"
    button next to the sender and issue an automated `POST` — this is now a
    de facto deliverability requirement for bulk senders, not just an AWS
    ask.
  - New route `routes/alerts.js`: `GET|POST /api/alerts/unsubscribe` — no
    auth required (that's the point of one-click). `POST` handles the
    mailbox provider's automated request per RFC 8058 and responds `200`
    with an empty body. `GET` handles a human clicking the link inside the
    email body and redirects to `/?unsubscribed=1`. Both set
    `alerts_enabled = false` for the token's user via the same
    `updateAlertSettings`-adjacent DB call.
- **Bounce/complaint handling:** rather than building a custom SNS
  webhook, this relies on **SES's built-in account-level automatic
  suppression list**, enabled via Terraform
  (`aws_sesv2_account_suppression_attributes` with
  `suppressed_reasons = ["BOUNCE", "COMPLAINT"]` in `infra/main.tf`,
  alongside the new IAM permission). SES then stops sending to any address
  that hard-bounces or complains, automatically, with no new application
  code or infrastructure. This is committed as code rather than a manual
  SES-console setting so it isn't a step someone has to remember when
  standing up a new environment.
- **Consent model:** alerts are on by default once a user wishlists a game
  (see Scope above) and gated on `email_verified` — verification itself is
  the proof of a working, user-controlled address. Combined with the
  one-click unsubscribe and the master toggle in Account Settings, this is
  the consent story to describe on the SES production-access request form.
- **Known compliance gap, explicitly not addressed by this pass:** CAN-SPAM
  requires a valid physical postal address in commercial email footers, and
  the price-alert digest (it promotes third-party stores' products, even
  though SteamUReady doesn't profit from the sale) plausibly qualifies as
  commercial email under CAN-SPAM's primary-purpose test regardless of who
  benefits financially. **This implementation ships without a physical
  address in the footer** — deliberately deferred, not an oversight. A PO
  box or similar mailing address must be obtained and added to the digest
  footer (not the verify/reset footer) before this feature is considered
  fully compliant for production use.

## Routes

Extending `routes/auth.js`:

| Endpoint | Behavior |
|---|---|
| `POST /api/auth/signup` (modified) | Also creates an `email_tokens` row (`purpose='verify'`) and sends the verification email |
| `GET /api/auth/verify?token=` | Verifies and marks `email_verified`, redirects to `/?emailVerified=1` |
| `POST /api/auth/resend-verification` | `requireAuth`, rate-limited, no-ops if already verified |
| `POST /api/auth/forgot-password {email}` | Generic response always; emails a reset token if the account exists |
| `POST /api/auth/reset-password {token, newPassword}` | Validates, updates password, invalidates other sessions |

`GET /api/auth/me` gains `emailVerified`, `alertsEnabled`, `alertMode` in its
response.

Extending `routes/me.js`: `PUT /api/me/alert-settings {alertsEnabled,
alertMode}` — `requireAuth`, validates `alertMode` against the three-value
enum.

New `routes/alerts.js`:

| Endpoint | Behavior |
|---|---|
| `GET /api/alerts/unsubscribe?u=&token=` | No auth. Verifies the HMAC token, sets `alerts_enabled = false`, redirects to `/?unsubscribed=1`. |
| `POST /api/alerts/unsubscribe?u=&token=` | No auth. Same verification/effect as `GET`, but responds `200` with an empty body per RFC 8058 one-click unsubscribe (no redirect — the caller is a mailbox provider, not a browser). |

## Frontend UI

- **Login modal**: "Forgot password?" link switches to a reset-request mode
  (email field only, generic confirmation message).
- **Reset landing**: `/?resetToken=...` shows a "Set new password" form
  in-app.
- **Verification banner**: a small persistent (non-blocking) banner shown
  when logged in and unverified, with "Resend verification email"; a toast
  on `/?emailVerified=1`.
- **Account Settings**: new "Email Alerts" section — master on/off toggle
  and a 3-way selector for `alert_mode`.
- **Unsubscribe toast**: a toast on `/?unsubscribed=1` ("You've been
  unsubscribed from price alerts — manage this anytime in Account
  Settings"), same mechanism as the existing `emailVerified` toast.

## Security

- Verification/reset tokens are SHA-256 hashed at rest, single-use,
  `purpose`-scoped, time-limited.
- Password reset invalidates every other session for the account.
- Forgot-password never reveals whether an email is registered.
- AWS credentials for SES are the existing ECS task role — no new secret
  material introduced beyond one new IAM permission.
- The unsubscribe HMAC token is scoped to a single, low-privilege effect
  (setting `alerts_enabled = false`); it cannot be used to read or change
  anything else about the account, so it deliberately doesn't need the
  hashed-at-rest/single-use/expiring properties the verify/reset tokens have.
- `UNSUBSCRIBE_SECRET` is a new required env var (distinct from
  `SESSION_SECRET`), added to `.env.example`.

## Testing

Pure/DB logic gets full `node:test` coverage: token generation/hashing/
expiry, the three `alert_mode` decision functions (against synthetic price
data, no network), the per-region local-hour/fallback computation (against
fixed timezone inputs), the unsubscribe HMAC token
generation/verification, and the raw-MIME builder (asserting the
`List-Unsubscribe`/`List-Unsubscribe-Post`/`Reply-To` headers are present in
the composed message, via `EMAIL_DRY_RUN`'s captured output). Live SES
sends and the actual scheduled job loop are verified manually via
`EMAIL_DRY_RUN` plus one real send — consistent with this codebase's
established pattern (pure logic automated, live network calls manual)
already used in the accounts and Steam import specs.
