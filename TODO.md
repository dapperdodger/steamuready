# TODO

- [x] Multi language support
- [x] Switch Steam scraping to IsThereAnyDeal API
- [x] Saving of preferred devices
- [x] Support additional stores via ITAD (GOG, Epic, Humble, etc.)
- [x] Show if the price is the historical low on game cards — data is already in the API response as `historicalLow { price, cut, shop, timestamp, priceFormatted }`. Display as a badge
- [x] Filter by App (Winlator, Gamenative, Gamehub, Gamehub Lite)
- [ ] ECS readiness
  - [x] Replace in-memory cache with Redis/ElastiCache (required for multi-task cache sharing)
  - [x] Add in-flight request deduplication to prevent cache stampede
  - [x] Add graceful shutdown handler (SIGTERM) for ALB task draining
  - [ ] Tune ECS health check grace period to account for cache warm-up time
  - [x] Consider a dedicated background cache-warmer task so user requests never hit cold paths - not done, decided against
  - [ ] Test ITAD API reachability from AWS datacenter IPs (no scraping risk, but worth confirming)
- [x] Dockerization
- [x] Fix where Seeing some 0% reduction
- [x] Limit max device selection
- [x] Rate Limiting (1 per 30 sec)
- [ ] Konami code easter egg
- [ ] Using GameNative as source alongside emuready
- [ ] Filter/Sorting by reviews (will need to get data as part of cache warmer, and not get it otherwise)

Moral Needs
Contact Emuready sure im not breaking any rules
Contact ITAD to make sure im not breaking their TOS
