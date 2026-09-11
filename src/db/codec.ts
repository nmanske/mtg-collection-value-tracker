/**
 * Integer codes for the low-cardinality columns on the price tables.
 *
 * At archive scale these columns dominate the row. A `vendor_prices` row stores
 * `'cardkingdom'`, `'nonfoil'`, `'retail'` and `'USD'` — 31 bytes of repeated
 * string against 9 bytes of actual data — and there are ~960 million of them
 * once five years of history is loaded. Encoding each as a small integer, and
 * dropping `currency` now that only USD vendors are kept, takes the row from
 * roughly 54 bytes to 24. That halves the table on disk and, because both hot
 * queries are range scans over the primary key, roughly halves their I/O too.
 *
 * The codes are applied at the database boundary through Drizzle's
 * {@link customType}, so `Finish`, `Vendor`, `MarketSide` and `PriceSource`
 * stay string unions everywhere in TypeScript. Query builders, server
 * components and the CSV export are unaffected; only hand-written SQL has to
 * name a code, and for that the maps are exported below.
 *
 * Codes are append-only and must never be renumbered — they are written into
 * hundreds of millions of rows. A retired value keeps its code forever.
 */
import { customType } from "drizzle-orm/sqlite-core";

import type { Finish, MarketSide, PriceSource, Vendor } from "./schema-enums";

/** Builds a bidirectional code map and the Drizzle column type over it. */
function coded<T extends string>(name: string, values: Record<T, number>) {
  const decode = new Map<number, T>(
    (Object.entries(values) as [T, number][]).map(([key, code]) => [code, key]),
  );

  const column = customType<{ data: T; driverData: number }>({
    dataType: () => "integer",
    toDriver(value: T): number {
      const code = values[value];
      if (code === undefined) {
        throw new Error(`Unknown ${name}: ${String(value)}`);
      }
      return code;
    },
    fromDriver(value: number): T {
      const decoded = decode.get(value);
      if (decoded === undefined) {
        // Loudly, rather than returning undefined into a price calculation:
        // an unrecognised code means the data was written by a newer build.
        throw new Error(`Unknown ${name} code: ${value}`);
      }
      return decoded;
    },
  });

  return { codes: values, column };
}

export const FINISH_CODES: Record<Finish, number> = {
  nonfoil: 0,
  foil: 1,
  etched: 2,
};

export const VENDOR_CODES: Record<Vendor, number> = {
  tcgplayer: 0,
  cardkingdom: 1,
};

export const SIDE_CODES: Record<MarketSide, number> = {
  retail: 0,
  buylist: 1,
};

export const PRICE_SOURCE_CODES: Record<PriceSource, number> = {
  scryfall: 0,
  mtgjson: 1,
  manual: 2,
};

export const finishCode = coded("finish", FINISH_CODES).column;
export const vendorCode = coded("vendor", VENDOR_CODES).column;
export const sideCode = coded("market side", SIDE_CODES).column;
export const priceSourceCode = coded("price source", PRICE_SOURCE_CODES).column;
