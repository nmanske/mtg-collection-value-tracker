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
 * is valued from — and `vendor_prices` holds everything else: Card Kingdom's
 * two sides, and TCGplayer's buylist where an archived build supplied one.
 * Storing TCGplayer retail in both was the simpler shape while this covered one
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

/** Both tables as one logical vendor series. */
const ALL_VENDOR_PRICES = `
  select printing_key, finish, vendor, side, date, price_cents
    from vendor_prices
  union all
  ${TCG_RETAIL_FROM_SNAPSHOTS}`;

function client(db: Db) {
  return (db as unknown as { $client: import("better-sqlite3").Database })
    .$client;
}

export interface VendorQuote {
  vendor: Vendor;
  side: MarketSide;
  priceCents: number;
  date: string;
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
              max(date) as date, price_cents as priceCents
         from (${ALL_VENDOR_PRICES})
        where printing_key = ? and finish = ?
        group by vendor, side`,
    )
    .all(printingKey, FINISH_CODES[finish]) as RawQuote[];

  return rows.map((row) => ({
    vendor: VENDOR_BY_CODE.get(row.vendor)!,
    side: SIDE_BY_CODE.get(row.side)!,
    priceCents: row.priceCents,
    date: row.date,
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
  date: string | null;
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
  // Written by hand: the shape is a latest-per-series subquery joined back to
  // holdings, which Drizzle's builder cannot express, and the plan is what
  // keeps each branch of the union on its own primary key.
  // Each branch of the union is restricted to held series *before* it
  // aggregates. Grouping first and joining after is the obvious shape and is
  // what the single-table version did, but it makes the price_snapshots branch
  // reduce all 12.9 million rows to find the ~3,700 that a collection needs —
  // measured at 8.2 seconds against 0.2 for this.
  const rows = client(db)
    .prepare(
      `with held as (select distinct printing_key, finish from holdings)
       select latest.vendor    as vendor,
              latest.side      as side,
              sum(h.quantity * latest.price_cents) as totalCents,
              count(*)         as covered,
              max(latest.date) as date
         from holdings h
         join (
           select vp.printing_key, vp.finish, vp.vendor, vp.side,
                  max(vp.date) as date, vp.price_cents
             from vendor_prices vp
             join held on held.printing_key = vp.printing_key
                      and held.finish = vp.finish
            group by vp.printing_key, vp.finish, vp.vendor, vp.side
           union all
           select ps.printing_key, ps.finish,
                  ${VENDOR_CODES.tcgplayer}, ${SIDE_CODES.retail},
                  max(ps.date), ps.price_cents
             from price_snapshots ps
             join held on held.printing_key = ps.printing_key
                      and held.finish = ps.finish
            where ps.source != ${PRICE_SOURCE_CODES.manual}
            group by ps.printing_key, ps.finish
         ) latest
           on latest.printing_key = h.printing_key
          and latest.finish = h.finish
        group by latest.vendor, latest.side`,
    )
    .all() as (Omit<RawQuote, "priceCents"> & {
    totalCents: number;
    covered: number;
  })[];

  const totalHoldings =
    db.select({ n: sql<number>`count(*)` }).from(holdings).get()?.n ?? 0;

  return rows
    .map((row) => ({
      vendor: VENDOR_BY_CODE.get(row.vendor)!,
      side: SIDE_BY_CODE.get(row.side)!,
      totalCents: row.totalCents,
      covered: row.covered,
      missing: totalHoldings - row.covered,
      date: row.date,
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
           from vendor_prices
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
