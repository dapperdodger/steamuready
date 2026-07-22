# Steam Account Linking & Library/Wishlist Import

Status: Draft — approved for planning
Date: 2026-07-22

## Summary

Let a logged-in user (per the accounts spec) link their Steam account and
import their Steam-owned games and wishlist into SteamUReady's own
`owned_games`/`wishlist_items` tables. This is the second of the two specs
remaining after the accounts spec (the other being email alerts +
verification/reset).

## Scope

- **Steam only.** GOG and Epic are explicitly excluded — neither has a
  wishlist/library API usable without the user handing over their actual
  store password, a materially bigger trust/liability step than an
  OpenID-based Steam login. This mirrors the existing exclusion of Epic from
  controller-support data (`server.js`'s `ALLOWED_SHOP_IDS`/emulator-matching
  comments) for the same "no public API" reason.
- Steam is **linked to an existing account**, not used for primary login —
  the user must already be logged in via email/password; linking attaches a
  verified `steam_id` to that account. (The accounts spec already decided
  "email + password, with optional Steam linking later" — this spec is that
  later part.)
- Import is a **manual "Import from Steam" button** — no background job in
  this spec. (A scheduled job is more naturally the alerts spec's problem,
  since that spec needs job-scheduling infrastructure anyway for price
  checks.)
- Re-import performs a **full resync of Steam-sourced items only** — see
  "Import logic" below. This requires `wishlist_items` to carry a `source`
  column (mirroring `owned_games.source` from the accounts spec).
- **Cross-cutting rule, applied everywhere (not just Steam import):** marking
  a game as owned — by any means, manual toggle or Steam import — removes it
  from the wishlist, regardless of how it got onto the wishlist. This
  required amending the already-written accounts spec and plan, which had
  originally specified owned/wishlist as fully independent (see "Amendment to
  the accounts spec" below).

## One-time linking vs. ongoing data reads

These are two different things, and conflating them is the easiest way to
over-build this:

- **Linking** happens once: the user clicks "Link Steam Account," is
  redirected to Steam's OpenID 2.0 login page, and Steam redirects back with
  a cryptographically signed assertion proving "this browser controls SteamID
  X." We verify that signature once and store the resulting `steamid64`
  permanently. There is no token and nothing to refresh — the user is never
  prompted to log into Steam again unless they explicitly unlink and relink.
- **Importing data** happens on demand: every "Import from Steam" click calls
  Steam's public Web API directly using *our own server-side* `STEAM_API_KEY`
  plus the stored `steam_id`. These are not user-delegated OAuth calls — they
  are public reads gated only by the target Steam profile's own privacy
  settings (see "Verified API details" below).

## Verified API details

Verified directly against the live endpoints (not taken from documentation
alone, since Steam's wishlist API has changed backends before):

- `GET https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=<id64>`
  — confirmed via direct request that **no API key is required**: calling
  `ISteamUser/GetPlayerSummaries` without a key returns `400 "Required
  parameter 'key' is missing"`, while calling `GetWishlist` the same way
  returns `200 {"response":{}}` — no key-required error. We pass
  `STEAM_API_KEY` anyway since we already need one for `GetOwnedGames`, and
  it's harmless.
- Response shape (confirmed via a public Steam MCP server's source code, plus
  general documentation consensus):
  `{"response": {"items": [{"appid": number, "priority": number, "date_added": number}, ...]}}`.
  No game name is included — names aren't needed anyway, since games are
  resolved to ITAD ids (see "Import logic") and ITAD supplies the display
  name.
- An empty `{"response":{}}` (no `items` key) happens both when the wishlist
  is genuinely empty **and** when it isn't set to Public — Steam doesn't
  distinguish between these, so neither can this app.
- The old endpoint
  (`store.steampowered.com/wishlist/profiles/<id>/wishlistdata`) is confirmed
  dead (deactivated by Valve, per a third-party tool author's April 2025
  report finding it broken) — `IWishlistService/GetWishlist/v1` is the
  correct current replacement.
- `GetOwnedGames` (`IPlayerService/GetOwnedGames/v1`, officially documented,
  requires `key=`) has the same "Game details privacy must be Public" gating
  — this is long-standing, consistently documented Steam behavior.
- `POST https://api.isthereanydeal.com/lookup/id/shop/61/v1` (shop ID 61 =
  Steam, already used elsewhere in `services/store.js` for the reverse
  lookup) takes a batch of `"app/<appid>"` strings and returns a map to
  ITAD's own game ids — this resolves *any* Steam appid ITAD knows about
  directly by numeric id, with no title-matching step and no dependency on
  the game already being cached in `game_titles`.

## Data model

```sql
ALTER TABLE users ADD COLUMN steam_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN steam_persona_name TEXT;

ALTER TABLE wishlist_items ADD COLUMN source TEXT DEFAULT 'manual';
```

(`steam_id` is `TEXT`, not numeric — SteamID64s are 17-digit values that
exceed the safe range for a JS/JSON number, so they're handled as strings
end-to-end, matching how `steam_app_id` is already stored as `TEXT` in
`game_titles`.)

- `steam_id` is `UNIQUE` — one Steam account links to at most one
  SteamUReady account; linking an already-linked Steam account returns
  `409`.
- `steam_persona_name` is a cached display name (fetched via
  `GetPlayerSummaries` right after linking, refreshed on each import) so the
  UI shows "Linked as *CoolGamer42*" instead of a raw 17-digit id.
- `wishlist_items.source` mirrors `owned_games.source` — needed so resync can
  tell "previously imported from Steam" apart from "added manually" without
  touching the latter.

## Routes

All under `requireAuth` (from the accounts spec's session middleware):

| Endpoint | Behavior |
|---|---|
| `GET /api/steam/link` | Redirects to Steam's OpenID login page (via the `openid` npm package, stateless mode — chosen over Passport + passport-steam because this is an attach-to-existing-session flow, not a login flow; Passport's `req.login()`/serialization model would introduce a second, competing session concept alongside the one already built in the accounts spec) |
| `GET /api/steam/callback` | Verifies the OpenID assertion, extracts `steamid64`, `409`s if already linked to a different account, fetches persona name, saves `steam_id`/`steam_persona_name`, redirects to account settings |
| `POST /api/steam/unlink` | Clears `steam_id`/`steam_persona_name`; does **not** remove already-imported games — they simply stop resyncing |
| `POST /api/steam/import` | Runs the import logic below; `400` if no Steam account is linked |

## Import logic (`POST /api/steam/import`)

1. Call `GetOwnedGames` (`include_appinfo=false` — names aren't needed) and
   `GetWishlist` in parallel.
2. Collect all appids from both, batch them as `app/<id>` strings through
   ITAD's `/lookup/id/shop/61/v1` (200 per batch, matching the existing
   batching pattern in `services/store.js`) to get `itad_id`s. Appids ITAD
   doesn't recognize are silently dropped.
3. Resync owned games: upsert `(userId, itadId, source='steam')` for each
   resolved owned appid; delete existing `owned_games` rows where
   `source='steam'` and the `itad_id` is no longer in the fresh set.
4. Resync wishlist: same upsert/delete pattern against `wishlist_items`.
5. **Cross-removal**: delete any `wishlist_items` row — regardless of
   `source` — whose `itad_id` is in the just-computed owned set.
6. Return `{ownedCount, wishlistCount}` so the UI can display a summary.

## Frontend UI

All additions live in the Account Settings page (from the accounts spec)
under a new "Connected Accounts" section:

- **Not linked**: "Link Steam Account" button → full-page redirect to
  `GET /api/steam/link` (not a fetch call, since it must leave the site).
- **Linked**: "Linked as *{steam_persona_name}*", an "Import from Steam"
  button, a **persistent hint below the button** — always visible, not just
  after a failed import — stating that Steam's game-details and wishlist
  privacy must be set to Public (with a link to
  `steamcommunity.com/my/edit/settings`), and an "Unlink" button (confirm
  dialog, same pattern as delete-account).
- **After import**: shows the `{ownedCount, wishlistCount}` summary. If both
  are zero, the persistent hint already covers the likely explanation — no
  separate reactive message needed.
- The OpenID callback redirect is a full page load, not a fetch response, so
  the settings page reads a query param (e.g. `?steamLinked=1` or
  `?steamError=already_linked`) to show a success/error toast after
  redirecting back.

## Security

- OpenID assertion verification is delegated to the `openid` package, which
  validates Steam's cryptographic signature — the server never trusts a
  client-supplied `steamid`, only one extracted from a verified assertion.
- `steam_id` uniqueness is enforced at the database level, not just in
  application code.
- `STEAM_API_KEY` is server-side only, never sent to the client.
- All Steam/ITAD calls happen server-to-server; the import route itself
  requires an authenticated session.

## Testing

The resync logic (diff/upsert/delete/cross-removal, once given a resolved
list of `itad_id`s) is pure DB logic and gets automated `node:test` coverage
against a real Postgres instance — the same approach used for
`services/wishlist.js` in the accounts spec. The OpenID handshake and live
Steam/ITAD network calls are verified manually, consistent with this
codebase's existing lack of HTTP-mocking infrastructure (`services/store.js`
and `services/steamcontroller.js` have no automated tests for their network
calls either, and introducing an HTTP-mocking library is out of scope here).

## Amendment to the accounts spec

`docs/superpowers/specs/2026-07-22-accounts-wishlist-owned-design.md`
originally specified owned games and the wishlist as fully independent (its
Task 10 test, in the corresponding plan, explicitly asserted that marking a
game owned does *not* affect the wishlist). This spec's cross-removal rule
supersedes that: **marking a game owned, by any means, now always removes it
from the wishlist.** The accounts plan's Task 10 needs updating before
execution to drop the "owned is independent of wishlist" test in favor of the
new rule.
