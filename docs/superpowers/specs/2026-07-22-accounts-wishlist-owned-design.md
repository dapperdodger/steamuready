# Optional Accounts: Wishlist, Owned Games, and Synced Preferences

Status: Draft — approved for planning
Date: 2026-07-22

**Amendment (2026-07-23):** Added a "Hide Game" feature — see the `hidden_games`
table, the state-interplay rule, the `/api/me/hidden` endpoints, and the
Frontend UI updates below (all marked as part of this amendment).

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

Additions to `services/db.js` (originally three tables; `hidden_games` added
2026-07-23):

```sql
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

-- Added 2026-07-23 amendment (Hide Game)
CREATE TABLE IF NOT EXISTS hidden_games (
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  itad_id    TEXT NOT NULL,
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
  - Note (added 2026-07-22): the exact-correlation rework
    (`docs/superpowers/specs/2026-07-22-exact-correlation-design.md`) makes
    `game_titles.steam_app_id` **authoritative** (sourced from EmuReady rather
    than derived from ITAD). This only improves the accuracy of the
    `steam_app_id` that `buildItadIdEntry` reads; the `itad_id` keying here is
    unchanged, so this spec's data model is unaffected.
- `owned_games.source` defaults to `'manual'` now, but exists so the future
  import spec can write `'steam'`/`'gog'`/etc. without a migration.
- `hidden_games` (2026-07-23 amendment) has no `source` column — hiding is
  always a manual, explicit user action, unlike owned games which can arrive
  via import.
- `users.preferences` is a JSONB blob mirroring the shape currently written to
  localStorage (devices/chipset selection, compat minimum, region, stores,
  filter mode) rather than structured columns — nothing server-side needs to
  query into these fields, and it avoids a migration every time a new filter
  option is added. This blob is reserved for filters that also have an
  anonymous/logged-out equivalent; auth-only settings get their own column
  (see `hide_owned_default` below, and `alert_mode` in the email-alerts spec).
- `users.hide_owned_default` (2026-07-23 amendment) is a plain `BOOLEAN`
  column, not part of the `preferences` blob — it has no logged-out
  equivalent (the hide-owned checkbox is hidden from the filter panel
  entirely for anonymous users, since it depends on account-only owned-games
  data), so it doesn't belong in the anonymous-mirrored blob.
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
| `GET /api/auth/me` | Yes | Returns `{email, preferences, hideOwnedDefault}`; `401` if not logged in *(`hideOwnedDefault` added in the 2026-07-23 amendment)* |
| `PUT /api/me/preferences` | Yes | Body = preferences blob; overwrites `users.preferences` |
| `PUT /api/me/hide-owned-default` | Yes | *(2026-07-23 amendment)* Body `{hideOwnedDefault: boolean}`; overwrites `users.hide_owned_default` — separate endpoint from `/preferences` since it's a dedicated column, not part of the blob |
| `GET /api/me/wishlist` | Yes | List of wishlisted games (joined with `game_titles` + live price data for rendering as cards) |
| `POST /api/me/wishlist/:itadId` | Yes | Add to wishlist |
| `DELETE /api/me/wishlist/:itadId` | Yes | Remove from wishlist |
| `GET /api/me/owned` | Yes | List of owned games (same join shape as wishlist) |
| `POST /api/me/owned/:itadId` | Yes | Mark owned (`source = 'manual'`); also deletes any `wishlist_items` row and any `hidden_games` row for the same `itad_id` (see below) |
| `DELETE /api/me/owned/:itadId` | Yes | Unmark owned |
| `GET /api/me/hidden` | Yes | *(2026-07-23 amendment)* List of hidden games — `{itadId, name}` only, no price/image lookup (this is a lightweight management list, not a card grid) |
| `POST /api/me/hidden/:itadId` | Yes | *(2026-07-23 amendment)* Hide the game; also deletes any `wishlist_items` row for the same `itad_id` |
| `DELETE /api/me/hidden/:itadId` | Yes | *(2026-07-23 amendment)* Unhide |

**Owned implies not-wishlisted:** marking a game owned — via this endpoint or
via the Steam import spec's resync — always removes it from the wishlist,
regardless of how it originally got onto the wishlist (manually added or
previously imported). Owning a game and still wanting it is contradictory, so
this rule is unconditional rather than scoped to any one entry point.
(**Amendment**, added after the Steam import spec was brainstormed: this
spec's Task 10 originally specified owned/wishlist as fully independent —
that has been superseded by this rule.)

**State interplay with hidden games (2026-07-23 amendment):** two more
unconditional rules, extending the one above:

- Hiding a game (`POST /api/me/hidden/:itadId`) always removes any
  `wishlist_items` row for it — "don't show me this" is incompatible with
  "I want this."
- Marking a game owned always removes any `hidden_games` row for it, in
  addition to already clearing the wishlist — owning it supersedes hiding it.
- There is no rule in the other direction: unhiding a game does not restore
  any prior wishlist state.

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
- **Game cards**: a wishlist toggle button (heart) added to `card-footer`,
  greyed out with a tooltip explaining the need to log in when not
  authenticated. Optimistic UI update on click, backed by the corresponding
  POST/DELETE call. *(2026-07-23 amendment: the previously-separate owned
  toggle button is replaced by an overflow (`⋯`) menu — see below — so the
  footer only carries the heart as a standalone icon.)*
- **Card overflow menu** *(2026-07-23 amendment)*: a `⋯` button on each card
  opens a small dropdown with two actions: "Mark as owned" / "Remove from
  owned" (replaces the old checkmark button, same toggle semantics) and
  "Hide this game". Choosing Hide optimistically fades the card out of the
  grid immediately and shows a toast ("Game hidden — Undo") for ~6 seconds;
  clicking Undo within that window restores the card and calls
  `DELETE /api/me/hidden/:itadId`; letting it expire finalizes the hide (the
  `POST` already fired when the action was chosen).
- **Hidden games are invisible everywhere** *(2026-07-23 amendment)*: once
  hidden, a game is unconditionally excluded from `/api/games` results for
  that user (not an opt-in filter — always applied when logged in). The only
  way to see a hidden game again is the management list below.
- **My Wishlist / My Games view**: new view reusing the existing card-grid
  rendering, fed by `/api/me/wishlist` / `/api/me/owned` instead of
  `/api/games`.
- **Manage hidden games** *(2026-07-23 amendment)*: a simple list view
  (title + Unhide button per row, no card/price rendering — deliberately
  lighter-weight than the wishlist/owned views since it's a maintenance
  screen, not a browsing one) reachable from Account Settings, fed by
  `GET /api/me/hidden`.
- **Hide-owned filter**: checkbox in the existing sidebar filter panel,
  shown only when logged in; when checked, excludes the user's owned
  `itad_id`s from `/api/games` results. *(2026-07-23 amendment: this
  checkbox's state now syncs to `users.hide_owned_default` via
  `PUT /api/me/hide-owned-default`, seeded from `GET /api/auth/me`'s
  `hideOwnedDefault` field on login, instead of resetting every session. Kept
  as its own endpoint/column rather than joining the `preferences` blob,
  since it has no anonymous equivalent — see Data model.)*
- **Account settings page**: email (read-only), change password (requires
  current password), delete account, an editable view of the synced
  preferences (devices/chipset, compat minimum, region, stores, filter mode)
  matching what's editable via the existing preferred-settings modal, and
  *(2026-07-23 amendment)* a link to the "Manage hidden games" list above.
- **Preferences sync**: logged-out behavior is unchanged (localStorage,
  exactly as today). On login, `GET /api/auth/me` returns `preferences`,
  which takes over as the source of truth; subsequent changes call
  `PUT /api/me/preferences` instead of (or in addition to) localStorage.
  The `hide_owned_default` column (2026-07-23 amendment) syncs the same way
  but through its own field/endpoint, not the `preferences` blob (see Data
  model and API above).

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
restart (since sessions live in Redis, not in-process). *(2026-07-23
amendment: also covers hiding a game from the overflow menu, the undo toast,
confirming a hidden game never appears in `/api/games` results, marking a
hidden game owned un-hides it, and unhiding via the "Manage hidden games"
list.)*
