import { and, asc, eq, sql } from "drizzle-orm";

import {
  type Currency,
  type Finish,
  holdings,
  type MarketSide,
  type Vendor,
  vendorPrices,
} from "@/db/schema";

import type { Db } from "./printings";

/**
 * Multi-vendor and buylist queries.
 *
 * Everything here reads `vendor_prices`, which covers held printings only.
 * Nothing here feeds the portfolio valuation: that stays on the canonical
 * TCGplayer-retail series in `price_snapshots`, so the headline number keeps
 * one definition.
 *
 * Currency is carried through every result and never converted. Cardmarket
 * quotes euros; a EUR figure must never be added to a USD total, so totals are
 * computed per currency and the UI labels them.
 */

export interface VendorQuote {
  vendor: Vendor;
  side: MarketSide;
  priceCents: number;
  currency: Currency;
  date: string;
}

/** Latest quote from every vendor and side for one printing and finish. */
export function vendorQuotes(
  db: Db,
  printingKey: number,
  finish: Finish,
): VendorQuote[] {
  return db
    .select({
      vendor: vendorPrices.vendor,
      side: vendorPrices.side,
      // SQLite takes the non-aggregated columns from the row supplying max().
      date: sql<string>`max(${vendorPrices.date})`,
      priceCents: vendorPrices.priceCents,
      currency: vendorPrices.currency,
    })
    .from(vendorPrices)
    .where(
      and(
        eq(vendorPrices.printingKey, printingKey),
        eq(vendorPrices.finish, finish),
      ),
    )
    .groupBy(vendorPrices.vendor, vendorPrices.side)
    .all();
}

export interface CollectionTotalsByVendor {
  vendor: Vendor;
  side: MarketSide;
  currency: Currency;
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
  // keeps it on the vendor_prices primary key.
  const sqlite = (
    db as unknown as { $client: import("better-sqlite3").Database }
  ).$client;

  const rows = sqlite
    .prepare(
      `select latest.vendor          as vendor,
              latest.side            as side,
              latest.currency        as currency,
              sum(h.quantity * latest.price_cents) as totalCents,
              count(*)               as covered,
              max(latest.date)       as date
         from holdings h
         join (
           select printing_key, finish, vendor, side, currency,
                  max(date) as date, price_cents
             from vendor_prices
            group by printing_key, finish, vendor, side
         ) latest
           on latest.printing_key = h.printing_key
          and latest.finish = h.finish
        group by latest.vendor, latest.side, latest.currency`,
    )
    .all() as {
    vendor: Vendor;
    side: MarketSide;
    currency: Currency;
    totalCents: number;
    covered: number;
    date: string;
  }[];

  const totalHoldings =
    db.select({ n: sql<number>`count(*)` }).from(holdings).get()?.n ?? 0;

  return rows
    .map((row) => ({ ...row, missing: totalHoldings - row.covered }))
    .sort((a, b) => {
      // Grouped by currency first. Nothing here converts, so ordering a euro
      // total among dollar ones would imply a ranking that does not exist.
      if (a.currency !== b.currency) return a.currency === "USD" ? -1 : 1;
      // Then retail before buylist, then by size.
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
  return db
    .select({ date: vendorPrices.date, priceCents: vendorPrices.priceCents })
    .from(vendorPrices)
    .where(
      and(
        eq(vendorPrices.printingKey, printingKey),
        eq(vendorPrices.finish, finish),
        eq(vendorPrices.vendor, vendor),
        eq(vendorPrices.side, side),
      ),
    )
    .orderBy(asc(vendorPrices.date))
    .all();
}

/** Whether any vendor data exists at all, for empty states. */
export function hasVendorData(db: Db): boolean {
  return (
    (db.select({ n: sql<number>`count(*)` }).from(vendorPrices).get()?.n ?? 0) > 0
  );
}
