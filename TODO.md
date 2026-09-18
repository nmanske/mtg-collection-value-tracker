# TODO

Working list. Newest context at the bottom of each item.

## Features

### 1. Fill gaps in the price timeline — done

`npm run audit:gaps` classifies every run by cause. Latest:

```
1,959 days of prices, 2020-12-15 .. 2026-09-17
98 gap(s), 144 missing days
144 day(s) — MTGJSON published no prices these days

Nothing actionable: every gap either fills itself or has no upstream data.
```

Every remaining gap is a day MTGJSON never published. Verified at source:
grepping `2021-01-07` in build 0001 returns zero occurrences while the days
either side return ~385,000 each.

The one gap that *was* ours — the missed daily run on 2026-09-10 — was
recovered by `backfill:mtgjson -- --all --vendors` on 2026-09-18, inside
MTGJSON's rolling ~90-day window. The three Kaggle packages permanently missing
upstream cost nothing, because neighbouring builds' windows cover their dates.

Days with no upstream data can only ever be interpolated.
`price_snapshots.estimated` exists for that and is currently always false; the
chart already draws estimated points differently.

### 2. Daily cron to load the database — done

`src/lib/scheduler.ts` runs in-process via `node-cron` on `CRON_SCHEDULE`
(10:00 UTC) and now does Scryfall metadata **and** MTGJSON prices.

Prices run as a **child process**, not an import. The Turbopack problem was the
trigger — the ingest lives in `.mts` modules with `.mjs` specifiers, the form
`stream-json` forces as an ESM-only package, and importing it from the scheduler
stopped the server booting — but the child process is the better design
regardless. The job parses a 50 MB document and writes ~380,000 rows behind a
1 GB page cache; in the server process that competes with request handling for
memory and for the write lock, and an OOM takes the site down with it. As a
child it cannot. It is also the same CLI a human runs, so there is one code path
and `test:today` already covers it.

Verified end to end against the live file on 2026-09-16: downloaded 5.5 MB,
parsed build `5.3.0+20260916`, 111,783 uuids, 152,160 snapshots, 8.8s including
spawn.

**Silent failure is handled, which was the actual lesson of 2026-09-10.** Every
run — success or failure — is written to `sync_meta` under
`daily_ingest_last_run` with its exit code, duration and the tail of its output,
and the dashboard shows a banner when prices fall more than two days behind or
when the last run failed. Two days rather than one because MTGJSON's build hour
varies and a banner that cries wolf gets ignored on the day it is right.

`INGEST_COMMAND` sets how the ingest is launched and **empty disables it**, for
running the job from outside the container; that reads as "not run" rather than
as a failure, so turning it off does not permanently light up the dashboard.
`INGEST_TIMEOUT_MS` (default 30 min) kills the ingest if it wedges — and kills
the whole process tree, since `shell: true` means the direct child is a shell
and reaping only that leaves the real work running while still reporting a
failure. That bug was caught by a test asserting the kill was prompt.

One bug this shipped with and then fixed: the cache fingerprint hashes every
`sync_meta` row, and the run record is written *after* the ingest child rebuilds
the cache. So each run invalidated the cache it had just rebuilt, and the first
visitor every morning paid a 20-35s recompute. `daily_ingest_last_run` is now
excluded, alongside the fingerprint key, on the principle that both record what
the app did rather than what the data is. Measured before and after on the real
database: 22.4s and 1.4s. `test:cache` asserts it.

**Docker: deployed 2026-09-18.** See item 7.

### 3. Click a card to zoom — done

Clicking a card image on the search or card page opens it full size; Escape or
the backdrop closes it.

`image_uri_large` is stored rather than derived. Scryfall's size variants differ
only by a path segment today, but the docs call image URIs opaque and the newer
variants already disagree on file extension, so substitution would rely on a
coincidence upstream never promised.

Populated: 108,517 of 108,682 printings. Of the 165 without, 162 have no image
at all on Scryfall, so the real shortfall is three.

### 4. Toggle Card Kingdom vs TCGplayer on the collection graph — done

`?prices=cardkingdom` values the whole panel — hero figure, change tiles, chart,
both lines — from Card Kingdom retail instead. The date axis stays TCGplayer's
so the two are drawn against the same spine and are directly comparable.

Only retail is offered. A buylist total answers "what could I sell this for
today", a different question from "what has this been worth", and putting them
on one axis would invite reading a 50% spread as a crash.

The vendor totals table and the chart disagree slightly for Card Kingdom —
$19,780.02 against $19,785.39 — because the totals exclude stale holdings and
the time series does not. Both are right for what they answer, and the chart now
says so rather than leaving a reader to conclude one is broken.

### 5. Collection sort, filter and search — done

The list was 3,724 holdings at 100 a page ordered by acquisition date, with no
other control: 38 pages, and no way to answer "what are my most valuable cards"
or "show me my foils". `/search` did not help — it searches every printing that
exists, not the ones you own.

`?sort=` takes value, name, acquired, quantity or set; `?filter=` takes foil,
unpriced or inferred-date; `?q=` matches card name, set name or set code. All
are links rather than a form, so every view has a shareable URL and the page
still works without JavaScript.

Sorting by value uses the *line* value, so two copies of a cheap card can
outrank one expensive one, and unpriced holdings sort last rather than leading
a most-valuable list. The headline totals deliberately stay the whole
collection when a filter is active — a view that hides cards must not read as
cards having been lost — and the count of matches says what is on screen.

### 6. Stats page: long-horizon history — done

The stats page was built against 89 days of prices and was entirely
cross-sectional: what the collection looks like *now*. With 5.7 years of
history it now also answers what it has *done* — year by year, the deepest fall
from a high and whether it recovered, and the best and worst year and month.

**The methodology is the feature.** Subtracting two points off either existing
series gives the wrong answer, in opposite directions. The as-held line rises
because cards were bought. The constant-basket line holds the cards fixed but
cannot price a card before it was printed: 65% of today's holdings had a price
in December 2020 against 100% today, so the line rises simply because more of
it exists. On the real collection the raw basket reads **+58%** since 2020
where the like-for-like answer is **-13%** — almost the entire apparent gain
was composition drift.

So each month-to-month step compares only the holdings priced at *both* of its
ends, and the steps are chained — the standard treatment for an index whose
constituents change. The chain is anchored at the newest point, which is the
basket's real value today, so the figure a reader checks against the dashboard
matches it exactly instead of being the product of seventy ratios.

Cost: the links are computed inside the pass `rebuildPortfolioCache` already
makes — loading every held printing's history is a scan of a 215M-row table,
23.7s measured, and riding along costs 271,000 array reads. They are stored in
`portfolio_monthly` (migration 0007). Reading the whole panel is 9ms.

Monthly resolution, because these are multi-year questions and a daily chain
would compound 1,953 roundings. The current year is flagged `partial` and
labelled "so far" wherever it appears — it is a nine-month return that can
otherwise win "best year" against everyone else's twelve without saying so.

Still cross-sectional-only, and worth doing next: **most volatile holding**
needs a per-card version of the same chain, which the current pass does not
keep. And **value if buying had stopped in 2023** is close to free now.

### 7. Docker — deployed

Running on a Beelink since 2026-09-18: image built, database copied across,
service serving, daily schedule registered. `DEPLOYMENT.md` is the guide and now
reflects a deployment that happened rather than one reasoned about.

The static review beforehand was worth it — `stream-json` and `tsx` are not
traced into `.next/standalone`, which is why the `prod-deps` stage exists, and
that held up in practice.

The first build surfaced one bug the review missed: `next build` collects page
data by importing every route, `@/db` opens SQLite at module scope, and the
Dockerfile removes `data/` beforehand. better-sqlite3 creates a missing file but
not a missing directory, so the build could not complete. `openDatabase` now
creates the parent directory. Invisible locally, where `data/` always exists.

Decisions made during the deployment, recorded so they are not re-litigated:

- **Database on local disk, not the NAS.** SQLite wants POSIX advisory locking
  and WAL needs a shared-memory file; neither works over NFS or SMB. The Beelink
  had 335 GB free, which made the iSCSI plan unnecessary.
- **Its own compose project**, not merged into the Plex stack. `docker compose
  down` on one cannot take the other with it.
- **No scheduled backup.** Prices are rebuildable from the archive; `holdings`
  is not. Judged an acceptable trade for a single user — see DEPLOYMENT.md
  section 8.

### 8. The valuation query scans the whole price table

The single most valuable optimisation available, and the answer to "does this
scale". Measured 2026-09-18 on the real database:

```
plan today       SCAN price_snapshots            13,470 ms
plan per-series  SEARCH ... USING PRIMARY KEY     2,160 ms
                 identical 6,539,232 rows            6.2x
```

`portfolioSeries` loads every held printing's history with one joined statement.
SQLite materialises the holdings subquery and then **scans all 215 million rows**
of `price_snapshots` with a bloom filter, rather than seeking to the 6.5 million
it needs. So the cost is proportional to the size of the price table, not to the
size of the collection â€” which is why it takes the same 13s whether you hold
3,868 cards or 40.

Replacing it with one primary-key range scan per held series
(`where printing_key = ? and finish = ?`, 3,868 statements) returns exactly the
same rows 6.2x faster, and makes the cost proportional to what is actually held.

Worth doing because it is the hot path behind every cache rebuild, every import,
and the first page load after an ingest. It would take the rebuild from ~30s to
roughly 15s, and it is the change that would make a second user's data cost a
second user's worth of work rather than another full table scan.

Not done yet: it is the most important query in the app and the deployment was
in progress. The row counts match exactly, so the risk is low.

### 9. Serve a stale value history rather than recomputing — done

Anything that changes holdings or prices invalidates the portfolio cache, and
until 2026-09-18 the next reader recomputed it inside their request: 20-35s,
with every concurrent request starting its own. Adding a single card did this.

Reads now serve what is cached, mark it `stale`, and ask for a rebuild in the
background. The dashboard shows "updating..." with a tip. A cold cache still
computes in-request, since there is nothing stale to serve and it happens once.

The rebuild is a child process (`REBUILD_COMMAND`), for the same reason the
ingest is: synchronous CPU-bound work in-process blocks the event loop and
starves every other request, node-cron included. Guarded by a module-level flag,
a 60s cooldown so a rebuild that fails to clear staleness cannot loop, and a
10 minute timeout.

Both importers and the add/remove holding actions now request a rebuild
directly rather than leaving it to whoever loads a page next. The daily ingest
already did, via `--rebuild-cache`.

Worth knowing: the spawned child inherits `DATABASE_PATH`, so the cache tests
set `REBUILD_COMMAND` empty — one of them was rebuilding the real database.

## Known issues

- **`next build` must use webpack.** The Turbopack build is a Next bug, not this
  app: same source, same machine.

  | builder | result | time | peak RSS |
  |---|---|---|---|
  | Turbopack | `memory allocation of 1430734612 bytes failed` | 9.3 min | **42.4 GB** |
  | webpack | success | **0.5 min** | **0.4 GB** |

  It dies during compilation, before any chunk is emitted. A clean `.next`
  changes nothing, and Tailwind was ruled out by pinning its sources. So
  `npm run build` passes `--webpack`; `build:turbopack` keeps the old path for
  retesting after a Next upgrade. `next dev` still uses Turbopack, unaffected.

- **Tailwind scans only `src/`.** Its v4 auto-detection crawls the whole
  project, which here means sitting beside 25 GB of SQLite and any stray build
  directory. A renamed `.next` — not covered by `.gitignore`, unlike `.next`
  itself — was read as source, produced class names out of binary chunks, and
  broke *every page* with `Parsing CSS source code failed`. `globals.css` uses
  `source(none)` and an explicit `@source`; anything added outside `src/` must
  be listed there.

- **A cold cache is still computed in the request.** Item 9 made a *stale* cache
  serve immediately, but an empty one has nothing to serve and pays 20-35s. Only
  happens on a first run or after the cache table is cleared.

## Housekeeping

- **`AllIdentifiers.json` is ~610 MB per archived version** and is not needed
  once the uuid map is merged (108,379 of 108,382 printings reachable). Dropping
  it from `FILES_TO_KEEP` would cut the weekly archive download by a third —
  worth it only if NAS space ever matters, which at 16 TB it does not.
- **`refs/original/` still holds the pre-rewrite history** with the old work
  email. Local only, never pushed. Purge when the remote is trusted.
- **`AGENTS.md` is tracked.** Written by `next dev`, names no vendor, recreated
  if deleted. Left deliberately; revisit if it becomes noise.
