# MTG Collection Value Tracker

A free, self-hosted web app for tracking the value of a Magic: The Gathering
collection over time, plus per-card price history.

## Status

Pre-alpha. Phase 0 (project scaffolding) only.

## Features (v1 scope)

- **Portfolio tracking** — add printings to a collection (quantity, finish,
  condition, date added) and chart total collection value over time.
- **Card price history** — look up any single printing and view its price chart.
- **Chart ranges** — 1M / 3M / 6M / 1Y / All above the value chart. A range is
  disabled until the price history actually spans it, so a short series is
  never stretched across a wide axis.
- **Statistics** — `/stats`: most valuable cards, biggest risers and fallers,
  what actually moved the collection's value, buylist spreads, where the value
  sits by set, and the long tail.
- **Export** — two CSVs at `/export`: your collection with every vendor's
  current price beside it, and the dashboard's value history. Both are bounded
  by the size of your collection rather than the price tables, which hold 15.7
  million rows. There is deliberately no per-card daily price export; see
  below.
- **Vendor comparison** — what TCGplayer and Card Kingdom ask for your cards,
  and what Card Kingdom would pay for them, with the coverage and date behind
  each figure stated rather than implied.

Single-user, USD-only, no account system.

Planned work and known issues are in [TODO.md](TODO.md).

## Data sources

- [MTGJSON](https://mtgjson.com/) — **every price, past and present.**
  `AllPricesToday` (5.2 MB gzipped) is the daily refresh; `AllPrices` fills
  history, serving a rolling ~90-day window from the live API, or years from a
  local archive of past builds, since each build carries its own window and
  consecutive builds overlap enough to stitch together.
- [Scryfall](https://scryfall.com/docs/api) bulk data — **card metadata only.**
  Printings, names, sets, collector numbers, images and finishes, which nothing
  else supplies. Its `prices.usd` is deliberately not read.

One price provider, not two. Scryfall's prices are TCGplayer's, the same series
MTGJSON publishes as `tcgplayer` retail, so reading both would mean two sources
filling one series with whichever ran first owning each day. Using MTGJSON alone
leaves one set of terms to honour and no seam where providers meet.

Only TCGplayer and Card Kingdom are kept. MTGJSON also aggregates Cardmarket,
which quotes EUR and cannot join a dollar total without exchange-rate history
this project does not have, and Mana Pool, which appears only in recent builds
and so cannot contribute history. TCGplayer retail lives in `price_snapshots`
and Card Kingdom's two sides in `vendor_prices`; the two tables partition the
series between them and the vendor comparison unions them.

This project is not affiliated with, endorsed, or sponsored by Wizards of the
Coast, Scryfall, MTGJSON, or TCGplayer.

## Stack

Next.js (TypeScript, App Router) · SQLite via Drizzle ORM · Recharts · node-cron
· Docker Compose

## Development

```bash
npm install
npm run db:migrate         # create/upgrade ./data/mtg.db
npm run ingest:scryfall    # printing metadata (~20s)
npm run ingest:today       # today's prices from MTGJSON (~20s)
npm run backfill:mtgjson   # ~90 days of history for cards you hold
npm run dev
```

### Data pipeline

| Command | What it does |
| --- | --- |
| `npm run ingest:scryfall` | Streams Scryfall's gzipped JSONL `default_cards` bulk file and upserts printings. Metadata only — pass `--prices` to also record `prices.usd`, which the daily job does not. Idempotent, and skips entirely if that build was already ingested (`--force` overrides). |
| `npm run ingest:today` | Today's prices for every printing from MTGJSON's `AllPricesToday`: TCGplayer retail into `price_snapshots`, Card Kingdom's two sides into `vendor_prices`. Measured at 148,446 snapshots and 228,208 vendor rows in ~20s. Never overwrites a day already recorded. |
| `npm run backfill:mtgjson` | Historical fill from MTGJSON's live `AllPrices` (~90 days), TCGplayer retail only, joined to Scryfall ids through MTGJSON's `uuid`. Scoped to held printings by default; `--all` covers every printing. Never overwrites a day already recorded. |
| `npm run backfill:archive` | The same, from a local archive of past MTGJSON builds, which reaches back years rather than 90 days. Walks builds oldest-first, records progress after each, and resumes where it stopped. `--snapshots` / `--vendors` take `all`, `held` or `none`; `--ids-only` rebuilds just the uuid map; `--every N` samples builds. |
| `npm run audit:archive` | Reports which archived builds failed to download, and — the part that matters — whether the gaps leave any date uncovered. Usually they do not: each build carries ~90 days while builds are ~8 days apart, so neighbours cover for a missing one. |
| `npm run import:moxfield` | Imports a Moxfield collection CSV. The export is treated as a snapshot of the whole collection: quantities are set from the file and holdings it no longer lists are removed, so re-importing the same file changes nothing. Only rows the importer owns are touched, so hand-added cards survive. `--add` merges without removing; `--adopt` claims pre-existing rows once. |
| `npm run backfill:mtgjson -- --vendors` | Also records Card Kingdom's retail and buylist into `vendor_prices`. TCGplayer retail is deliberately not written there: it is the canonical series in `price_snapshots`, and storing it twice put it on both sides of the comparison union and double-counted the collection. |
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
container refreshes card metadata once a day (10:15 UTC by default), and
re-running against an unchanged upstream build is a no-op.

Prices are a separate step for now: `npm run ingest:today` reads MTGJSON's
`AllPricesToday`. It is not yet wired into the in-process scheduler — see
[TODO.md](TODO.md) item 2 for why and what the options are.

The database is a single SQLite file bind-mounted at `./data/mtg.db`. Backing up
the collection is copying that file. Migrations run automatically on every
start, so pulling a newer image upgrades the schema rather than failing.

### Backfilling history and importing a collection

The daily job only records prices from the day it first runs, so a new install
has one day of history. `backfill:mtgjson` fills in the ~90 days MTGJSON's live
API serves. Going back further needs an archive of past MTGJSON builds on disk,
which `backfill:archive` walks oldest-first — see "Backfilling from an archive".

Both the backfill and the Moxfield import are development CLIs — they run under
`tsx`, which is a dev dependency and is deliberately not in the production
image. Run them from a checkout, against the same file the container uses:

```bash
DATABASE_PATH=./data/mtg.db npm run backfill:mtgjson -- --all
DATABASE_PATH=./data/mtg.db npm run import:moxfield -- collection.csv --dry-run
```

### Backfilling from an archive

MTGJSON's live `AllPrices` is a rolling ~90-day window, so the public API can
never reach further back than three months. An archive of past builds can: each
one carries its own window, and consecutive builds overlap enough to stitch into
a continuous series.

Point `backfill:archive` at a directory of build folders, each holding that
build's `AllPrices.json` (a nested `AllPrices.json/AllPrices.json` is accepted,
as is `.gz`):

```bash
DATABASE_PATH=./data/mtg.db npm run backfill:archive -- --snapshots all --vendors all
```

Two things make a long run practical. Builds whose dates the watermark already
covers are skipped on a 4 KB header read rather than a full parse, so restarting
costs seconds instead of re-reading everything. And progress is recorded after
each build, so an interrupted run resumes where it stopped — the same command
continues it.

Run `--ids-only` first if the archive spans years. MTGJSON retires `uuid`s over
time, and a uuid the map cannot resolve is skipped silently, taking that card's
history with it. Merging every build's `AllIdentifiers.json` first recovered
30,691 mappings against a map built from the current build alone.

### Backing up

The database is the backup. Copy `data/mtg.db` — it holds the collection and
every price ever recorded, including days that can no longer be re-fetched once
MTGJSON's rolling 90-day window moves past them. That window is the reason the
database matters more than it looks: once a day falls out of it, the only
sources are this file or an archived build.

There is no export of the per-card daily price series, and that is deliberate.
Price providers' terms consistently forbid repackaging their data as a
standalone feed or bulk dataset, and a CSV with one row per card per day is
exactly that shape — a real risk if this is ever run commercially. The two
exports that remain describe your own holdings and a derived daily total.

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
