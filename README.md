# SteamUReady

Cross-reference [EmuReady](https://www.emuready.com) emulation compatibility data with current deals from Steam, Epic Game Store, and GOG. Find discounted games that run well on your Android handheld.

![SteamUReady](screenshot.png)

## Features

- **Multi-store deal data** — powered by [IsThereAnyDeal](https://isthereanydeal.com/), covering Steam, Epic Game Store, and GOG
- **Full EmuReady catalog** — all compatibility listings, filtered to Android-native apps only (GameNative, GameHub / GameHub Lite, Winlator)
- **Multi-device selection** — pick one or more handhelds (AYN Odin/Thor, Steam Deck, Retroid, etc.); preferred devices saved in localStorage
- **Compatibility filter** — set a minimum emulation performance level (Perfect → Nothing)
- **App filter** — narrow results to a specific app (Winlator, GameNative, GameHub, GameHub Lite)
- **Store filter** — choose which stores to include (Steam, Epic, GOG)
- **Price & discount filters** — min/max price range and minimum discount %
- **Historical low filter** — show only games at or below their all-time lowest price
- **Region selector** — 10 currency regions (USD, EUR GBP, CAD, AUD, BRL, TRY, ARS, PLN)
- **Multi-language UI** — English, French, Spanish
- **Search, sort, paginate** — by name, price, discount, or compatibility
- **Redis caching** — fast repeat loads; title resolution cached 24 h, deal data 15 min

## Requirements

- **Node.js** 20+
- **Redis** — all caching is stored in Redis
  - macOS: `brew install redis && brew services start redis`
  - Linux: `sudo apt install redis-server && sudo systemctl start redis`
  - Windows: [Memurai](https://www.memurai.com/) or WSL with `sudo service redis-server start`
  - Docker: `docker run -d -p 6379:6379 redis`
- **IsThereAnyDeal API key** — free at [isthereanydeal.com/dev/app](https://isthereanydeal.com/dev/app/)

## Quick start

```bash
cp .env.example .env   # fill in ITAD_API_KEY and REDIS_URL
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

Use `npm run dev` for auto-reload during development (requires nodemon).

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ITAD_API_KEY` | Yes | IsThereAnyDeal API key |
| `REDIS_URL` | No | Redis connection string (default: `redis://localhost:6379`) |
| `REFRESH_SECRET` | No | Bearer token to protect `POST /api/refresh` |
| `AWS_SECRETS_ARN` | No | ARN of an AWS Secrets Manager secret to load env vars from (production) |
| `PORT` | No | HTTP port (default: `3000`) |

## How it works

1. **EmuReady** — queries the public tRPC API for device/game/emulator/performance listings, filtered to Android-native apps (GameNative, GameHub, GameHub Lite, Winlator)
2. **Title resolution** — game titles are batch-looked-up via the ITAD `/lookup/id/title/v1` API to get ITAD UUIDs, then Steam `app/` IDs for cover art; results cached 24 h in Redis
3. **Deal data** — ITAD `/games/overview/v2` returns current price, discount, store, and historical low for each resolved title; cached 15 min per region/store combination, updated incrementally
4. **Correlation** — the final game map (EmuReady title → deal entry) is built once per device/region/store combination and cached 15 min in Redis
5. **Rate limiting** — new searches are limited to 10 per 10 s per IP (pagination is exempt); enforced via Redis counters

## API

| Endpoint | Description |
|---|---|
| `GET /api/games` | Correlated games (params: `deviceIds`, `performanceId`, `maxPrice`, `minPrice`, `minDiscount`, `histLow`, `search`, `sort`, `cc`, `page`, `shops`, `apps`) |
| `GET /api/devices` | All EmuReady devices |
| `GET /api/performance-scales` | Performance scale levels |
| `GET /api/regions` | Available currency regions |
| `GET /api/shops` | Available stores for the given `cc` region |
| `GET /api/status` | Health check |
| `POST /api/refresh` | Clear all caches (requires `Authorization: Bearer <REFRESH_SECRET>`) |

## Docker

```bash
docker build -t steamuready .
docker run -e ITAD_API_KEY=your_key -e REDIS_URL=redis://host:6379 -p 3000:3000 steamuready
```

The container uses `startup.js` as its entry point, which can optionally pull secrets from AWS Secrets Manager before booting the app (set `AWS_SECRETS_ARN`).

## Tech stack

- **Backend** — Node.js, Express, Helmet, Axios, Fuse.js
- **Cache** — Redis (via ioredis)
- **Deal data** — IsThereAnyDeal API
- **Compatibility data** — EmuReady tRPC API
- **Frontend** — Vanilla JS, CSS (dark theme), i18n (EN/FR/ES)
- No build step, no framework

## License

MIT
