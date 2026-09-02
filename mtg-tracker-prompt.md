# Project: Open-source MTG collection value tracker

## Goal
Build a free, open-source, self-hosted web app that replicates two specific features of getcollectr.com for Magic: The Gathering cards only:
1. https://getcollectr.com/track — real-time portfolio tracking, charted over time like a stock portfolio
2. https://getcollectr.com/prices — individual card price history lookup

This is a personal/single-user project to start (see Auth section). No paywall, no subscription — this replaces an expensive annual plan with a free self-hosted alternative.

## Feature 1: Portfolio tracking (priority)
- User adds cards to their collection (search by name, select specific printing/set/foil status/condition)
- Each holding records: card printing (Scryfall `id`, not just `oracle_id` — price varies by printing), quantity, foil/non-foil, condition, **timestamp added**
- Portfolio total value = sum of (quantity × current price) across all holdings
- Value-over-time chart: reconstruct total portfolio value at any past date by combining (a) which cards were held as of that date (via timestamp added) and (b) that card's price on that date (via daily price snapshots)
- Dashboard shows: current total value, gain/loss (day/week/month/all-time), chart with zoomable time range

### Handling cards added before available price history
Since backfill only reaches back ~365 days (via cardbase.dev) or less for gaps it doesn't cover, some cards will have `date_added` earlier than any real price snapshot for that specific printing. Two cases:

**Case A — card predates all available history (common)**
Default to flat-fill backward: use the earliest known real price for that exact printing and hold it flat for every date between `date_added` and the first real snapshot. This keeps the portfolio-wide chart smooth instead of stair-stepping every time an older card's real data starts.
- Mark these synthetic points `estimated: true` in `price_snapshots`.
- UI renders estimated segments visually distinct (dashed/lighter line) and tooltip-labeled as such — never show a flat-filled guess as equivalent to a real tracked point.
- Ship the simpler truncate-only behavior in v1 if flat-fill logic adds too much complexity: chart starts at `max(date_added, earliest_available_snapshot)`, card contributes $0 before that. Log flat-fill as v1.1 polish if deferred.

**Case B — no price data exists at all for that printing** (delisted product, obscure promo not covered by Scryfall, cardbase.dev, or MTGJSON)
Don't fabricate a price. Mark the card "price unavailable," exclude it from the portfolio total (don't default to $0 silently — flag it in the UI so the user knows it isn't being counted), and allow an optional manual price override.

**Cross-printing rule:** since pricing is printing-specific, never fall back to a reprint's or different-printing's price when the original printing is missing data — keep `price_snapshots` keyed strictly per Scryfall printing `id`.

## Feature 2: Card price history
- Look up any single card and see a price chart over time
- **Feasibility (updated — cardbase.dev registration currently erroring out, so MTGJSON is primary backfill for now; Scryfall handles ongoing tracking):**
  - **Scryfall bulk data** (ongoing daily price source, no extra dependency): the `default_cards`/`all_cards` bulk data files (refreshed daily, already needed for card metadata) include price information alongside metadata. Since this pull is already required for card data, reuse it for the daily `price_snapshots` write instead of adding a second API dependency. Sources: TCGPlayer (USD), Cardmarket (EUR), Cardhoarder (tix) — **use `prices.usd`/`prices.usd_foil` only**, since v1 is USD-only.
  - **MTGJSON** (backfill-only source, no signup required): bulk downloadable files at `https://mtgjson.com/api/v5/`, not a query API. Key files:
    - `AllPrices.json` — all prices for the past 90 days, keyed by MTGJSON's own `uuid`, broken out by vendor (tcgplayer, cardmarket, cardkingdom, cardsphere) and mtgo (cardhoarder). Available as `.json`/`.json.gz`/`.json.bz2`/`.json.xz`/`.json.zip`. **Use only the `tcgplayer` retail series for backfill** — matching the vendor Scryfall reports for ongoing tracking (see continuity note below).
    - `AllIdentifiers.json` — maps MTGJSON's `uuid` to other IDs including `scryfallId`. **Required join step**: MTGJSON keys everything on its own `uuid`, not Scryfall's `scryfall_id`, so price data must be joined through this file to map onto our printing records (keyed on `scryfall_id`). This join is only needed once, at backfill time — not for ongoing tracking, since Scryfall's bulk data is already keyed on `scryfall_id` natively.
    - `AllPrintings.json` — full card/printing metadata, not needed since Scryfall already covers metadata.
    - `Meta.json` — build timestamp; poll this to detect when MTGJSON has refreshed before re-downloading.
    - `AllPricesToday.json` is **not used** — Scryfall's bulk data covers the ongoing daily snapshot instead, avoiding a redundant second daily price source.
  - **Continuity note:** both Scryfall and MTGJSON ultimately report TCGPlayer as the source for USD retail pricing, so pulling MTGJSON's `tcgplayer` series for backfill and Scryfall's `prices.usd` for everything from day one forward should produce a continuous line with no vendor-switch jump — as long as backfill sticks to the `tcgplayer`/retail series specifically, not Card Kingdom or Cardsphere.
  - **Deliberate scope trade-off:** MTGJSON offers Card Kingdom and Cardsphere as additional vendors; Scryfall does not. Since v1 tracks a single price line per printing (not multi-vendor comparison), standardizing on TCGPlayer/USD for both backfill and ongoing tracking is an intentional simplification, not an oversight.
  - **cardbase.dev** (secondary/planned upgrade, not yet integrated): registration is currently erroring out — retry later or contact their support. Once working, it's keyed natively on `scryfall_id` (no join step needed, unlike MTGJSON), offers up to 365 days authenticated vs MTGJSON's 90, and confirmed per-printing-and-finish depth. When available, treat it as the preferred backfill source and use MTGJSON as the fallback/cross-check instead of the reverse. See "Open questions" below — still applies once registration works.
  - **JustTCG** (tertiary/alternate source, evaluate if cardbase.dev registration stays broken): live queryable REST API at justtcg.com, queries directly by **Scryfall ID** (no join-through-uuid step needed, same advantage as cardbase.dev over MTGJSON), also supports MTGJSON ID and TCGPlayer SKU lookups. Supports `include_price_history` with duration options `7d`/`30d`/`90d`/`180d`/`1y`, filterable by condition (NM/LP/MP/HP/DMG) and printing type (normal/foil). Has a free tier; exact request-limit numbers and full ToS not yet confirmed — check their docs/pricing page directly before integrating. Commercial-use license available on paid tiers if this project ever expands beyond personal use.
  - TCGPlayer/Card Kingdom direct integration: out of scope unless the above prove insufficient.
  - **Open questions to resolve once cardbase.dev is accessible**: does their ToS permit persisting/caching their response data in our own DB long-term, vs. only querying live each time; exact shape of the bulk download endpoint (not documented in their getting-started guide).
  - **Decision for v1:** one-time backfill via MTGJSON's `AllPrices` (90 days, `tcgplayer` series only, joined through `AllIdentifiers` for `scryfallId`), immediately, no blocker. From day one forward, the daily price refresh comes from the Scryfall bulk data pull already used for metadata (`prices.usd`/`prices.usd_foil`) — no separate MTGJSON polling needed going forward. Add cardbase.dev as a second source once registration is resolved, to extend the backfill window and simplify the ID-mapping. If cardbase.dev registration remains broken, evaluate JustTCG as the alternate Scryfall-native source instead (confirm free-tier limits/ToS first). Beyond whatever depth any of these sources provides, there's still no free full-history source — log "extend backfill further" as a v2 improvement, not a v1 blocker.

## Data sources
- **Scryfall API** (metadata + ongoing daily price source): bulk data files (`default_cards`/`all_cards`, refreshed daily) provide card metadata AND price info (`prices.usd`/`prices.usd_foil`) in one pull. This single pull covers both card metadata and the daily `price_snapshots` write — no separate price-only source needed for ongoing tracking. No key required; respect documented rate limits.
- **MTGJSON** (one-time backfill only, no signup required): bulk files at `https://mtgjson.com/api/v5/`. Use `AllPrices.json`'s `tcgplayer` series specifically (for vendor continuity with Scryfall's USD price) for the initial 90-day backfill, joined through `AllIdentifiers.json` to map MTGJSON's `uuid` to `scryfallId`. Not used for ongoing tracking — Scryfall's bulk data handles that going forward.
- **cardbase.dev** (secondary, pending registration fix): `https://api.cardbase.dev/v1`, keyed natively on `scryfall_id`. Once account creation works, register for a free authenticated API key (up to 5 per account), pass as `Authorization: Bearer cbdev_...`, and use it to extend backfill to 365 days and simplify the ID mapping that MTGJSON requires. Filter to the vendor/finish/price_type combinations actually needed (e.g. `vendor=tcgplayer&finish=normal&price_type=retail`) rather than pulling every series by default.
- **JustTCG** (tertiary/alternate, evaluate if cardbase.dev stays unavailable): live REST API, queries by Scryfall ID directly. Confirm free-tier request limits and ToS before integrating.
- Only add direct TCGPlayer/Card Kingdom API integration if the above prove insufficient — and confirm ToS allows caching first.

## Data model (minimum)
- `cards` / `printings` — Scryfall printing id, oracle id, name, set, image, foil availability
- `holdings` — user id, printing id, quantity, foil/non-foil, condition, date added
- `price_snapshots` — printing id, date, price, source, **estimated (bool)** — flag for flat-filled/synthetic backfill points vs. real tracked/API data
- `users` — see Auth below

## Auth & scope
- v1: single-user, no account system — this is for my own collection. Confirm before building multi-user auth, sessions, or data isolation, since that's meaningfully more scope.
- If multi-user is wanted later, log it as a v2 item rather than building it now.

## Import
- v1: manual add via search
- v1: **CSV import for Moxfield's collection export format**. Moxfield's collection CSV header row is: `Count,Tradelist Count,Name,Edition,Condition,Language,Foil,Tags,Last Modified,Collector Number,Alter,Proxy,Purchase Price`.
  - **Field mapping**: `Count` → holding quantity. `Name` + `Edition` (set code) + `Collector Number` → resolve the exact Scryfall printing (`scryfall_id`) via Scryfall's `/cards/{set}/{collector_number}` lookup — more reliable than name-only matching since it pins the exact printing. `Foil` → finish (empty string = normal, `foil` = foil; note Moxfield may not distinguish `etched` from `foil` in this column — verify against a real export before assuming). `Condition` → condition field, mapped to our existing condition enum (Moxfield's values: Mint, Near Mint, Excellent, etc. — confirm exact value set against a real export and map accordingly).
  - **Not used in v1**: `Tradelist Count`, `Language` (v1 assumes English), `Tags`, `Alter`, `Proxy`, `Purchase Price` (could later feed a manual price override, but not built in v1).
  - **`date_added` handling**: Moxfield's CSV has no acquisition-date column — `Last Modified` reflects Moxfield's own last-edit timestamp, not necessarily when the card was acquired, so it should not be used as `date_added`. Default `date_added` to the **CSV import timestamp** for every row, with an option for the user to manually edit `date_added` per-card afterward if they know the real acquisition date. This is a deliberate simplification: it means freshly bulk-imported collections start their value-over-time chart from the import date rather than requiring backfill guesswork on day one, and it avoids fabricating acquisition dates from a field that doesn't actually represent them.
  - **Unmatched rows**: if a row's Name/Edition/Collector Number doesn't resolve to a Scryfall printing (misprint, typo, unusual promo), report it back to the user after import rather than silently skipping or guessing — same principle as Case B in the price-history handling above.
- v2 (log, don't build yet): CSV import for other export formats (Deckbox, TCGplayer, ManaBox, Archidekt, etc.) — Moxfield is the only format required for v1.

## Non-functional requirements
- Cache all price data in a local database — never re-fetch a price that's already been fetched for that day. Daily cron job (not real-time polling) pulls Scryfall's bulk data (metadata + price in one pull) to refresh `price_snapshots`; this matches how Scryfall itself refreshes prices (once per day).
- Respect Scryfall's, cardbase.dev's, and MTGJSON's rate limits and caching guidance (check their API docs for current limits before implementing).
- Currency: USD only for v1.
- Condition/foil affects which price is looked up, but don't build graded-card (PSA/BGS) support in v1.

## Stack
- **Framework**: Next.js (TypeScript), full-stack — API routes + frontend in one deployable app, one language end-to-end.
- **Database**: SQLite via Drizzle ORM. Single-user, low write volume — a single-file DB is trivial to self-host and back up (just copy the file). Do not introduce Postgres or another DB server for this use case.
- **Charts**: Recharts — needs to support rendering `estimated: true` price-history segments as visually distinct (dashed/lighter) from real tracked data, with a tooltip that says so.
- **Scheduled jobs**: node-cron (or equivalent) running inside the same container for the daily Scryfall bulk data pull (metadata refresh + `price_snapshots` write in one job) — no separate job scheduler/queue needed at this scale.
- **Deployment**: Docker Compose. Should build to a single `docker compose up` for anyone cloning the repo to self-host — include a `Dockerfile` and `docker-compose.yml` with the SQLite file mounted to a volume so data persists across container rebuilds. Document the cardbase.dev API key as an environment variable in the compose file / a `.env.example`.

## Future: commercial/paid-tier considerations (not v1, but flag before any monetization work)
This project is free and personal-use/self-hosted for v1. If a paid subscription tier is ever considered later, revisit data sourcing before building anything monetized:
- **Scryfall's API terms explicitly prohibit paywalling access to Scryfall data** — you may not require payment, subscriptions, or similar in exchange for access to Scryfall data. Since Scryfall is currently both the metadata source and the ongoing daily price source, this blocks charging for the product as currently architected. Do not build a paid tier on top of Scryfall-sourced data without resolving this first.
- MTGJSON (MIT license) is the most commercially permissive current source, but confirm with them directly whether commercial-scale redistribution of the underlying vendor prices (TCGPlayer/Cardmarket/Card Kingdom) they aggregate carries any additional constraint beyond the MIT license on MTGJSON's own output.
- Purpose-built commercial pricing APIs (e.g. TCG API, JustTCG) explicitly support paid resale via their paid tiers — the legally cleanest option, but not free, and their free tiers are non-commercial-use only.
- Note the tension with the AGPLv3 choice above: since all clones must stay open source, a future paid-hosted version could legally be forked and self-hosted by a competitor at the same price of $0. Any monetization plan needs to account for this rather than relying on code exclusivity as a moat.
- This is not legal advice — confirm current ToS directly with each provider, and consult a lawyer before launching anything paid.

## License
GNU AGPLv3. This is a deliberate choice over plain GPL: GPL's copyleft obligations trigger on *distributing* the software, not on running a modified version as a network service — someone could fork this, modify it, host it as a web service, and never be obligated to share their changes. AGPLv3 closes that gap by requiring anyone running a modified version as a network service to also offer source access to users interacting with it over the network. Include a standard `LICENSE` file (AGPLv3 full text) and a short license header/notice in the README.

## Explicitly out of scope for v1 (log as future improvements, do not build)
- Multi-user accounts/auth
- CSV import for non-Moxfield formats (Deckbox, TCGplayer, ManaBox, Archidekt, etc.)
- Graded card pricing
- Non-USD currency
- Direct TCGPlayer/Card Kingdom API integration (unless cardbase.dev + Scryfall prove insufficient)
- Deep historical backfill beyond whatever cardbase.dev's authenticated tier provides (365 days)
