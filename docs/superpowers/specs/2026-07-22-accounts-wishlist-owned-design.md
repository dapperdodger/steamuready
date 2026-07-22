# Optional Accounts: Wishlist, Owned Games, and Synced Preferences

Status: Draft — approved for planning
Date: 2026-07-22

## Summary

Add an optional user account system (email + password) so users can mark games
as wishlisted or owned, and have their filter preferences (currently
localStorage-only) synced to their account. This is the first of several
specs that will eventually cover: this one (accounts + manual tracking),
password reset / email verification, price-drop email alerts, and importing
wishlist/owned games from Steam and other stores.

## Explicitly out of scope (future specs)

- Email verification and password reset (needs email-sending infra — bundled
  with the alerts spec, since that spec needs email infra anyway)
- Price-drop email alerts (background job + email sending)
- Importing wishlist/owned games from Steam, GOG, Epic, or other platforms
  (Steam has a usable Web API; GOG/Epic have no public wishlist/library API,
  same constraint already noted for controller-support data — that spec will
  need to scope realistically per platform)

Accounts are fully optional. Anonymous/logged-out use continues to work
exactly as it does today (localStorage-driven preferences, no wishlist/owned
tracking).

## Data model

Three additions to `services/db.js`:

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

Notes:

- `id` is a UUID (via `gen_random_uuid()`, built into Postgres core since v13)
  rather than a serial integer, since it's exposed to the client (session
  payload, API responses).
- Wishlist/owned rows key on `itad_id` (ITAD's UUID from `game_titles`), not
  `steam_app_id`, so non-Steam-only titles (GOG/Epic exclusives) can still be
  tracked once cross-store data exists. This differs from `controller_support`
  and `igdb_mappings`, which key on `steam_app_id` for Steam-specific data —
  intentional, since wishlist/owned status isn't Steam-specific.
- `owned_games.source` defaults to `'manual'` now, but exists so the future
  import spec can write `'steam'`/`'gog'`/etc. without a migration.
- `users.preferences` is a JSONB blob mirroring the shape currently written to
  localStorage (devices/chipset selection, compat minimum, region, stores,
  filter mode) rather than structured columns — nothing server-side needs to
  query into these fields, and it avoids a migration every time a new filter
  option is added.
- Sessions are NOT stored in Postgres — they live in Redis via
  `connect-redis`, consistent with the existing "Redis = volatile,
  Postgres = durable" split described in the README.

## Auth flow

- **Library**: `bcrypt`, cost factor 12, for password hashing. Passwords are
  never logged or returned in any API response.
- **Sessions**: `express-session` + `connect-redis`, using the existing
  `redis` client from `services/cache.js`. Cookie: `httpOnly: true`,
  `sameSite: 'lax'`, `secure: true` in production (TLS already terminates at
  the ALB). `sameSite: 'lax'` is sufficient CSRF mitigation for this JSON API
  (blocks cross-site cookie submission on non-GET requests) without a
  separate CSRF token scheme.
- **No email verification or password reset in this spec** — signup is just
  email + password, immediately usable. This is a deliberate scope cut; users
  who typo their email have no recovery path until the alerts spec lands
  password reset alongside its email infra.

## API

New endpoints in `server.js` (or split into `routes/auth.js` /
`routes/me.js` if `server.js`'s current 547 lines make that worthwhile at
implementation time):

| Endpoint | Auth required | Behavior |
|---|---|---|
| `POST /api/auth/signup` | No | `{email, password}` → validate, hash, insert `users` row, create session |
| `POST /api/auth/login` | No | `{email, password}` → verify via `bcrypt.compare`, create session on success; generic "invalid email or password" error on any failure (no user enumeration) |
| `POST /api/auth/logout` | Yes | Destroy session, clear cookie |
| `GET /api/auth/me` | Yes | Returns `{email, preferences}`; `401` if not logged in |
| `PUT /api/me/preferences` | Yes | Body = preferences blob; overwrites `users.preferences` |
| `GET /api/me/wishlist` | Yes | List of wishlisted games (joined with `game_titles` + live price data for rendering as cards) |
| `POST /api/me/wishlist/:itadId` | Yes | Add to wishlist |
| `DELETE /api/me/wishlist/:itadId` | Yes | Remove from wishlist |
| `GET /api/me/owned` | Yes | List of owned games (same join shape as wishlist) |
| `POST /api/me/owned/:itadId` | Yes | Mark owned (`source = 'manual'`) |
| `DELETE /api/me/owned/:itadId` | Yes | Unmark owned |

Every `/api/me/*` route reads `req.session.userId` for authorization — no
route trusts a client-supplied user id.

**Rate limiting**: `/api/auth/signup` and `/api/auth/login` get their own
Redis-counter-based limiter (5 requests/min/IP), following the same pattern
as the existing `gamesRateLimiter`, but separate from it since these are
higher-value brute-force/enumeration targets.

## Frontend UI

- **Header**: extend `header-actions` with an account menu. Logged out:
  "Log in / Sign up". Logged in: user's email + dropdown (My Wishlist, My
  Games, Account Settings, Log out).
- **Login/signup modal**: reuse the existing `modal-overlay`/`modal` pattern
  (same structure as `prefDevicesModal` in `index.html`).
- **Game cards**: two icon toggle buttons added to `card-footer` — wishlist
  (heart) and owned (checkmark). Optimistic UI update on click, backed by the
  corresponding POST/DELETE call.
- **My Wishlist / My Games view**: new view reusing the existing card-grid
  rendering, fed by `/api/me/wishlist` / `/api/me/owned` instead of
  `/api/games`.
- **Hide-owned filter**: checkbox in the existing sidebar filter panel;
  when checked and logged in, excludes the user's owned `itad_id`s from
  `/api/games` results.
- **Account settings page**: email (read-only), change password (requires
  current password), delete account, and an editable view of the synced
  preferences (devices/chipset, compat minimum, region, stores, filter mode)
  matching what's editable via the existing preferred-settings modal.
- **Preferences sync**: logged-out behavior is unchanged (localStorage,
  exactly as today). On login, `GET /api/auth/me` returns `preferences`,
  which takes over as the source of truth; subsequent changes call
  `PUT /api/me/preferences` instead of (or in addition to) localStorage.

## Security

- Passwords: bcrypt cost 12, never logged/returned.
- Session cookie: `httpOnly`, `secure` (prod), `sameSite: 'lax'`.
- Auth endpoints rate-limited separately from the games endpoint.
- Input validation: email format, password minimum length 8.
- Login errors are generic regardless of whether the email exists or the
  password is wrong.
- No route trusts a client-supplied user id — always derived from session.

## Testing

Manual verification (via the `run` skill once implemented) covering:
signup, login, logout, wishlist add/remove, owned add/remove, hide-owned
filter, preference sync on login, and session persistence across a server
restart (since sessions live in Redis, not in-process).
