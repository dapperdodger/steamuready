# SteamUReady

Cross-reference [EmuReady](https://www.emuready.com) emulation compatibility data with current deals from Steam, Epic Game Store, and GOG. Find discounted games that run well on your Android handheld.

![SteamUReady](public/screenshot.png)

## Features

- **Multi-store deal data** — powered by [IsThereAnyDeal](https://isthereanydeal.com/), covering Steam, Epic Game Store, and GOG
- **Full EmuReady catalog** — all compatibility listings, filtered to Android-native apps only (GameNative, GameHub / GameHub Lite, Winlator)
- **Multi-device / chipset selection** — filter by individual handhelds or by SoC (Snapdragon, Dimensity, etc.); preferred devices saved in localStorage
- **Compatibility filter** — set a minimum emulation performance level (Perfect → Nothing)
- **App filter** — narrow results to a specific app (Winlator, GameNative, GameHub, GameHub Lite)
- **Store filter** — choose which stores to include (Steam, Epic, GOG)
- **Controller support filter** — filter by Steam controller support level (Full / Partial / None)
- **IGDB ratings** — sort and filter by combined user + critic score
- **Price & discount filters** — min/max price range and minimum discount %
- **Historical low filter** — show only games at or below their all-time lowest price
- **Historical low badge** — at-a-glance indicator when a game hits its all-time low
- **Region selector** — 10 currency regions (USD, EUR, GBP, CAD, AUD, BRL, TRY, ARS, PLN)
- **Multi-language UI** — English, French, Spanish, German
- **Search, sort, paginate** — by name, price, discount, compatibility, or rating
- **Two-tier caching** — Redis for volatile price/correlation data; PostgreSQL for stable reference data (title mappings, controller support, IGDB ratings)
- **Exact Steam App ID correlation** — games are matched to deals via their Steam App ID (EmuReady's own title lookup → ITAD's exact shop lookup), falling back to fuzzy title matching only when no Steam App ID is resolvable
- **Optional accounts** — email/password login; wishlist games, mark them owned, or hide ones you don't want to see again, saved to your account instead of just the browser
- **Steam library import** — link your Steam account (OpenID) and import your owned games + wishlist in one click; re-importing keeps them in sync (adds new, removes stale) without touching anything added manually
- **My Games / My Wishlist** — dedicated tracked-game views; My Games shows EmuReady compatibility (device, emulator, rank, and a link to the listing) using your saved device/SoC preference instead of price, since you already own it
- **Price-drop email alerts** — opt-in notifications when a wishlisted game goes on sale, with a configurable alert mode (every price drop / once per sale / all-time low only) and one-click unsubscribe

## Requirements

- **Node.js** 20+
- **Redis** — volatile caching (prices, correlation maps)
  - macOS: `brew install redis && brew services start redis`
  - Linux: `sudo apt install redis-server && sudo systemctl start redis`
  - Windows: [Memurai](https://www.memurai.com/) or WSL with `sudo service redis-server start`
  - Docker: `docker run -d -p 6379:6379 redis`
- **PostgreSQL** 14+ — persistent reference data (title mappings, controller support, IGDB ratings)
  - macOS: `brew install postgresql@16 && brew services start postgresql@16`
  - Linux: `sudo apt install postgresql && sudo systemctl start postgresql`
  - Docker: `docker run -d -p 5432:5432 -e POSTGRES_DB=steamuready -e POSTGRES_PASSWORD=postgres postgres:16`
  - Or use [docker-compose.yml](#local-development-with-docker-compose) below
- **IsThereAnyDeal API key** — free at [isthereanydeal.com/dev/app](https://isthereanydeal.com/dev/app/)

## Quick start

```bash
cp .env.example .env   # fill in ITAD_API_KEY, REDIS_URL, DATABASE_URL
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

Use `npm run dev` for auto-reload during development (requires nodemon).

## Local development with Docker Compose

```bash
docker compose up -d   # starts Redis + PostgreSQL
npm install
npm start
```

See [docker-compose.yml](docker-compose.yml) for the full configuration.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ITAD_API_KEY` | Yes | IsThereAnyDeal API key |
| `DATABASE_URL` | Yes | PostgreSQL connection string (e.g. `postgresql://localhost:5432/steamuready`) |
| `REDIS_URL` | No | Redis connection string (default: `redis://localhost:6379`) |
| `IGDB_CLIENT_ID` | No | Twitch app client ID — enables IGDB ratings (register at [dev.twitch.tv/console](https://dev.twitch.tv/console)) |
| `IGDB_CLIENT_SECRET` | No | Twitch app client secret |
| `REFRESH_SECRET` | No | Bearer token to protect `POST /api/refresh` |
| `AWS_SECRETS_ARN` | No | ARN of an AWS Secrets Manager secret to load env vars from (production) |
| `PORT` | No | HTTP port (default: `3000`) |
| `SESSION_SECRET` | Yes, if accounts used | Secret used to sign session cookies — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `STEAM_API_KEY` | Yes, if Steam import used | Steam Web API key, free at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) — used for `GetOwnedGames`, `GetWishlist`, `GetPlayerSummaries` |
| `SES_FROM_EMAIL` | Yes, if email alerts enabled | Sender address for verification/reset/alert emails — must be a verified SES identity |
| `UNSUBSCRIBE_SECRET` | Yes, if email alerts enabled | HMAC secret used to sign one-click unsubscribe links (production); the app fails to start without it unless `EMAIL_DRY_RUN=true` |
| `APP_BASE_URL` | Yes, if email alerts enabled | Base URL used to build links in emails sent from the background price-alert job (which has no HTTP request to derive one from) |
| `EMAIL_DRY_RUN` | No | Set to `true` to log composed emails to the console instead of calling SES (local dev/tests only) |

## How it works

1. **EmuReady** — queries the public tRPC API for device/game/emulator/performance listings, filtered to Android-native apps
2. **Title resolution** — EmuReady titles are resolved to Steam App IDs via EmuReady's own `getBestSteamAppId`, then to ITAD UUIDs via ITAD's exact `/lookup/id/shop/61/v1` (Steam shop) lookup; titles with no resolvable Steam App ID (or that ITAD doesn't recognize) fall back to ITAD's fuzzy `/lookup/id/title/v1` lookup. Results are stored permanently in PostgreSQL (`game_titles` table, tagged with which method resolved them — `resolved_via`) and only re-fetched for new/never-resolved titles
3. **Deal data** — ITAD `/games/overview/v2` returns current price, discount, store, and historical low for each resolved title; cached 1 h per region/store combination in Redis, updated incrementally
4. **Controller support** — fetched from the Steam store API (category IDs 28 = full, 18 = partial) and stored permanently in PostgreSQL; only missing entries are fetched at startup via `warmMissing()`
5. **IGDB ratings** — resolved via the IGDB API using the Steam app ID, cached in PostgreSQL for 7 days; covers total rating, user rating, and critic rating
6. **Correlation** — the final game map (EmuReady title → deal entry) is built once per device/region/store combination and cached 1 h in Redis
7. **Rate limiting** — new searches are limited to 10 per 10 s per IP (pagination exempt); enforced via Redis counters

## Accounts, wishlist & Steam import

Creating an account (email + password) unlocks:

- **Wishlist / owned / hidden tracking** — mark games you want, already own, or never want to see again; saved to your account (Redis-backed sessions), not just the browser
- **My Wishlist** — a dedicated view of wishlisted games with the same price/discount tracking as search results
- **My Games** — a dedicated view of owned games showing EmuReady compatibility (device, emulator, performance rank, and a link to the EmuReady listing) instead of price — there's no reason to show sale prices for something you already own. Compatibility picks respect your saved device/SoC preference, editable in place from the page
- **Steam account linking** — link your Steam account via OpenID from Account Settings (no password is ever shared with this app)
- **Steam library import** — pulls owned games and wishlist from Steam's Web API, resolved to deals the same way as the main catalog (exact Steam App ID correlation). Only imports games EmuReady actually has a Windows-capable emulator listing for, and backfills their name/image so they render correctly everywhere. Re-importing fully resyncs Steam-sourced entries — adds new, removes stale — without touching anything added manually. Both game-details and wishlist visibility must be set to **Public** on your Steam profile (`steamcommunity.com/my/edit/settings`) for import to see them
- **Price-drop email alerts** — opt in to get emailed when a wishlisted game's price drops, with three alert modes (every drop, once per sale, or only at an all-time low); requires email verification to send, and every email includes a one-click unsubscribe link (RFC 8058)

## Seeding controller support

On first startup `warmMissing()` will fetch controller support from Steam for all known games. This takes ~10 minutes (Steam enforces ~40 req/min). To skip this on new deployments, pre-generate a seed file and import it:

```bash
# 1. Generate seed (requires DATABASE_URL to read game_titles)
node scripts/seed-controller-support.js

# 2. Import seed into a fresh DB
node scripts/import-controller-support.js
```

The seed file is written to `seeds/controller_support.json` and can be committed to the repo.

## API

| Endpoint | Description |
|---|---|
| `GET /api/games` | Correlated games (params: `deviceIds`, `socIds`, `compatRankMin`, `compatRankMax`, `maxPrice`, `minPrice`, `minDiscount`, `histLow`, `minRating`, `controllerSupport`, `search`, `sort`, `cc`, `page`, `shops`, `apps`, `newAge`) |
| `GET /api/devices` | All EmuReady devices |
| `GET /api/socs` | All EmuReady SoCs with listing counts |
| `GET /api/performance-scales` | Performance scale levels |
| `GET /api/regions` | Available currency regions |
| `GET /api/shops` | Available stores for the given `cc` region |
| `GET /api/status` | Health check + cache readiness flags |
| `POST /api/refresh` | Clear all caches (requires `Authorization: Bearer <REFRESH_SECRET>`) |
| `POST /api/auth/signup` | Create an account (params: `email`, `password`) |
| `POST /api/auth/login` | Log in (params: `email`, `password`) |
| `POST /api/auth/logout` | Log out |
| `GET /api/auth/me` | Current user's email + preferences + hideOwnedDefault, or `401` |
| `GET /api/auth/verify` | Verify email address from a link sent at signup |
| `POST /api/auth/resend-verification` | Resend the verification email (requires login) |
| `POST /api/auth/forgot-password` | Request a password-reset email |
| `POST /api/auth/reset-password` | Reset password using a token from the email |
| `PUT /api/me/preferences` | Save filter preferences for the logged-in user (also drives My Games' compatibility picks) |
| `PUT /api/me/hide-owned-default` | Save the logged-in user's hide-owned-games default |
| `PUT /api/me/password` | Change password |
| `PUT /api/me/alert-settings` | Save price-alert settings (params: `alertsEnabled`, `alertMode`) |
| `DELETE /api/me` | Delete the account |
| `GET /api/me/wishlist` | Logged-in user's wishlisted games (price/discount data) |
| `POST /api/me/wishlist/:itadId` | Add a game to the wishlist |
| `DELETE /api/me/wishlist/:itadId` | Remove a game from the wishlist |
| `GET /api/me/owned` | Logged-in user's owned games, with EmuReady compatibility instead of price |
| `POST /api/me/owned/:itadId` | Mark a game as owned |
| `DELETE /api/me/owned/:itadId` | Unmark a game as owned |
| `GET /api/me/hidden` | Logged-in user's hidden games (title only, no price) |
| `POST /api/me/hidden/:itadId` | Hide a game |
| `DELETE /api/me/hidden/:itadId` | Unhide a game |
| `GET /api/steam/link` | Redirects to Steam's OpenID login to link your Steam account |
| `GET /api/steam/callback` | Steam OpenID return URL — completes the link |
| `POST /api/steam/unlink` | Unlink the Steam account (already-imported games are kept) |
| `GET /api/steam/status` | Whether a Steam account is linked, and its persona name |
| `POST /api/steam/import` | Import/resync owned games + wishlist from Steam |
| `GET /api/alerts/unsubscribe` | One-click unsubscribe from price alerts (RFC 8058) |

## Docker

```bash
docker build -t steamuready .
docker run \
  -e ITAD_API_KEY=your_key \
  -e DATABASE_URL=postgresql://host:5432/steamuready \
  -e REDIS_URL=redis://host:6379 \
  -p 3000:3000 \
  steamuready
```

The container uses `startup.js` as its entry point, which can optionally pull secrets from AWS Secrets Manager before booting the app (set `AWS_SECRETS_ARN`).

## Tech stack

- **Backend** — Node.js, Express, Helmet, Axios, Fuse.js
- **Accounts** — bcrypt, express-session + connect-redis (Redis-backed sessions), Steam OpenID via the `openid` package
- **Email** — AWS SES (verification, password reset, price-drop digests)
- **Persistent cache** — PostgreSQL (via pg) — title mappings, controller support, IGDB ratings, wishlist/owned/hidden state
- **Volatile cache** — Redis (via ioredis) — prices, correlation maps, sessions, rate limiting
- **Deal data** — IsThereAnyDeal API
- **Ratings** — IGDB API (via Twitch OAuth)
- **Compatibility data** — EmuReady tRPC API
- **Frontend** — Vanilla JS, CSS (dark theme), i18n (EN/FR/ES/DE)
- No build step, no framework

## License

MIT
