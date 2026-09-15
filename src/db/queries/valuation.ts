import { and, lte, sql } from "drizzle-orm";

import { holdings, priceSnapshots } from "@/db/schema";

import {
  FINISH_CODES,
  PRICE_SOURCE_CODES,
  SIDE_CODES,
  VENDOR_CODES,
} from "@/db/codec";

import { cachedPortfolioSeries } from "./portfolio-cache";
import type { Db } from "./printings";

/**
 * Vendors the portfolio can be valued from.
 *
 * Only retail: a buylist total answers "what could I sell this for today",
 * which is a different question from "what has this been worth", and drawing
 * them on one axis would invite reading a 50% spread as a crash.
 */
export const PRICE_VENDORS = ["tcgplayer", "cardkingdom"] as const;
export type PriceVendor = (typeof PRICE_VENDORS)[number];

export const PRICE_VENDOR_LABEL: Record<PriceVendor, string> = {
  tcgplayer: "TCGplayer",
  cardkingdom: "Card Kingdom",
};

/**
 * Where each vendor's retail series lives.
 *
 * The two tables partition the series between them — TCGplayer retail is the
 * canonical one in `price_snapshots`, everything else is in `vendor_prices` —
 * so valuing from a different vendor is a change of source table, not a filter.
 */
const PRICE_SOURCE_SQL: Record<PriceVendor, string> = {
  tcgplayer: `select printing_key, finish, date, price_cents
                from price_snapshots
               where source != ${PRICE_SOURCE_CODES.manual}`,
  cardkingdom: `select printing_key, finish, date, price_cents
                  from vendor_prices
                 where vendor = ${VENDOR_CODES.cardkingdom}
                   and side = ${SIDE_CODES.retail}`,
};

/**
 * Portfolio valuation over time.
 *
 * The value at a date D is the sum, over every holding acquired on or before
 * D, of quantity times that printing-and-finish's price on D. Two details make
 * that harder than a join:
 *
 * 1. A printing is not priced every day. Vendors delist, sources have gaps,
 *    and MTGJSON's series average 86 of 89 days. Joining snapshots on an exact
 *    date makes those holdings worth zero on gap days, which shows up as the
 *    whole portfolio flickering downward. Prices are therefore carried forward
 *    from the last known day.
 * 2. Before a printing's first snapshot it contributes nothing, even if the
 *    holding is older. That is the v1 "truncate" behaviour from the spec:
 *    the alternative, flat-filling the earliest known price backwards, is
 *    deferred, and would be marked `estimated` when it lands.
 *
 * The series is computed in memory rather than in SQL. Doing it per date in
 * SQL means one correlated lookup per holding per date — roughly 331,000 for a
 * 3,700-holding collection over 89 days. Loading each held series once and
 * walking it with a cursor is a single pass over the same data.
 */

export interface ValuePoint {
  date: string;
  valueCents: number;
  /** Holdings acquired on or before this date. */
  holdingsHeld: number;
  /** Of those, how many had a usable price on this date. */
  pricedHoldings: number;
  /**
   * Holdings held but not priced on this date — either no source covers the
   * printing at all, or the date precedes its first snapshot. Excluded from
   * `valueCents` rather than counted as zero.
   */
  unpricedHoldings: number;
  /**
   * Holdings whose acquisition date is this date, and the cards they cover.
   *
   * The value line rises for two unrelated reasons — prices moving and cards
   * arriving — and the second is invisible in a single line. This is what lets
   * the chart mark the difference.
   */
  acquiredHoldings: number;
  acquiredCards: number;
  /**
   * Of `holdingsHeld`, how many are counted on an inferred date.
   *
   * These are holdings whose acquisition date is a floor rather than a fact —
   * see `holdings.date_added_approx`. They are counted from that date, which
   * is an upper bound on when they were acquired, so the line understates
   * rather than invents. The count travels with every point so the chart can
   * say which part of it rests on a date the source could not give.
   */
  inferredHoldings: number;
}

export interface ValuationSeries {
  points: ValuePoint[];
  /** The dates actually available in the price table, ascending. */
  firstDate: string | null;
  lastDate: string | null;
}

interface HoldingRow {
  quantity: number;
  /** Effective start date: the stamped one, or history's start when inferred. */
  dateAdded: string;
  inferred: boolean;
  priceOverrideCents: number | null;
  seriesKey: string;
}

/**
 * Identifies one (printing, finish) price series.
 *
 * Keyed on the *coded* finish, because the price matrix below is filled from a
 * hand-written statement read with `.raw(true)` — which returns the stored
 * integer, not the string Drizzle would decode it to. Holding rows come through
 * the query builder and so arrive decoded; encoding them here is what keeps the
 * two halves addressing the same series.
 */
const seriesKey = (printingKey: number, finishCode: number) =>
  `${printingKey}|${finishCode}`;

/**
 * The underlying better-sqlite3 connection.
 *
 * Two statements here are written by hand because their exact query plan is
 * what makes them fast, and Drizzle cannot express them.
 */
function clientOf(db: Db) {
  return (db as unknown as { $client: import("better-sqlite3").Database })
    .$client;
}

/**
 * Every date the price table knows about, ascending, within an optional range.
 *
 * Uses a recursive skip-scan rather than `select distinct date`. There are 89
 * distinct dates across 12.9 million rows, and SQLite answers the plain
 * `distinct` by walking every index entry — 893ms. Seeking to the next larger
 * date repeatedly is 89 index lookups instead: 2ms for an identical result.
 */
export function priceDates(db: Db, from?: string, to?: string): string[] {
  const sqlite = clientOf(db);
  const bounded = to ? "and date <= @to" : "";

  const rows = sqlite
    .prepare(
      `with recursive d(x) as (
         select min(date) from price_snapshots where 1 = 1 ${bounded}
         union all
         select (select min(date) from price_snapshots
                  where date > d.x ${bounded})
           from d where d.x is not null
       )
       select x as date from d
        where x is not null ${from ? "and x >= @from" : ""}
        order by x`,
    )
    .all({ from: from ?? null, to: to ?? null }) as { date: string }[];

  return rows.map((row) => row.date);
}

/**
 * Values the collection on every date in the price table between `from` and
 * `to`, inclusive.
 */
export function portfolioSeries(
  db: Db,
  options: {
    from?: string;
    to?: string;
    /**
     * Value today's holdings on every date, ignoring when each was acquired.
     *
     * The normal series answers "what was my collection worth then", which
     * mixes two different things: prices moving, and cards being bought. This
     * holds the basket fixed so only prices move — measured against the real
     * collection, 84% of an apparent 9.47% gain turned out to be acquisitions.
     *
     * It is not a market index. The basket is whatever is owned today, so it
     * is selected with hindsight; it is a fair proxy only to the extent the
     * collection is broad.
     */
    constantBasket?: boolean;
    /**
     * Which vendor's retail series to value from. Defaults to TCGplayer.
     *
     * The date axis stays TCGplayer's either way, so the two lines are drawn
     * against the same spine and are directly comparable; a Card Kingdom price
     * missing on some date is carried forward exactly as a gap in its own
     * series would be.
     *
     * The staleness rule that governs the vendor *totals* deliberately does not
     * apply here. A 2023 price is the correct value for a 2023 date — staleness
     * is only a question about what "latest" means, and a time series never
     * asks it.
     */
    priceSource?: PriceVendor;
  } = {},
): ValuationSeries {
  const sqlite = clientOf(db);
  const dates = priceDates(db, options.from, options.to);
  if (dates.length === 0) {
    return { points: [], firstDate: null, lastDate: null };
  }

  const held = db
    .select({
      quantity: holdings.quantity,
      dateAdded: holdings.dateAdded,
      dateAddedApprox: holdings.dateAddedApprox,
      priceOverrideCents: holdings.priceOverrideCents,
      printingKey: holdings.printingKey,
      finish: holdings.finish,
    })
    .from(holdings)
    .all();

  if (held.length === 0) {
    return {
      points: dates.map((date) => ({
        date,
        valueCents: 0,
        holdingsHeld: 0,
        pricedHoldings: 0,
        unpricedHoldings: 0,
        acquiredHoldings: 0,
        acquiredCards: 0,
        inferredHoldings: 0,
      })),
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
    };
  }

  // An inferred date is counted as given, not pulled back to the start of
  // history.
  //
  // It was pulled back at first, reasoning that drawing $0 through years the
  // cards demonstrably existed was the worse error. That was wrong twice over.
  // Moxfield's floor says a card was acquired on or *before* that day and
  // nothing more, so valuing 539 holdings from 2020 asserts three years of
  // ownership the file cannot support — it replaced a known-wrong number with
  // an unknowable one, and inflated the early history by roughly $900 to
  // $1,200 in the process.
  //
  // And it duplicated the constant-basket line, which already answers "what
  // would today's cards have been worth over this window" precisely by
  // ignoring acquisition dates. The as-held line exists to answer the other
  // question, and it cannot do that while quietly holding cards it has no
  // evidence were held.
  //
  // The flag is still carried, because the date being a floor is worth saying.
  const rows: HoldingRow[] = held.map((row) => ({
    quantity: row.quantity,
    dateAdded: row.dateAdded,
    inferred: row.dateAddedApprox,
    priceOverrideCents: row.priceOverrideCents,
    seriesKey: seriesKey(row.printingKey, FINISH_CODES[row.finish]),
  }));

  // Acquisitions per date, counted once rather than re-scanned per point.
  // Inferred holdings are deliberately excluded: the floor date is when the
  // collection was typed into Moxfield, not when 539 cards were bought, and a
  // tick mark that tall would read as a spending spree that never happened.
  // The step in the line is explained in words instead.
  const acquired = new Map<string, { holdings: number; cards: number }>();
  for (const row of rows) {
    if (row.inferred) continue;
    const entry = acquired.get(row.dateAdded) ?? { holdings: 0, cards: 0 };
    entry.holdings += 1;
    entry.cards += row.quantity;
    acquired.set(row.dateAdded, entry);
  }

  const lastDate = dates[dates.length - 1];

  // Carry-forward has to see prices from before a requested `from`, so the
  // matrix is built over the whole history up to `to` and sliced afterwards.
  const allDates = options.from ? priceDates(db, undefined, lastDate) : dates;

  const dateCount = allDates.length;
  const dateIndex = new Map<string, number>();
  allDates.forEach((date, i) => dateIndex.set(date, i));

  // Every distinct (printing, finish) actually held, numbered so prices can
  // live in one flat array rather than a map of arrays of objects.
  const seriesIndex = new Map<string, number>();
  const rowSeries = new Int32Array(rows.length);
  rows.forEach((row, i) => {
    let index = seriesIndex.get(row.seriesKey);
    if (index === undefined) {
      index = seriesIndex.size;
      seriesIndex.set(row.seriesKey, index);
    }
    rowSeries[i] = index;
  });

  // -1 means "no price known on this date". Prices are whole cents and fit an
  // Int32 comfortably; the largest card in the database is under $25,000.
  const NO_PRICE = -1;
  const prices = new Int32Array(seriesIndex.size * dateCount).fill(NO_PRICE);

  // Load only the series actually held, driven from holdings so the join uses
  // the price table's primary key on (printing_key, finish, date).
  //
  // Three things here are load-bearing, all measured against a real 3,700
  // holding collection over 12.9M snapshots:
  //
  // - Matching on printing AND finish, not printing alone. Filtering by
  //   printing only also drags in the foil rows of non-foil holdings: 581,296
  //   rows rather than 331,158.
  // - Ordering by the primary key rather than by date. price_snapshots is
  //   WITHOUT ROWID, so primary-key order is the storage order and costs
  //   nothing, while `order by date` forces a sort of the whole result:
  //   228ms against 114 seconds.
  // - Reading raw arrays rather than row objects, which avoids allocating one
  //   object per snapshot for a third of a million rows.
  const statement = sqlite.prepare(
    `select ps.printing_key, ps.finish, ps.date, ps.price_cents
       from (select distinct printing_key, finish from holdings) h
       join (${PRICE_SOURCE_SQL[options.priceSource ?? "tcgplayer"]}) ps
         on ps.printing_key = h.printing_key and ps.finish = h.finish
      where ps.date <= ?
      order by ps.printing_key, ps.finish, ps.date`,
  );

  for (const raw of statement.raw(true).iterate(lastDate) as Iterable<
    [number, number, string, number]
  >) {
    const series = seriesIndex.get(seriesKey(raw[0], raw[1]));
    if (series === undefined) continue;
    const column = dateIndex.get(raw[2]);
    if (column === undefined) continue;
    prices[series * dateCount + column] = raw[3];
  }

  // Fill gaps by carrying the last known price forward. Done once per series
  // rather than per holding, since many holdings share a printing.
  for (let series = 0; series < seriesIndex.size; series += 1) {
    const base = series * dateCount;
    let carried = NO_PRICE;
    for (let column = 0; column < dateCount; column += 1) {
      const value = prices[base + column];
      if (value === NO_PRICE) prices[base + column] = carried;
      else carried = value;
    }
  }

  const firstColumn = options.from ? (dateIndex.get(dates[0]) ?? 0) : 0;

  const points: ValuePoint[] = dates.map((date, offset) => {
    const column = firstColumn + offset;
    let valueCents = 0;
    let holdingsHeld = 0;
    let pricedHoldings = 0;
    let unpricedHoldings = 0;
    let inferredHoldings = 0;

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!options.constantBasket && row.dateAdded > date) continue;
      holdingsHeld += 1;
      if (row.inferred) inferredHoldings += 1;

      // A manual override applies for the whole life of the holding; it exists
      // for printings no source prices.
      if (row.priceOverrideCents != null) {
        valueCents += row.priceOverrideCents * row.quantity;
        pricedHoldings += 1;
        continue;
      }

      const price = prices[rowSeries[i] * dateCount + column];
      if (price === NO_PRICE) {
        // Nothing priced this printing on or before this date, so it
        // contributes nothing rather than a guess. This is the v1 truncate
        // rule for holdings older than their own price history.
        unpricedHoldings += 1;
        continue;
      }

      valueCents += price * row.quantity;
      pricedHoldings += 1;
    }

    const added = acquired.get(date);
    return {
      date,
      valueCents,
      holdingsHeld,
      pricedHoldings,
      unpricedHoldings,
      acquiredHoldings: added?.holdings ?? 0,
      acquiredCards: added?.cards ?? 0,
      inferredHoldings,
    };
  });

  return {
    points,
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
  };
}

/** The collection's value on one date. */
export function portfolioValueAt(db: Db, date: string): ValuePoint | null {
  // Ask for everything up to the date so carry-forward has the history it
  // needs, then keep the last point.
  const series = portfolioSeries(db, { to: date });
  return series.points.at(-1) ?? null;
}

export interface Change {
  /** Value at the start of the window, or null when the window predates data. */
  fromCents: number | null;
  fromDate: string | null;
  changeCents: number | null;
  /** Fractional change, e.g. 0.031 for +3.1%. Null when the base is zero. */
  changeRatio: number | null;
}

export interface PortfolioSummary {
  currentCents: number;
  currentDate: string | null;
  day: Change;
  week: Change;
  month: Change;
  allTime: Change;
  points: ValuePoint[];
  /**
   * The same holdings valued on every date regardless of when they were
   * acquired, so the movement is prices alone.
   */
  basketPoints: ValuePoint[];
  /** All-time change of the fixed basket: market movement without buying. */
  marketOnly: Change;
}

/**
 * Looks back `days` from the end of the series.
 *
 * Indexed by position rather than by calendar date: the price table has a row
 * per day it was collected, so stepping back N entries is the same as N days
 * of data, and it degrades gracefully when the history is shorter than the
 * window.
 */
function changeOver(points: ValuePoint[], days: number): Change {
  const empty: Change = {
    fromCents: null,
    fromDate: null,
    changeCents: null,
    changeRatio: null,
  };
  if (points.length === 0) return empty;

  const last = points[points.length - 1];
  const index = points.length - 1 - days;
  if (index < 0) return empty;

  const base = points[index];
  return {
    fromCents: base.valueCents,
    fromDate: base.date,
    changeCents: last.valueCents - base.valueCents,
    // A ratio against zero is not meaningful; the absolute change still is.
    changeRatio:
      base.valueCents === 0
        ? null
        : (last.valueCents - base.valueCents) / base.valueCents,
  };
}

export function portfolioSummary(
  db: Db,
  priceSource: PriceVendor = "tcgplayer",
): PortfolioSummary {
  // Through the cache: this is the dashboard's hot path, and recomputing both
  // series per request is what took 5.6 seconds over 930 dates. Falls back to
  // computing when the cache is cold or stale, so it costs time, never
  // correctness.
  const { points } = cachedPortfolioSeries(db, { priceSource });
  const { points: basketPoints } = cachedPortfolioSeries(db, {
    constantBasket: true,
    priceSource,
  });
  const last = points.at(-1);

  const allTime: Change =
    points.length > 0
      ? changeOver(points, points.length - 1)
      : { fromCents: null, fromDate: null, changeCents: null, changeRatio: null };

  const marketOnly: Change =
    basketPoints.length > 0
      ? changeOver(basketPoints, basketPoints.length - 1)
      : { fromCents: null, fromDate: null, changeCents: null, changeRatio: null };

  return {
    currentCents: last?.valueCents ?? 0,
    currentDate: last?.date ?? null,
    day: changeOver(points, 1),
    week: changeOver(points, 7),
    month: changeOver(points, 30),
    allTime,
    points,
    basketPoints,
    marketOnly,
  };
}

/** Count of distinct dates in the price table, for empty-state messaging. */
export function priceDateCount(db: Db): number {
  return (
    db
      .select({ n: sql<number>`count(distinct ${priceSnapshots.date})` })
      .from(priceSnapshots)
      .get()?.n ?? 0
  );
}

/** Holdings with no usable price at all, for the "price unavailable" callout. */
export function unpricedHoldingIds(db: Db, date: string): number[] {
  return db
    .select({ id: holdings.id })
    .from(holdings)
    .where(
      and(
        lte(holdings.dateAdded, date),
        sql`${holdings.priceOverrideCents} is null`,
        sql`not exists (
          select 1 from price_snapshots ps
          where ps.printing_key = ${holdings.printingKey}
            and ps.finish = ${holdings.finish}
            and ps.date <= ${date}
        )`,
      ),
    )
    .all()
    .map((row) => row.id);
}
