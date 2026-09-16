# TODO

Working list. Newest context at the bottom of each item.

## Features

### 1. Fill gaps in the price timeline

The series has holes, and they have four different causes — only one of which
is worth acting on.

**Reporting is done** — `npm run audit:gaps` classifies every run by cause, so
the list is actionable rather than 1,400 bare dates. Latest run:

```
677 days of prices, 2020-12-15 .. 2026-09-11
40 gap(s), 1,420 missing days
  1,351  backfill has not reached these builds yet   (fills itself)
     68  MTGJSON published no prices these days      (unfillable)
      1  the daily job did not run                   (2026-09-10)
      0  no archived build covers these days
```

That last line matters: the three Kaggle packages permanently missing upstream
cost nothing, because neighbouring builds' windows cover their dates.

**Still to do:** fill 2026-09-10. No archived build reaches it — the newest is
2026-09-04 — but MTGJSON's live `AllPrices` serves a rolling ~90-day window that
does, so `backfill:mtgjson -- --all --vendors` should recover it along with any
day since. Worth doing before that window rolls past it, and worth noting the
window is why a missed run is urgent rather than merely untidy.

Beyond that, days with no upstream data can only ever be interpolated.
`price_snapshots.estimated` exists for exactly this and is currently always
false; the chart already draws estimated points differently.

### 2. Daily cron to load the database — done

`src/lib/scheduler.ts` runs in-process via `node-cron` on `CRON_SCHEDULE`
(10:15 UTC) and now does Scryfall metadata **and** MTGJSON prices.

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

**Still unverified: Docker.** The image now carries `tsx`, the source and a
pruned production `node_modules` (the standalone bundle traces only what the web
app imports, so `stream-json` and `stream-chain` are absent from it), and sets
`INGEST_COMMAND` accordingly. None of this has been built or run — Docker is not
installed on the dev machine and `next build` still OOMs (see Known issues), so
nothing proves the container's schedule fires or that its ingest can reach the
database. Treat the Dockerfile change as untested.

### 3. Click a card to zoom — done, pending a re-ingest

Clicking a card image on the search or card page opens it full size; Escape or
the backdrop closes it.

`image_uri_large` is stored rather than derived. Scryfall's size variants do
differ only by a path segment today, but the docs call image URIs opaque and the
newer variants already disagree on file extension, so substitution would rely on
a coincidence upstream never promised.

**Remaining:** the column is null for all 108,382 existing rows until a metadata
ingest repopulates it, so the overlay currently shows the `normal` image
(488px) rather than `large` (672px). Run `npm run ingest:scryfall` once the
archive backfill is done — it is a 108k-row upsert and should not compete with
the backfill for the write lock.

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

## Known issues

- ~~**Stale vendor quotes.**~~ Done. A quote more than `STALE_AFTER_DAYS` (30)
  behind its own series' newest date is excluded from collection totals and
  flagged "not current" on the card page. Measured against a real collection
  that removes 188 Card Kingdom buylist holdings, last quoted in 2023, from a
  figure that had been presenting them as today's offer. Threshold is measured
  per series rather than against today, so a missed daily run does not mark the
  whole collection stale.
- **`next build` runs out of memory.** Fails with `memory allocation of
  ~950 MB failed`, including with the backfill stopped, so it is not the
  ingest's page cache. Untriaged. `next dev` is unaffected.
- ~~**No automated test for the daily ingest.**~~ Done. `test:today` drives the
  whole job from a gzipped fixture: an unmapped uuid, a build already recorded,
  `--force`, a new build, a dry run that must not mark the build done, and the
  vendor rules (Cardmarket's euros and MTGO's ticket prices excluded, TCGplayer
  retail kept out of `vendor_prices`). Only the HTTP fetch itself is unexercised.

## Housekeeping

- ~~**Run `npm run finalize` when the backfill ends.**~~ Done 2026-09-15.
  1,952 days of prices, 2020-12-15 .. 2026-09-11. 145 missing days remain, of
  which 144 were never published upstream and one is the missed daily run on
  2026-09-10; **zero** are attributable to the corrupt `version_0165`, so
  skipping it cost nothing. 539 acquisition dates inferred, cache rebuilt to
  7,808 points, `VACUUM INTO` produced `data/mtg-compact.db` at 25.59 GB
  (13% smaller).
- **Replace `data/mtg.db` with `data/mtg-compact.db`** once you have verified
  it — that file is also the one to copy to a server.
- **A slow request can starve the in-process scheduler.** Observed on
  2026-09-16: a metadata ingest invalidated the portfolio cache, the next page
  load spent 20.2s recomputing it synchronously, and node-cron logged
  `missed execution ... Possible blocking IO or high CPU`. The scheduled price
  run simply did not happen that minute. The new `--rebuild-cache` flag reduces
  the window — the cache is rebuilt in the ingest child rather than by the first
  visitor — but it does not close it: any synchronous recompute in the request
  path can still block the timer. A daily schedule makes a collision unlikely,
  not impossible. The real fixes are to serve a stale-but-labelled cache while a
  rebuild is pending, or to move the schedule out of the web process entirely.
- **The dashboard is slow while a bulk load runs** — 88s to no-response-in-120s
  during the backfill, against 0.9s with a warm cache. The backfill advances a
  watermark after every build, which correctly invalidates the cache, so every
  page load recomputes 3,706 holdings across 1,700 dates against a table being
  written to. Correct but unusable. Worth deciding whether a stale-but-labelled
  cache would be better than a live recompute while an ingest is running.
- **~78 GB of `AllIdentifiers.json`** across the archive is no longer needed —
  the uuid map is merged and complete (108,379 of 108,382 printings reachable).
  Deletable whenever disk matters.
- **`refs/original/` still holds the pre-rewrite history** with the old work
  email. Local only, never pushed. Purge when the remote is trusted.
- **`AGENTS.md` is still tracked.** Written by `next dev`, names no vendor, and
  is recreated if deleted. Left deliberately; revisit if it becomes noise.
