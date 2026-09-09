# MTG Collection Value Tracker

A free, self-hosted web app for tracking the value of a Magic: The Gathering
collection over time, plus per-card price history.

## Status

Pre-alpha. Phase 0 (project scaffolding) only.

## Features (v1 scope)

- **Portfolio tracking** — add printings to a collection (quantity, finish,
  condition, date added) and chart total collection value over time.
- **Card price history** — look up any single printing and view its price chart.
- **Export** — three CSVs at `/export`: your collection with every vendor's
  current price beside it, the dashboard's value history, and daily price
  history for the cards you hold. Each is bounded by the size of your
  collection rather than the price tables, which hold 15.7 million rows. The
  collection and price-history files carry no duplicated columns and join on
  `scryfall_id` + `finish`.
- **Vendor comparison** — what TCGplayer, Card Kingdom, Cardmarket and Mana
  Pool ask for your cards, and what Card Kingdom would pay for them. Scoped to
  your collection: every vendor and side for every printing measures at roughly
  60 million rows against 2.9 million for one collection.

Single-user, USD-only, no account system.

## Data sources

- [Scryfall](https://scryfall.com/docs/api) bulk data — card metadata and the
  ongoing daily price snapshot (`prices.usd` / `prices.usd_foil`, sourced from
  TCGplayer).
- [MTGJSON](https://mtgjson.com/) `AllPrices` — one-time 90-day historical
  backfill, `tcgplayer` retail series only, joined to Scryfall IDs through
  `AllIdentifiers`.

This project is not affiliated with, endorsed, or sponsored by Wizards of the
Coast, Scryfall, MTGJSON, or TCGplayer.

## Stack

Next.js (TypeScript, App Router) · SQLite via Drizzle ORM · Recharts · node-cron
· Docker Compose

## Development

```bash
npm install
npm run db:migrate         # create/upgrade ./data/mtg.db
npm run ingest:scryfall    # printing metadata + today's prices (~20s)
npm run backfill:mtgjson   # ~90 days of history for cards you hold
npm run dev
```

### Data pipeline

| Command | What it does |
| --- | --- |
| `npm run ingest:scryfall` | Streams Scryfall's gzipped JSONL `default_cards` bulk file. Upserts printings and writes one day of price snapshots. Idempotent, and skips entirely if that build was already ingested (`--force` overrides). This is what the daily cron will run. |
| `npm run backfill:mtgjson` | One-time historical fill from MTGJSON's `AllPrices`, TCGplayer retail only, joined to Scryfall ids through MTGJSON's `uuid`. Scoped to held printings by default; `--all` covers every printing. Never overwrites a day already recorded. |
| `npm run import:moxfield` | Imports a Moxfield collection CSV. The export is treated as a snapshot of the whole collection: quantities are set from the file and holdings it no longer lists are removed, so re-importing the same file changes nothing. Only rows the importer owns are touched, so hand-added cards survive. `--add` merges without removing; `--adopt` claims pre-existing rows once. |
| `npm run backfill:mtgjson -- --vendors` | Also records every vendor and both market sides into `vendor_prices`, for held printings. Cardmarket quotes euros and is stored as such; nothing converts between currencies. |
| `npm run db:smoke` | Round-trips every table and asserts the constraints the app depends on. |
| `npm run test:ingest` | Unit tests for price conversion and snapshot dating. |
| `npm test` | Every suite: ingest, holdings, import, valuation, chart axes, schema. |

Both ingests cache their downloads under `data/cache/` and take
`--dry-run` / `--limit N` for measurement.

Snapshots are dated by the **upstream build date**, not the wall clock, so a
stale file can never overwrite a later day's prices. Prices are stored as
integer cents so that summing a collection is exact. A missing price is stored
as absence, never as zero — Alpha Black Lotus, for instance, has no TCGplayer
USD listing at all.

## Self-hosting with Docker

```bash
cp .env.example .env      # optional; the defaults work
docker compose up -d
```

Then open <http://localhost:3000>.

The first start is slow on purpose: with no card data yet, the container
downloads Scryfall's bulk file and ingests ~108,000 printings before the app is
useful. Watch it with `docker compose logs -f`. After that, a cron inside the
container refreshes prices once a day (10:15 UTC by default, an hour after
Scryfall rebuilds its bulk data), and re-running against an unchanged upstream
build is a no-op.

The database is a single SQLite file bind-mounted at `./data/mtg.db`. Backing up
the collection is copying that file. Migrations run automatically on every
start, so pulling a newer image upgrades the schema rather than failing.

### Backfilling history and importing a collection

The daily job only records prices from the day it first runs, so a new install
has one day of history. The MTGJSON backfill fills in roughly 90 days before
that.

Both the backfill and the Moxfield import are development CLIs — they run under
`tsx`, which is a dev dependency and is deliberately not in the production
image. Run them from a checkout, against the same file the container uses:

```bash
DATABASE_PATH=./data/mtg.db npm run backfill:mtgjson -- --all
DATABASE_PATH=./data/mtg.db npm run import:moxfield -- collection.csv --dry-run
```

SQLite is in WAL mode, so these are safe to run while the container is serving.
CSV import is also available in the app itself at `/import`, which needs no
checkout.

### Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `DATABASE_PATH` | `./data/mtg.db` | SQLite file location |
| `CRON_ENABLED` | on in production | Runs the daily price refresh in-process |
| `CRON_SCHEDULE` | `15 10 * * *` | Standard five-field cron expression |
| `CRON_TIMEZONE` | `UTC` | Timezone the schedule is read in |
| `PORT` | `3000` | Host port the container publishes |

## License

Copyright (C) 2026 Nathan Manske

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>.

AGPLv3 is deliberate: anyone who runs a modified version of this as a network
service must also offer its source to users interacting with it over the
network. See [`LICENSE`](LICENSE) for the full text.
