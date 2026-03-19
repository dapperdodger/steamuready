# SteamUReady

Cross-reference [EmuReady](https://www.emuready.com) emulation compatibility data with current Steam sales. Find discounted games that run well on your handheld device.

![SteamUReady](screenshot.png)

## Features

- **Full EmuReady catalog** — loads all 11,000+ compatibility listings
- **Full Steam sale catalog** — scrapes all 6,000+ currently discounted games
- **Fuzzy matching** — correlates game titles between both sources with structural validation
- **Multi-device selection** — pick one or more handhelds (AYN Odin/Thor, Steam Deck, Retroid, etc.)
- **Compatibility filter** — set a minimum emulation performance level (Perfect → Nothing)
- **Price & discount filters** — max price, minimum discount %
- **Region selector** — 10 Steam store regions (USD, EUR, GBP, BRL, TRY, ARS, PLN, etc.)
- **Search, sort, paginate** — by name, price, discount, compatibility
- **Smart caching** — first load ~3 min, then instant (~15ms) for 15–30 min

## Requirements

- **Node.js** 18+
- **Redis** — used for caching EmuReady and Steam data between requests. Must be running before starting the server.
  - macOS: `brew install redis && brew services start redis`
  - Linux: `sudo apt install redis-server && sudo systemctl start redis`
  - Windows: [Memurai](https://www.memurai.com/) or WSL with `sudo service redis-server start`
  - Docker: `docker run -d -p 6379:6379 redis`

## Quick start

```bash
cp .env.example .env   # set REDIS_URL if not using the default localhost:6379
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

The first request will take ~3 minutes while it fetches all EmuReady listings (111 pages) and Steam sale pages (67+ pages). Subsequent requests are served from Redis cache.

Use `npm run dev` for auto-reload during development (requires nodemon).

## How it works

1. **EmuReady** — queries the public tRPC API to fetch all device/game/emulator/performance listings
2. **Steam** — scrapes the Steam store search results (HTML) for all currently discounted games
3. **Correlation** — uses [Fuse.js](https://fusejs.io/) fuzzy matching to find EmuReady games in the Steam sale catalog, with structural validation to avoid false positives
4. **Caching** — raw data and correlation results are cached in Redis (EmuReady 30 min, Steam 15 min, correlation map 15 min). In-flight request deduplication prevents cache stampedes on cold starts.

## API

| Endpoint | Description |
|---|---|
| `GET /api/games` | Correlated games (params: `deviceIds`, `performanceId`, `maxPrice`, `minDiscount`, `search`, `sort`, `cc`, `page`) |
| `GET /api/devices` | All EmuReady devices |
| `GET /api/performance-scales` | Performance scale levels |
| `GET /api/regions` | Available Steam store regions |
| `POST /api/refresh` | Clear all caches |

## Tech stack

- **Backend** — Node.js, Express, Axios, Cheerio, Fuse.js
- **Cache** — Redis (via ioredis)
- **Frontend** — Vanilla JS, CSS (dark theme)
- No build step, no framework

## License

MIT
