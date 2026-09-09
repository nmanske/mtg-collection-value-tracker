import { and, lte, sql } from "drizzle-orm";

import { holdings, priceSnapshots } from "@/db/schema";

import type { Db } from "./printings";

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
}

export interface ValuationSeries {
  points: ValuePoint[];
  /** The dates actually available in the price table, ascending. */
  firstDate: string | null;
  lastDate: string | null;
}

interface HoldingRow {
  quantity: number;
  dateAdded: string;
  priceOverrideCents: number | null;
  seriesKey: string;
}

const seriesKey = (printingKey: number, finish: string) =>
  `${printingKey}|${finish}`;

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
  options: { from?: string; to?: string } = {},
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
      })),
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
    };
  }

  const rows: HoldingRow[] = held.map((row) => ({
    quantity: row.quantity,
    dateAdded: row.dateAdded,
    priceOverrideCents: row.priceOverrideCents,
    seriesKey: seriesKey(row.printingKey, row.finish),
  }));

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
       join price_snapshots ps
         on ps.printing_key = h.printing_key and ps.finish = h.finish
      where ps.date <= ?
      order by ps.printing_key, ps.finish, ps.date`,
  );

  for (const raw of statement.raw(true).iterate(lastDate) as Iterable<
    [number, string, string, number]
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

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (row.dateAdded > date) continue;
      holdingsHeld += 1;

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

    return { date, valueCents, holdingsHeld, pricedHoldings, unpricedHoldings };
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

export function portfolioSummary(db: Db): PortfolioSummary {
  const { points } = portfolioSeries(db);
  const last = points.at(-1);

  const allTime: Change =
    points.length > 0
      ? changeOver(points, points.length - 1)
      : { fromCents: null, fromDate: null, changeCents: null, changeRatio: null };

  return {
    currentCents: last?.valueCents ?? 0,
    currentDate: last?.date ?? null,
    day: changeOver(points, 1),
    week: changeOver(points, 7),
    month: changeOver(points, 30),
    allTime,
    points,
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
