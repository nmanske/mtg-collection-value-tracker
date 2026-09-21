import { eq, sql } from "drizzle-orm";
import { collectionWhere, OWNER, type CollectionScope } from "@/db/scope";

import { VENDOR_CODES } from "@/db/codec";
import { holdings, portfolioDaily, portfolioMonthly, syncMeta } from "@/db/schema";
import { requestCacheRebuild } from "@/lib/cache-refresh";
import { DAILY_RUN_KEY } from "@/lib/daily-ingest";

import type { Db } from "./printings";
import {
  PRICE_VENDORS,
  portfolioSeries,
  type PriceVendor,
  type ValuationSeries,
  type ValuePoint,
} from "./valuation";

/**
 * A cache of the daily portfolio totals.
 *
 * Reading the series is cheap; computing it is not. It walks every holding
 * against every date, which was 230ms over 89 dates and 5.6 seconds over 930,
 * and the archive backfill keeps adding dates. Nothing about the answer changes
 * between page loads — only an ingest or an edit to the collection can move it.
 *
 * The danger with any cache is serving a stale answer without knowing, which
 * for a portfolio value is worse than being slow. So this never trusts itself:
 * every read compares a fingerprint of the inputs, and recomputes on a
 * mismatch. The cache is an optimisation, never the source of truth.
 */

export const CACHE_FINGERPRINT_KEY = "portfolio_cache_fingerprint";

/**
 * Identifies the inputs the cache was built from.
 *
 * Deliberately covers the *whole* holdings set rather than a row count or a
 * latest timestamp. A holding added today can carry a `dateAdded` from 2021 and
 * rewrite every point in the series, so "newer than the cache" is not a usable
 * test — the question is whether the set is the same set at all.
 *
 * `sum(printing_key)` and `sum(quantity)` catch substitutions that leave the
 * count unchanged; `date_added` and its approximate flag are included because
 * both move points; `price_override_cents` because it replaces a price
 * outright.
 *
 * The price side is the part that was wrong first time. It used only the newest
 * date on each table, on the reasoning that prices can only grow forwards --
 * which is exactly false while an archive backfill is running, because that
 * fills the *middle*. The cache read as fresh for hours while the database
 * gained 715 days of history, and the dashboard quietly served the old series.
 *
 * So the ingest watermarks in `sync_meta` are included too. Every path that
 * writes prices advances one of them: the archive backfill after each build,
 * the daily job per MTGJSON version, the Scryfall metadata run. They are also
 * a handful of short rows, where counting 120 million price rows per page load
 * would not be. The residual gap is a hand-written INSERT that touches no
 * watermark; `npm run cache:portfolio` forces a rebuild for that case.
 *
 * It is a fingerprint, not a hash: two genuinely different collections could in
 * principle collide. Against a single user editing their own cards that is not
 * a real risk, and the cost of being wrong is one stale figure until the next
 * ingest, not corruption.
 */
export function cacheFingerprint(
  db: Db,
  scope: CollectionScope = OWNER,
): string {
  const h = db
    .select({
      rows: sql<number>`count(*)`,
      cards: sql<number>`coalesce(sum(${holdings.quantity}), 0)`,
      printings: sql<number>`coalesce(sum(${holdings.printingKey}), 0)`,
      overrides: sql<number>`coalesce(sum(${holdings.priceOverrideCents}), 0)`,
      approx: sql<number>`coalesce(sum(${holdings.dateAddedApprox}), 0)`,
      dates: sql<string>`coalesce(group_concat(distinct ${holdings.dateAdded}), '')`,
    })
    .from(holdings)
    .where(collectionWhere(scope))
    .get();

  const client = (db as unknown as {
    $client: import("better-sqlite3").Database;
  }).$client;

  // Both ends of each series, so history extending backwards is noticed as
  // well as forwards.
  const priceRange = client
    .prepare(
      `select (select min(date) from price_snapshots) as snapFirst,
              (select max(date) from price_snapshots) as snapLast,
              (select min(date) from vendor_prices) as vendorFirst,
              (select max(date) from vendor_prices) as vendorLast`,
    )
    .get() as Record<string, string | null>;

  // Every ingest advances one of these, including one that only fills gaps.
  const watermarks = (
    client
      .prepare("select key, value from sync_meta order by key")
      .all() as { key: string; value: string }[]
  )
    // Two keys are excluded, both for the same reason: they record what the
    // app did, not what the data is.
    //
    // The cache's own fingerprint, or storing it would change the value it was
    // computed from and nothing would ever read as fresh.
    //
    // And the daily run record, which carries a timestamp and a duration that
    // change on every run. The scheduler writes it *after* the ingest child has
    // rebuilt the cache, so including it invalidated the cache the moment it
    // was rebuilt and handed the next visitor a 20-35s recompute — every day,
    // exactly the cost the rebuild exists to avoid.
    .filter(
      (row) => row.key !== CACHE_FINGERPRINT_KEY && row.key !== DAILY_RUN_KEY,
    )
    .map((row) => `${row.key}=${row.value}`)
    .join(",");

  // The date list is summarised rather than carried whole: a few hundred
  // distinct dates would make this string kilobytes long for no extra safety.
  let dateHash = 0;
  for (const char of h?.dates ?? "") {
    dateHash = (dateHash * 31 + char.charCodeAt(0)) | 0;
  }

  return [
    h?.rows ?? 0,
    h?.cards ?? 0,
    h?.printings ?? 0,
    h?.overrides ?? 0,
    h?.approx ?? 0,
    dateHash,
    priceRange.snapFirst ?? "-",
    priceRange.snapLast ?? "-",
    priceRange.vendorFirst ?? "-",
    priceRange.vendorLast ?? "-",
    watermarks,
  ].join(":");
}

function storedFingerprint(db: Db): string | null {
  return (
    db
      .select()
      .from(syncMeta)
      .where(eq(syncMeta.key, CACHE_FINGERPRINT_KEY))
      .get()?.value ?? null
  );
}

/** Whether the cache matches the current data. */
export function cacheIsFresh(db: Db): boolean {
  const stored = storedFingerprint(db);
  return stored !== null && stored === cacheFingerprint(db);
}

/**
 * The stored `price_source` for the buylist view.
 *
 * Deliberately outside the vendor codes rather than a new column. The cache is
 * keyed by an integer, so a value no vendor uses gives the buylist its own
 * slot without a migration, and `VENDOR_CODES` stays a description of vendors
 * rather than of cache rows.
 */
export const BUYLIST_CACHE_SOURCE = 100;

function rowsFor(
  db: Db,
  source: PriceVendor,
  basket: boolean,
  buylist = false,
  scope: CollectionScope = OWNER,
): ValuePoint[] {
  return db
    .select({
      date: portfolioDaily.date,
      valueCents: portfolioDaily.valueCents,
      holdingsHeld: portfolioDaily.holdingsHeld,
      pricedHoldings: portfolioDaily.pricedHoldings,
      unpricedHoldings: portfolioDaily.unpricedHoldings,
      inferredHoldings: portfolioDaily.inferredHoldings,
      acquiredHoldings: portfolioDaily.acquiredHoldings,
      acquiredCards: portfolioDaily.acquiredCards,
    })
    .from(portfolioDaily)
    .where(
      sql`${portfolioDaily.priceSource} = ${
        buylist ? BUYLIST_CACHE_SOURCE : VENDOR_CODES[source]
      }
          and ${portfolioDaily.basket} = ${basket ? 1 : 0}
          and ${portfolioDaily.sessionId} = ${scope}`,
    )
    .orderBy(portfolioDaily.date)
    .all();
}

export interface RebuildResult {
  /** Month links written for the like-for-like index, across all vendors. */
  months: number;
  views: number;
  points: number;
  seconds: number;
}

/**
 * Recomputes every view and replaces the cache.
 *
 * All four views in one transaction: a half-written cache that still matched
 * its fingerprint would serve a Card Kingdom line against TCGplayer totals.
 */
export function rebuildPortfolioCache(
  db: Db,
  log: (message: string) => void = () => {},
): RebuildResult {
  const started = Date.now();
  const sqlite = (db as unknown as { $client: import("better-sqlite3").Database })
    .$client;

  const computed: {
    source: PriceVendor;
    basket: boolean;
    /** Stored under BUYLIST_CACHE_SOURCE rather than the vendor's own code. */
    buylist?: boolean;
    series: ValuationSeries;
  }[] = [];

  for (const source of PRICE_VENDORS) {
    for (const basket of [false, true]) {
      log(`  computing ${source}${basket ? " (basket)" : ""}...`);
      computed.push({
        source,
        basket,
        series: portfolioSeries(db, {
          priceSource: source,
          constantBasket: basket,
          // Only on the basket pass: the links are a property of prices, not
          // of when cards were bought, and computing them twice per vendor
          // would produce two identical sets.
          monthLinks: basket,
        }),
      });
    }
  }

  // As-held only. A constant-basket buylist would answer "what would today's
  // cards have fetched in 2021", which is a question nobody has.
  log("  computing cardkingdom (buylist)...");
  computed.push({
    source: "cardkingdom",
    basket: false,
    buylist: true,
    series: portfolioSeries(db, { buylist: true }),
  });

  // Fingerprinted *after* computing, so a change made while this ran leaves the
  // cache marked stale rather than silently blessed.
  const fingerprint = cacheFingerprint(db);
  let points = 0;

  sqlite.transaction(() => {
    // Scoped. An unqualified delete here would throw away every uploaded
    // collection's cached views as well, which the daily job does at 10:00
    // UTC — under whoever happened to be reading one at the time.
    db.delete(portfolioDaily).where(eq(portfolioDaily.sessionId, OWNER)).run();
    db.delete(portfolioMonthly)
      .where(eq(portfolioMonthly.sessionId, OWNER))
      .run();
    for (const { source, basket, buylist, series } of computed) {
      for (let i = 0; i < series.points.length; i += 500) {
        const slice = series.points.slice(i, i + 500);
        db.insert(portfolioDaily)
          .values(
            slice.map((point) => ({
              priceSource: buylist ? BUYLIST_CACHE_SOURCE : VENDOR_CODES[source],
              basket,
              ...point,
            })),
          )
          .run();
        points += slice.length;
      }

      for (let i = 0; i < (series.links?.length ?? 0); i += 500) {
        db.insert(portfolioMonthly)
          .values(
            series.links!.slice(i, i + 500).map((link) => ({
              priceSource: VENDOR_CODES[source],
              ...link,
            })),
          )
          .run();
      }
    }
    db.insert(syncMeta)
      .values({
        key: CACHE_FINGERPRINT_KEY,
        value: fingerprint,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: syncMeta.key,
        set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
      })
      .run();
  })();

  return {
    views: computed.length,
    points,
    months: computed.reduce((sum, c) => sum + (c.series.links?.length ?? 0), 0),
    seconds: (Date.now() - started) / 1000,
  };
}

/**
 * The series for one view, from the cache when it is current.
 *
 * Falls back to computing rather than to an empty or stale answer, so a cold or
 * outdated cache costs time and never correctness.
 */
export function cachedPortfolioSeries(
  db: Db,
  options: {
    priceSource?: PriceVendor;
    constantBasket?: boolean;
    buylist?: boolean;
    scope?: CollectionScope;
  } = {},
): ValuationSeries {
  const source = options.priceSource ?? "tcgplayer";
  const basket = options.constantBasket ?? false;
  const buylist = options.buylist ?? false;
  const scope = options.scope ?? OWNER;

  // An uploaded collection never changes after it is uploaded, so there is
  // nothing to invalidate and no fingerprint to keep: rows present means rows
  // correct. Prices move under it during the session, which is the right
  // trade — a visitor looking at a chart for ten minutes wants it to stay
  // still, not to pay a recompute because MTGJSON published.
  if (scope !== OWNER) return sessionSeries(db, scope, source, basket, buylist);

  const fresh = cacheIsFresh(db);
  const points = rowsFor(db, source, basket, buylist, scope);

  if (points.length > 0) {
    // Stale is served rather than recomputed. Recomputing here costs 20-35s
    // inside the request that noticed, and every concurrent request starts its
    // own — which is what made adding a single card hang the site. A rebuild
    // is asked for instead, out of process, and the page says it is updating.
    //
    // The numbers are a few minutes old at worst, which is a better answer to
    // "what is my collection worth" than half a minute of nothing.
    if (!fresh) requestCacheRebuild();

    return {
      points,
      // Only present when true, so a fresh read stays deep-equal to a computed
      // series — `test:cache` asserts exactly that.
      ...(fresh ? {} : { stale: true }),
      firstDate: points[0].date,
      lastDate: points[points.length - 1].date,
    };
  }

  // Nothing cached at all: a cold start, a view that has never been built, or
  // a migration that dropped the cache table.
  //
  // Ask for a rebuild before computing. Without this the empty case never
  // repaired itself: `requestCacheRebuild` was only reached on the *stale*
  // path, where rows exist but the fingerprint has moved, so an empty cache
  // meant every request recomputed the whole series inline, forever, until
  // somebody ran `cache:portfolio` by hand. better-sqlite3 is synchronous, so
  // those recomputes queue behind each other and the dashboard simply hangs —
  // which is exactly what 0010 caused, since it drops both cache tables.
  //
  // This request still pays the cost, because there is nothing stale to serve
  // instead. The next one should not have to.
  requestCacheRebuild();

  return portfolioSeries(db, {
    priceSource: source,
    constantBasket: basket,
    buylist,
    scope,
  });
}

/**
 * One view of an uploaded collection, computed on first ask and kept.
 *
 * Per view rather than the owner's all-at-once rebuild. That rebuild computes
 * five series and takes 20-35 seconds against a real collection, which is a
 * fine price to pay once a day in the background and an impossible one inside
 * an upload. A visitor who never opens the Card Kingdom tab never pays for it.
 */
function sessionSeries(
  db: Db,
  scope: CollectionScope,
  source: PriceVendor,
  basket: boolean,
  buylist: boolean,
): ValuationSeries {
  const cached = rowsFor(db, source, basket, buylist, scope);
  if (cached.length > 0) {
    return {
      points: cached,
      firstDate: cached[0].date,
      lastDate: cached[cached.length - 1].date,
    };
  }

  const series = portfolioSeries(db, {
    priceSource: source,
    constantBasket: basket,
    buylist,
    scope,
  });
  storeView(db, scope, source, basket, buylist, series);
  return series;
}

/** Writes one computed view into the cache. */
function storeView(
  db: Db,
  scope: CollectionScope,
  source: PriceVendor,
  basket: boolean,
  buylist: boolean,
  series: ValuationSeries,
): void {
  const sqlite = (db as unknown as { $client: import("better-sqlite3").Database })
    .$client;
  const priceSource = buylist ? BUYLIST_CACHE_SOURCE : VENDOR_CODES[source];

  sqlite.transaction(() => {
    for (let i = 0; i < series.points.length; i += 500) {
      db.insert(portfolioDaily)
        .values(
          series.points.slice(i, i + 500).map((point) => ({
            priceSource,
            basket,
            sessionId: scope,
            ...point,
          })),
        )
        // A second tab asking for the same view at the same moment writes the
        // same numbers; the first one there wins and the other is a no-op.
        .onConflictDoNothing()
        .run();
    }
  })();
}
