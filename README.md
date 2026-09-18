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
  sits by set, and the long tail. Plus the long view: year by year, the deepest
  fall from a high and whether it recovered, and the best and worst year and
  month. Those are computed **like-for-like** — each month-to-month step
  compares only the cards priced at both of its ends, then the steps are
  chained — because a card cannot be priced before it was printed, and reading
  the raw chart instead reports five years of new printings as growth. On a
  real collection that is the difference between +58% and -13%.
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

The layout widens in steps to 1,760px on large displays. Tables and charts get
better with width — a wider plot resolves more of a multi-year series — while
explanatory text stays at a readable measure rather than stretching with it.

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
| `npm run ingest:today` | Today's prices for every printing from MTGJSON's `AllPricesToday`: TCGplayer retail into `price_snapshots`, Card Kingdom's two sides into `vendor_prices`. Measured at 152,160 snapshots and 229,790 vendor rows in ~7s. Never overwrites a day already recorded. This is what the scheduler runs each day, as a child process; `--rebuild-cache` recomputes the portfolio totals afterwards so the first visitor does not pay for it. |
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

> **Not yet run end to end.** The image has never been built or started. What
> follows was verified by inspecting the build output rather than by running a
> container, so treat the first deployment as a test and check the boxes under
> "Verifying a deployment" as you go.

For a step-by-step deployment to a real host — deploy keys, moving the database
across, backups to a NAS, and a troubleshooting table — see
**[DEPLOYMENT.md](DEPLOYMENT.md)**. The section below is the summary.

Intended for a **Linux host**. SQLite relies on POSIX advisory locking, and a
bind mount from a Windows or macOS desktop crosses a filesystem translation
layer that emulates it — slow against a 25 GB database and not something to
trust a write-ahead log to. Develop on the desktop with `npm run dev`; run the
container where the data lives.

### First deployment

```bash
git clone git@github.com:nmanske/mtg-collection-value-tracker.git
cd mtg-collection-value-tracker
cp .env.example .env          # optional; the defaults work

mkdir -p data
sudo chown -R 1001:1001 data  # the container runs as uid 1001

docker compose up -d --build
docker compose logs -f
```

Then open <http://localhost:3000>.

`chown` is not optional. A bind-mounted directory keeps the host's ownership,
and the container's unprivileged `nextjs` user must be able to write it, or the
migration at startup fails with `SQLITE_CANTOPEN`.

If the host is a different architecture from the machine you build on — many
NAS boxes are arm64 — build on the host itself, or use
`docker buildx build --platform linux/arm64`. `better-sqlite3` is a native
module; the build stage carries `python3`, `make` and `g++` so it compiles from
source when no prebuild matches, which is slow but works.

### Bringing an existing collection

A fresh container starts empty and will spend its first hours rebuilding what
you already have. Copy the database instead:

```bash
# On the machine that has it. Never `cp` a live SQLite file — `VACUUM INTO`
# produces a consistent copy even while the app is reading, and a smaller one.
node -e "require('better-sqlite3')('data/mtg.db').exec(\"vacuum into 'mtg-compact.db'\")"
rsync -avP mtg-compact.db user@server:/srv/mtg/data/mtg.db
sudo chown 1001:1001 /srv/mtg/data/mtg.db
```

Migrations run on every start, so a database from an older schema upgrades
itself rather than failing.

### What runs on its own

- **Metadata and prices, daily at 04:30 US Central** (`CRON_SCHEDULE`,
  `CRON_TIMEZONE`). A quiet hour, so the ingest has the write lock to itself,
  and a named zone so it stays at 04:30 local across daylight saving. MTGJSON's
  build hour varies, and a run that arrives early finds the same version and
  skips.
- **The price half runs as a child process**, not inside the web server. It
  parses a 50 MB document and writes a few hundred thousand rows, which has no
  business competing with request handling for memory or for the write lock. As
  a child, the worst case is a non-zero exit code and yesterday's prices still
  on screen. `INGEST_COMMAND` changes how it is launched; empty disables it, for
  driving `ingest:today` from outside the container.
- **Every run is recorded** in `sync_meta`, and the dashboard banners when
  prices fall more than two days behind or the last run failed. Not decoration:
  a chart missing its newest point looks exactly like a chart, which is how a
  missed day went unnoticed for five days, and MTGJSON serves only ~90 days
  before a missed day is unrecoverable.
- **The first start is slow on purpose.** With no card data the container
  ingests ~108,000 printings before the app is useful.

### Verifying a deployment

The image carries more than the standalone bundle, because the ingest needs it.
`better-sqlite3` is traced into the bundle but `stream-json` and `tsx` are not,
so a pruned production `node_modules` is layered underneath. These four checks
confirm that actually survived into the image:

```bash
# 1. The ingest runtime and its ESM-only parser are present.
docker compose exec app ls node_modules/.bin/tsx node_modules/stream-json

# 2. The ingest runs. --dry-run writes nothing. On a container that has never
#    been backfilled this fails with "No MTGJSON uuid map yet" — which still
#    proves the runtime and every import resolved, which is the point.
docker compose exec app node_modules/.bin/tsx scripts/ingest-today.mts --dry-run

# 3. The schedule was registered at boot.
docker compose logs app | grep "scheduled daily ingest"

# 4. HTTPS works from inside the container — a missing trust store would fail
#    every ingest, quietly, once a day.
docker compose exec app node -e "fetch('https://mtgjson.com/api/v5/Meta.json').then(r=>console.log(r.status))"
```

Then watch the schedule fire once for real, rather than waiting a day to find
out it does not. Set `CRON_SCHEDULE="* * * * *"` in `.env`, restart, wait for
one complete run, then put the schedule back:

```bash
docker compose up -d
docker compose logs -f app | grep --line-buffered "\[cron\]"
# expect: starting ingest -> metadata -> prices: running ... -> prices: done
```

A healthy run takes a couple of minutes: ~150,000 snapshots and ~230,000 vendor
rows, plus a portfolio cache rebuild. `prices: FAILED` prints the tail of the
child's output and is also written to `sync_meta` for the dashboard banner.

The database is a single SQLite file at `./data/mtg.db`. Backing up the
collection is copying that file — see "Backing up" for doing it safely while the
container is running.

### Backfilling history and importing a collection

The daily job only records prices from the day it first runs, so a new install
has one day of history. `backfill:mtgjson` fills in the ~90 days MTGJSON's live
API serves. Going back further needs an archive of past MTGJSON builds on disk,
which `backfill:archive` walks oldest-first — see "Backfilling from an archive".

Both the backfill and the Moxfield import are CLIs run under `tsx`. The
production image carries `tsx` and the source, because the daily price ingest
runs the same way, so these can be run inside the container too — but running
them from a checkout against the same file is usually easier:

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

### After a backfill

`npm run finalize` runs everything a long backfill leaves outstanding, in the
order the steps actually depend on each other:

```bash
npm run finalize -- collection.csv   # or --skip-import
npm run finalize -- --dry-run        # say what would run, change nothing
```

The ordering is the point. The collection import has to precede the cache
rebuild, because it can change which holdings carry an inferred acquisition
date and that moves every point in the series. The cache rebuild has to precede
the smoke test, or the test measures a cold cache recomputing and reports the
app as slow. `VACUUM` comes last because everything above it writes.

Steps needing a file or a decision are skipped with an explanation rather than
guessed at — importing the wrong CSV would reconcile the collection against it
and remove holdings it does not mention.

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
| `CRON_ENABLED` | on in production | Runs the daily refresh on a schedule |
| `CRON_SCHEDULE` | `30 4 * * *` | Standard five-field cron expression |
| `CRON_TIMEZONE` | `America/Chicago` | Timezone the schedule is read in; a named zone handles DST |
| `INGEST_COMMAND` | `npm run ingest:today -- --rebuild-cache` | How the price ingest is launched. Empty disables it |
| `INGEST_TIMEOUT_MS` | `1800000` | Kills a wedged ingest rather than letting it hold the write lock |
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
