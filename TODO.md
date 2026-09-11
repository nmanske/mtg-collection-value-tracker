# TODO

Working list. Newest context at the bottom of each item.

## Features

### 1. Fill gaps in the price timeline

The series has holes. Measured 2026-09-11, with the archive backfill still
running:

```
628 distinct dates, 2020-12-15 .. 2026-09-11
39 gaps, 1,469 missing days total
```

Three kinds, and they need different answers:

- **The 1,397-day hole between 2022-08-13 and 2026-06-11** is just the archive
  backfill not having reached those builds yet. It closes on its own.
- **Single missing days near the present** — 2026-09-10, 2026-08-29,
  2026-08-06. `AllPricesToday` only carries the current day, so a day the job
  did not run is gone unless an archived build covers it. Nothing currently
  notices or backfills these.
- **Runs of 4-14 days in 2021** (the largest: 2020-12-20 to 2021-01-04) are
  days MTGJSON itself did not publish, or builds that failed to download.
  Probably unfillable; worth confirming against `audit:archive` before assuming.

Wanted: a script that reports gaps (the query above is throwaway), and a way to
fill a recent one — re-running an archived build covering that date, or
accepting it and marking the point estimated so the chart can show it honestly.
Note `price_snapshots.estimated` already exists for exactly this and is
currently always false.

### 2. Daily cron to load the database

Partly built already, so the work is smaller than it looks. `src/lib/scheduler.ts`
runs in-process via `node-cron` on `CRON_SCHEDULE` (10:15 UTC), and as of the
MTGJSON switch it does Scryfall metadata then `AllPricesToday`.

What is missing: it has **never been verified end to end in Docker**. Nothing
proves the container's cron fires, that a failure is visible, or that two
containers cannot run it at once. Also worth deciding whether a missed day
should trigger a catch-up rather than being silently skipped (see item 1).

### 3. Click a card to zoom

Card images are small on the collection and search pages. Clicking should open a
larger view. `printings.image_uri` currently stores Scryfall's `normal` size;
a zoom probably wants `large` or `png`, which means either storing another URI
or deriving it — Scryfall's image URLs are pattern-based, but deriving them is
an undocumented assumption, so check before relying on it.

### 4. Toggle Card Kingdom vs TCGplayer on the collection graph

The portfolio chart is TCGplayer retail only. Card Kingdom retail now has the
same five-year depth in `vendor_prices`, so the series can be drawn.

Two things to get right. The valuation query reads `price_snapshots`
exclusively and is the fast path (~230ms); pointing it at `vendor_prices`
instead is not a one-line change. And Card Kingdom's coverage is not identical
— 3,663 of 3,724 holdings on the buylist side — so the two lines span slightly
different collections, which the UI has to say rather than imply.

## Known issues

- **Stale vendor quotes.** If a shop stops listing a card, its last price stays
  in the totals and on the card page forever. Two holdings are currently priced
  from January 2022 this way. The "Priced" column discloses the newest date and
  carries the oldest as a tooltip, but nothing excludes or flags a stale figure.
  A "drop quotes more than N days behind the newest data" rule would fix the
  class.
- **`next build` runs out of memory.** Fails with `memory allocation of
  ~950 MB failed`, including with the backfill stopped, so it is not the
  ingest's page cache. Untriaged. `next dev` is unaffected.
- **No automated test for the daily ingest.** `mtgjson-today.mts` is
  network-bound and the suite has no fixtures for that. The parser beneath it
  is covered by the archive tests; the download, skip-if-unchanged and sync-key
  paths are not.

## Housekeeping

- **`VACUUM` after the archive backfill finishes.** The migration showed ~50%
  reclaimed from B-tree churn; this run writes far more.
- **Re-measure the dashboard against the full dataset** once the backfill ends.
  Both slow queries so far only appeared past a certain row count.
- **~78 GB of `AllIdentifiers.json`** across the archive is no longer needed —
  the uuid map is merged and complete (108,379 of 108,382 printings reachable).
  Deletable whenever disk matters.
- **`refs/original/` still holds the pre-rewrite history** with the old work
  email. Local only, never pushed. Purge when the remote is trusted.
- **`AGENTS.md` is still tracked.** Written by `next dev`, names no vendor, and
  is recreated if deleted. Left deliberately; revisit if it becomes noise.
