# TODO

- [x] Multi language support
- [x] Switch Steam scraping to IsThereAnyDeal API
- [x] Saving of preferred devices
- [x] Support additional stores via ITAD (GOG, Epic, Humble, etc.)
- [ ] Filter/Sorting by reviews
- [ ] Dockerization
- [ ] ECS readiness
  - [ ] Replace in-memory cache with Redis/ElastiCache (required for multi-task cache sharing)
  - [ ] Add in-flight request deduplication to prevent cache stampede
  - [ ] Add graceful shutdown handler (SIGTERM) for ALB task draining
  - [ ] Tune ECS health check grace period to account for cache warm-up time
  - [ ] Consider a dedicated background cache-warmer task so user requests never hit cold paths
  - [ ] Test ITAD API reachability from AWS datacenter IPs (no scraping risk, but worth confirming)
- [ ] Using GameNative as source alongside emuready
- [ ] Show if the price is the historical low on game cards — data is already in the API response as `historicalLow { price, cut, shop, timestamp, priceFormatted }`. Display as a badge
- [ ] Filter by App (Winlator, Gamenative, Gamehub/Lite)
