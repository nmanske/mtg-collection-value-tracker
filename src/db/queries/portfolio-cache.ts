import { eq, sql } from "drizzle-orm";

import { VENDOR_CODES } from "@/db/codec";
import { holdings, portfolioDaily, syncMeta } from "@/db/schema";

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
 * outright. The newest price date completes it, since that is the only way the
 * price side can grow.
 *
 * It is a fingerprint, not a hash: two genuinely different collections could in
 * principle collide. Against a single user editing their own cards that is not
 * a real risk, and the cost of being wrong is one stale figure until the next
 * ingest, not corruption.
 */
export function cacheFingerprint(db: Db): string {
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
    .get();

  const priceMax = (
    db as unknown as { $client: import("better-sqlite3").Database }
  ).$client
    .prepare(
      `select (select max(date) from price_snapshots) as snapshots,
              (select max(date) from vendor_prices) as vendors`,
    )
    .get() as { snapshots: string | null; vendors: string | null };

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
    priceMax.snapshots ?? "-",
    priceMax.vendors ?? "-",
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

function rowsFor(db: Db, source: PriceVendor, basket: boolean): ValuePoint[] {
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
      sql`${portfolioDaily.priceSource} = ${VENDOR_CODES[source]}
          and ${portfolioDaily.basket} = ${basket ? 1 : 0}`,
    )
    .orderBy(portfolioDaily.date)
    .all();
}

export interface RebuildResult {
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
export function rebuildPortfolioCache(db: Db, log = (_: string) => {}): RebuildResult {
  const started = Date.now();
  const sqlite = (db as unknown as { $client: import("better-sqlite3").Database })
    .$client;

  const computed: {
    source: PriceVendor;
    basket: boolean;
    series: ValuationSeries;
  }[] = [];

  for (const source of PRICE_VENDORS) {
    for (const basket of [false, true]) {
      log(`  computing ${source}${basket ? " (basket)" : ""}...`);
      computed.push({
        source,
        basket,
        series: portfolioSeries(db, { priceSource: source, constantBasket: basket }),
      });
    }
  }

  // Fingerprinted *after* computing, so a change made while this ran leaves the
  // cache marked stale rather than silently blessed.
  const fingerprint = cacheFingerprint(db);
  let points = 0;

  sqlite.transaction(() => {
    db.delete(portfolioDaily).run();
    for (const { source, basket, series } of computed) {
      for (let i = 0; i < series.points.length; i += 500) {
        const slice = series.points.slice(i, i + 500);
        db.insert(portfolioDaily)
          .values(
            slice.map((point) => ({
              priceSource: VENDOR_CODES[source],
              basket,
              ...point,
            })),
          )
          .run();
        points += slice.length;
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
  options: { priceSource?: PriceVendor; constantBasket?: boolean } = {},
): ValuationSeries {
  const source = options.priceSource ?? "tcgplayer";
  const basket = options.constantBasket ?? false;

  if (cacheIsFresh(db)) {
    const points = rowsFor(db, source, basket);
    if (points.length > 0) {
      return {
        points,
        firstDate: points[0].date,
        lastDate: points[points.length - 1].date,
      };
    }
  }

  return portfolioSeries(db, {
    priceSource: source,
    constantBasket: basket,
  });
}
