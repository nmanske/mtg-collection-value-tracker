import { sql } from "drizzle-orm";

import {
  type Finish,
  holdings,
  type MarketSide,
  type Vendor,
  vendorPrices,
} from "@/db/schema";
import {
  FINISH_CODES,
  PRICE_SOURCE_CODES,
  SIDE_CODES,
  VENDOR_CODES,
} from "@/db/codec";

import type { Db } from "./printings";

/**
 * Multi-vendor and buylist queries.
 *
 * The series are split across two tables and every query here reunites them.
 * `price_snapshots` holds TCGplayer retail — the canonical series the portfolio
 * is valued from — and `vendor_prices` holds Card Kingdom's two sides. Storing
 * TCGplayer retail in both was the simpler shape while this covered one
 * collection over 90 days; across every printing and five years the copy is
 * ~355 million rows, so the union is bought instead.
 *
 * Nothing here feeds the portfolio valuation, which stays on `price_snapshots`
 * alone so the headline number keeps one definition and one fast query.
 *
 * Every kept vendor quotes USD, so these totals are directly comparable — see
 * `VENDORS` for why Cardmarket's euro series is no longer stored.
 */

/**
 * TCGplayer retail as it appears in `vendor_prices`' shape.
 *
 * The columns are integer-coded on disk, so the literals here are codes rather
 * than names; `codec.ts` owns the mapping and these read from it so a renumber
 * cannot silently desynchronise the two.
 */
const TCG_RETAIL_FROM_SNAPSHOTS = `
  select printing_key, finish,
         ${VENDOR_CODES.tcgplayer} as vendor, ${SIDE_CODES.retail} as side,
         date, price_cents
    from price_snapshots
   where source != ${PRICE_SOURCE_CODES.manual}`;

/**
 * The half of the vendor series that `vendor_prices` owns.
 *
 * TCGplayer retail is excluded here rather than merely being absent: the two
 * tables must partition the series between them, and if the same one appears in
 * both it is counted twice. That is not hypothetical — an ingest bug wrote
 * TCGplayer retail into `vendor_prices` for 25 million rows, and the collection
 * total read $27,484 against a real $15,187. Excluding it in the query makes
 * the split hold regardless of what is in the table.
 */
const OTHER_VENDOR_PRICES = `
  select printing_key, finish, vendor, side, date, price_cents
    from vendor_prices
   where not (vendor = ${VENDOR_CODES.tcgplayer} and side = ${SIDE_CODES.retail})`;

/**
 * Every (vendor, side) that exists, and which table supplies it.
 *
 * The one place the split is written down. Anything reading "all vendor
 * series" goes through this rather than assuming a table.
 */
const SERIES: { vendor: Vendor; side: MarketSide; source: string }[] = [
  { vendor: "tcgplayer", side: "retail", source: TCG_RETAIL_FROM_SNAPSHOTS },
  {
    vendor: "cardkingdom",
    side: "retail",
    source: `${OTHER_VENDOR_PRICES} and vendor = ${VENDOR_CODES.cardkingdom} and side = ${SIDE_CODES.retail}`,
  },
  {
    vendor: "cardkingdom",
    side: "buylist",
    source: `${OTHER_VENDOR_PRICES} and vendor = ${VENDOR_CODES.cardkingdom} and side = ${SIDE_CODES.buylist}`,
  },
];

/**
 * Every reported series as one relation, built from SERIES.
 *
 * Derived rather than written out again, so a series the app no longer reports
 * cannot leak back in through a second definition. A stray TCGplayer buylist
 * row — the archive is full of them — is absent here because it is absent from
 * SERIES, not because a WHERE clause somewhere remembers to exclude it.
 */
const ALL_VENDOR_PRICES = SERIES.map(
  ({ vendor, side, source }) => `
  select printing_key, finish,
         ${VENDOR_CODES[vendor]} as vendor, ${SIDE_CODES[side]} as side,
         date, price_cents
    from (${source})`,
).join("\n  union all\n");

/**
 * How far behind a series' own newest date a quote may be and still count.
 *
 * Measured against the newest date *that series* has anywhere, not against
 * today. Both alternatives are wrong: "today" would mark everything stale the
 * moment the daily job misses a run, and a global newest date would penalise a
 * vendor whose feed lags. A per-series baseline moves with the data, so a hole
 * in our own history shifts the baseline and every card together and changes
 * nothing.
 *
 * Thirty days because these vendors publish roughly daily, so a month of
 * silence on one card means it was delisted rather than that the feed paused.
 * The real distribution is nowhere near the line: against a real collection the
 * split is 3,555 holdings quoted within a day against 122 last quoted three
 * years ago, so any threshold between a month and a year picks the same cards.
 */
export const STALE_AFTER_DAYS = 30;

function client(db: Db) {
  return (db as unknown as { $client: import("better-sqlite3").Database })
    .$client;
}

export interface VendorQuote {
  vendor: Vendor;
  side: MarketSide;
  priceCents: number;
  date: string;
  /**
   * Too far behind this series' newest data to be treated as current.
   *
   * Flagged here rather than dropped, which is the opposite of what the
   * collection totals do with the same quote. A total is a sum and must not
   * silently include a price nobody would honour; a single card's page is
   * answering "what is this worth", and "last quoted three years ago" is a
   * better answer than showing nothing at all.
   */
  stale: boolean;
}

interface RawQuote {
  vendor: number;
  side: number;
  priceCents: number;
  date: string;
}

const VENDOR_BY_CODE = new Map(
  Object.entries(VENDOR_CODES).map(([name, code]) => [code, name as Vendor]),
);
const SIDE_BY_CODE = new Map(
  Object.entries(SIDE_CODES).map(([name, code]) => [code, name as MarketSide]),
);

/** Latest quote from every vendor and side for one printing and finish. */
export function vendorQuotes(
  db: Db,
  printingKey: number,
  finish: Finish,
): VendorQuote[] {
  const rows = client(db)
    .prepare(
      `select vendor, side,
              -- SQLite takes the non-aggregated columns from the max() row.
              max(date) as date, price_cents as priceCents,
              -- Judged against the whole series, not this card: the question is
              -- whether the vendor has priced *this card* recently, and only
              -- the series says what recent means.
              (select date(max(date), '-${STALE_AFTER_DAYS} day')
                 from (${ALL_VENDOR_PRICES}) c
                where c.vendor = s.vendor and c.side = s.side) as cutoff
         from (${ALL_VENDOR_PRICES}) s
        where printing_key = ? and finish = ?
        group by vendor, side`,
    )
    .all(printingKey, FINISH_CODES[finish]) as (RawQuote & {
    cutoff: string | null;
  })[];

  return rows.map((row) => ({
    vendor: VENDOR_BY_CODE.get(row.vendor)!,
    side: SIDE_BY_CODE.get(row.side)!,
    priceCents: row.priceCents,
    date: row.date,
    stale: row.cutoff != null && row.date < row.cutoff,
  }));
}

export interface CollectionTotalsByVendor {
  vendor: Vendor;
  side: MarketSide;
  totalCents: number;
  /** Holdings this vendor and side actually quotes. */
  covered: number;
  /** Holdings it does not, which are simply absent from the total. */
  missing: number;
  /** Holdings this vendor quotes, but too long ago to count. Excluded above. */
  stale: number;
  /** The most recent quote in the total. */
  date: string | null;
  /**
   * The least recent quote in the total.
   *
   * `date` alone overstates how current a figure is: it only proves that *one*
   * holding was quoted that day. If a shop stopped listing a card, its old
   * price stays in the sum indefinitely, and a single "as of" date would
   * present a stale total as today's.
   */
  oldestDate: string | null;
}

/**
 * What the whole collection is worth from each vendor and side.
 *
 * Coverage differs per vendor, so a bare total would compare a full collection
 * against a partial one. `covered` and `missing` are returned alongside so the
 * UI can say what each figure actually spans — a buylist total over 78% of the
 * collection is not comparable to a retail total over all of it.
 */
export function collectionByVendor(db: Db): CollectionTotalsByVendor[] {
  // One correlated lookup per holding per series, rather than grouping the
  // price tables and joining the result back.
  //
  // The grouping shape reads better and was fast at 13 million snapshots; at 34
  // million and climbing it takes 7.9 seconds, because finding the latest date
  // per series means visiting every date in that series. Each subquery here
  // instead matches the full primary-key prefix — (printing_key, finish) on
  // snapshots, plus (vendor, side) on vendor_prices — and reads one row.
  // Each series' cutoff, resolved once here rather than as a scalar subquery
  // re-evaluated per holding.
  const cutoffs = new Map<string, string | null>();
  for (const { vendor, side, source } of SERIES) {
    const row = client(db)
      .prepare(
        `select date(max(date), '-${STALE_AFTER_DAYS} day') as cutoff
           from (${source})`,
      )
      .get() as { cutoff: string | null } | undefined;
    cutoffs.set(`${vendor}.${side}`, row?.cutoff ?? null);
  }

  const selects = SERIES.map(({ vendor, side, source }) => {
    const latest = (column: string) => `(
      select ${column} from (${source}) x
       where x.printing_key = h.printing_key and x.finish = h.finish
       order by x.date desc limit 1)`;
    const cutoff = cutoffs.get(`${vendor}.${side}`);
    // With no data at all there is nothing for a quote to be stale against.
    const fresh = cutoff ? `seen >= '${cutoff}'` : "1";

    return `select ${VENDOR_CODES[vendor]} as vendor, ${SIDE_CODES[side]} as side,
                   sum(case when ${fresh} then quantity * cents end) as totalCents,
                   count(case when ${fresh} then cents end) as covered,
                   count(case when cents is not null and not (${fresh}) then 1 end) as stale,
                   max(case when ${fresh} then seen end) as date,
                   min(case when ${fresh} then seen end) as oldestDate
              from (select h.quantity as quantity,
                           ${latest("x.price_cents")} as cents,
                           ${latest("x.date")} as seen
                      from holdings h)`;
  }).join("\n  union all\n  ");

  const rows = client(db).prepare(selects).all() as (Omit<
    RawQuote,
    "priceCents"
  > & {
    totalCents: number | null;
    covered: number;
    stale: number;
    oldestDate: string | null;
  })[];

  const totalHoldings =
    db.select({ n: sql<number>`count(*)` }).from(holdings).get()?.n ?? 0;

  return rows
    // A series nothing quotes yields a row of nulls rather than no row at all.
    .filter((row) => row.covered > 0)
    .map((row) => ({
      vendor: VENDOR_BY_CODE.get(row.vendor)!,
      side: SIDE_BY_CODE.get(row.side)!,
      totalCents: row.totalCents ?? 0,
      covered: row.covered,
      stale: row.stale,
      // A stale holding is missing from the total, because it is.
      missing: totalHoldings - row.covered,
      date: row.date,
      oldestDate: row.oldestDate,
    }))
    .sort((a, b) => {
      // Retail before buylist, then by size. All figures are USD, so a single
      // ordering is meaningful in a way it was not when euros were stored.
      if (a.side !== b.side) return a.side === "retail" ? -1 : 1;
      return b.totalCents - a.totalCents;
    });
}

export interface VendorSeriesPoint {
  date: string;
  priceCents: number;
}

/** One vendor and side's history for a printing, oldest first. */
export function vendorSeries(
  db: Db,
  printingKey: number,
  finish: Finish,
  vendor: Vendor,
  side: MarketSide,
): VendorSeriesPoint[] {
  // Read from whichever table owns this series rather than from the union: the
  // caller always names one, and a union would scan the other for nothing.
  const source =
    vendor === "tcgplayer" && side === "retail"
      ? TCG_RETAIL_FROM_SNAPSHOTS
      : `select printing_key, finish, vendor, side, date, price_cents
           from (${OTHER_VENDOR_PRICES})
          where vendor = ${VENDOR_CODES[vendor]} and side = ${SIDE_CODES[side]}`;

  return client(db)
    .prepare(
      `select date, price_cents as priceCents
         from (${source})
        where printing_key = ? and finish = ?
        order by date asc`,
    )
    .all(printingKey, FINISH_CODES[finish]) as VendorSeriesPoint[];
}

/** Whether any vendor data exists at all, for empty states. */
export function hasVendorData(db: Db): boolean {
  return (
    (db.select({ n: sql<number>`count(*)` }).from(vendorPrices).get()?.n ?? 0) > 0
  );
}
