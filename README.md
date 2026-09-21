# MTG Collection Value Tracker

A free web app for tracking the value of a Magic: The Gathering collection over
time, plus per-card price history. It runs two ways from one codebase:

- **Self-hosted**, where the database holds your own collection, a daily job
  prices it, and the dashboard is the front page.
- **Public**, where nothing is stored: a visitor uploads a collection or pastes
  a decklist, gets the whole dashboard for that browser session, and everything
  they uploaded is deleted after two days idle — or immediately, on request.
  There are no accounts.

Which one you get is not a setting in the usual sense: a collection scope of
`''` is the host's own, and an instance whose own collection is empty shows the
upload page instead of a dashboard of zeroes. `PUBLIC_MODE=true` makes that
explicit, hiding the host's collection even where one exists — which is how one
database serves both sites at once.

## Status

Running. Deployed to a home server in Docker, with ~5.7 years of price history
(564 million rows) and a daily ingest that keeps itself current. Planned work
and known issues are in [TODO.md](TODO.md).

## Features (v1 scope)

- **Portfolio tracking** — add printings to a collection (quantity, finish,
  condition, date added) and chart total collection value over time.
- **Card price history** — look up any single printing and view its price chart.
- **Chart ranges** — 1M / 3M / 6M / 1Y / All above the value chart. A range is
  disabled until the price history actually spans it, so a short series is
  never stretched across a wide axis.
- **Statistics** — `/stats`: most valuable cards, biggest movers, buylist
  spreads, where the value sits by set, and the long tail. Plus the long view —
  year by year, the deepest fall from a high, best and worst year and month —
  computed **like-for-like**, because a card cannot be priced before it was
  printed and reading the raw chart reports five years of new printings as
  growth. On a real collection that is +58% against -13%.
- **Export** — two CSVs at `/export`: your collection with every vendor's
  current price beside it, and the dashboard's value history. Both are bounded
  by the size of your collection rather than the price tables, which hold 564
  million rows. There is deliberately no per-card daily price export; see
  below.
- **Vendor comparison** — what TCGplayer and Card Kingdom ask for your cards,
  and what Card Kingdom would pay for them, with the coverage and date behind
  each figure stated rather than implied.

Single-user, USD-only, no account system.

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

### Running the two sites

The same build serves both. After `npm run build`:

```powershell
# Your own collection, on the LAN
$env:ENABLE_OWNER_IMPORT="true"; $env:PRIVACY_PASSWORD="pass"; npm run start

# Public: the upload prompt, with your collection invisible
$env:PUBLIC_MODE="true"; $env:CRON_ENABLED="false"; $env:PORT="3001"; npm run start
```

```bash
# The same, in a POSIX shell
ENABLE_OWNER_IMPORT=true PRIVACY_PASSWORD=pass npm run start
PUBLIC_MODE=true CRON_ENABLED=false PORT=3001 npm run start
```

Three things to know:

- **PowerShell keeps those variables for the rest of the session.** Run the
  public command and then the private one in the same terminal and you are
  still in public mode. Use two terminals, or `Remove-Item Env:PUBLIC_MODE`.
  This is the easiest way to confuse yourself here.
- **Different ports.** Both default to 3000.
- **`CRON_ENABLED=false` on the public one is required, not tidy.** Only one
  instance may run the daily ingest. The session sweep still runs on both; it
  is deliberately not behind that flag.

`.env` is loaded by `next start` as well, so anything set there applies to both.

Under Docker the two are services in one project, and the public one is behind
a profile so the default command is unchanged:

```bash
docker compose up -d                    # personal site, on PORT
docker compose --profile public up -d   # both
docker compose up -d public             # public site only, on PUBLIC_PORT
```

See [DEPLOYMENT.md](DEPLOYMENT.md) §9 for why only one of them ingests.

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

```bash
cp .env.example .env
docker compose up -d --build
```

Then open <http://localhost:3000>.

**[DEPLOYMENT.md](DEPLOYMENT.md)** is the real guide: deploy keys, moving an
existing database across, verification and a troubleshooting table. It opens
with the whole deployment as a single block of commands.

The database is one SQLite file, bind-mounted from `DATA_DIR` (default
`./data`). Migrations run on every start, so pulling a newer image upgrades the
schema rather than failing.

### What runs on its own

- **Metadata and prices, daily at 10:00 UTC** (`CRON_SCHEDULE`). Overnight
  across the Americas, and just under an hour after Scryfall's ~09:05 UTC build.
- **Prices run as a child process.** A 50 MB parse and a few hundred thousand
  rows have no business competing with request handling for memory or the write
  lock. The worst case is a non-zero exit code and yesterday's prices still on
  screen.
- **Every run is recorded**, and the dashboard says so when prices fall more
  than two days behind or the last run failed. A chart missing its newest point
  looks exactly like a chart, which is how a missed day went unnoticed for five
  days — and MTGJSON serves only ~90 days before a gap is permanent.
- **A stale value history is served, not recomputed.** Anything that changes
  holdings or prices leaves the cached series behind. Recomputing it inside the
  request that noticed costs 20-35s and every concurrent request starts its own,
  so the page instead serves what it has, marks it `updating`, and rebuilds in
  the background.

### Filling in history

A new install has one day of prices. `backfill:mtgjson` fills the ~90 days the
live API serves; going back years needs a local archive of past MTGJSON builds,
which `backfill:archive` walks oldest-first.

```bash
npm run backfill:mtgjson -- --all
npm run backfill:archive -- --snapshots all --vendors all
npm run import:moxfield -- collection.csv --dry-run
```

Two things make a long archive run practical: builds the watermark already
covers are skipped on a 4 KB header read rather than a full parse, and progress
is recorded after each build, so an interrupted run resumes where it stopped.

Run `--ids-only` first if the archive spans years. MTGJSON retires `uuid`s over
time and an unresolvable one is skipped silently, taking that card's history
with it — merging every build's `AllIdentifiers.json` first recovered 30,691
mappings against a map built from the current build alone.

`npm run finalize` then runs what a long backfill leaves outstanding, in
dependency order: import, cache rebuild, smoke test, `VACUUM`. The order is the
point — an import can change which holdings carry an inferred date, which moves
every point in the series, and a smoke test against a cold cache measures the
cache rather than the app.

These are `tsx` CLIs. The production image carries `tsx` and the source, so they
run inside the container too; `docker compose exec app node_modules/.bin/tsx
scripts/<name>.ts`.

### Backing up

The database is the backup — copy `data/mtg.db`. It holds every price ever
recorded, including days that can no longer be re-fetched once MTGJSON's rolling
window moves past them. SQLite is in WAL mode, so `VACUUM INTO` takes a
consistent snapshot while the container keeps serving.

Most of it is rebuildable from an archive; `holdings` is not, because
acquisition dates come from Moxfield's `Last Modified`, which moves whenever a
card is edited there. See DEPLOYMENT.md section 8 for whether that is worth
backing up.

There is deliberately no per-card daily price export. Price providers' terms
forbid repackaging their data as a standalone feed, and a CSV with one row per
card per day is exactly that shape. The two exports that remain describe your
own holdings and a derived daily total.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `DATABASE_PATH` | `./data/mtg.db` | SQLite file location |
| `CRON_ENABLED` | on in production | Runs the daily refresh on a schedule |
| `CRON_SCHEDULE` | `0 10 * * *` | Standard five-field cron expression |
| `CRON_TIMEZONE` | `UTC` | Timezone the schedule is read in; named zones work too |
| `INGEST_COMMAND` | `npm run ingest:today -- --rebuild-cache` | How the price ingest is launched. Empty disables it |
| `INGEST_TIMEOUT_MS` | `1800000` | Kills a wedged ingest rather than letting it hold the write lock |
| `REBUILD_COMMAND` | `npm run cache:portfolio` | How a stale value history is rebuilt, in the background. Empty disables it |
| `DATA_DIR` | `./data` | Host directory holding the database, bind-mounted into the container |
| `PORT` | `3000` | Host port the container publishes |
| `PUBLIC_MODE` | off | Hides the host's own collection, so only uploads are ever shown. Forces `ENABLE_OWNER_IMPORT` off |
| `SQLITE_BUSY_TIMEOUT_MS` | `30000` | How long a write waits for another process's write |
| `ENABLE_OWNER_IMPORT` | off | Allows `/import`, which **replaces the host's collection**. Set it on a self-hosted instance; never on a public one |
| `PRIVACY_PASSWORD` | unset | Hides all values until this is typed. Unset means values show and the toggle is an ordinary hide button |
| `WARM_COMMAND` | `npm run warm:session --` | How an uploaded collection is priced, out of process |
| `WARM_CONCURRENCY` | `2` | How many collections may be priced at once |
| `UPLOAD_RATE_LIMIT` | `1` | Collections one address may have priced per window. Charged only when an upload starts a worker, so a rejected file costs nothing |
| `UPLOAD_RATE_WINDOW_MINUTES` | `10` | The window that limit applies over |
| — | 50,000 rows | The upload ceiling, in `src/lib/limits.ts`. About two minutes of background work at the limit |
| `SESSION_TTL_HOURS` | `48` | How long an uploaded collection survives without being looked at |
| `SESSION_LIMIT` | `200` | How many uploaded collections are kept at once, newest first |

`ENABLE_OWNER_IMPORT` is default-closed on purpose: there is no login here, so
that page and its action are a stranger's button for overwriting somebody
else's collection. The CLI importer is unaffected.

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
