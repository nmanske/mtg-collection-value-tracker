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

### 2. Daily cron to load the database

Partly built already, so the work is smaller than it looks. `src/lib/scheduler.ts`
runs in-process via `node-cron` on `CRON_SCHEDULE` (10:15 UTC), and as of the
MTGJSON switch it does Scryfall metadata then `AllPricesToday`.

**Prices are not part of it, and currently do not run automatically at all.**
The MTGJSON ingest lives in `.mts` modules with `.mjs` import specifiers — what
TypeScript's NodeNext resolution requires for the ESM-only `stream-json` — and
Turbopack cannot follow those specifiers. Importing the ingest from the
scheduler broke the instrumentation hook and the server refused to start;
`serverExternalPackages` does not help, because the unresolvable module is ours
rather than a dependency. So the scheduler does metadata only and logs that
prices were skipped.

Options, roughly in order of appeal:

1. Run the ingest as a container-level cron calling the CLI. Needs `tsx` in the
   production image, which was deliberately excluded, or a build step for the
   scripts.
2. Give the daily path its own CJS-friendly module that dynamically imports
   `stream-json` — `AllPricesToday` is 50 MB, so it could even use `JSON.parse`
   and skip the streaming parser entirely, at the cost of a memory spike inside
   the web server.
3. Drop the in-process scheduler and make the price job purely external, which
   is arguably where a heavy ingest belongs anyway.

Also still true: it has **never been verified end to end in Docker**. Nothing
proves the container's cron fires, that a failure is visible, or that two
containers cannot run it at once. And a missed day is only recoverable for ~90
days before MTGJSON's window rolls past it (see item 1), so silent failure here
is expensive.

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
