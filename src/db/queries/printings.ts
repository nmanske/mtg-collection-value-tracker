import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { type Finish, priceSnapshots, printings } from "@/db/schema";

/**
 * Queries take their database explicitly rather than reaching for the shared
 * singleton. That keeps this module free of `server-only` — which cannot load
 * outside a Next.js bundle — so the same code paths the app runs are the ones
 * the tests exercise, against a scratch database.
 */
export type Db = BetterSQLite3Database<Record<string, never>>;

export interface PrintingPrice {
  finish: Finish;
  priceCents: number;
  date: string;
  source: string;
}

export interface PrintingSearchResult {
  id: number;
  scryfallId: string;
  name: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  imageUri: string | null;
  finishes: Finish[];
  /** Latest known price per finish. A finish absent here has no price at all. */
  prices: PrintingPrice[];
}

export const SEARCH_LIMIT = 60;

/**
 * Latest price per (printing, finish) for the given printings.
 *
 * Relies on SQLite's documented bare-column behaviour: in a `group by` with
 * `max()`, the non-aggregated columns are taken from the row that supplied the
 * maximum. That makes this one indexed pass rather than a correlated subquery
 * per printing. It is SQLite-specific, which is fine — the schema is too.
 *
 * The latest price is read per printing rather than at a single global date,
 * because a printing whose listing lapsed should show its last known price,
 * not nothing.
 */
function latestPricesFor(
  db: Db,
  printingKeys: number[],
): Map<number, PrintingPrice[]> {
  const byPrinting = new Map<number, PrintingPrice[]>();
  if (printingKeys.length === 0) return byPrinting;

  const rows = db
    .select({
      printingKey: priceSnapshots.printingKey,
      finish: priceSnapshots.finish,
      date: sql<string>`max(${priceSnapshots.date})`,
      priceCents: priceSnapshots.priceCents,
      source: priceSnapshots.source,
    })
    .from(priceSnapshots)
    .where(inArray(priceSnapshots.printingKey, printingKeys))
    .groupBy(priceSnapshots.printingKey, priceSnapshots.finish)
    .all();

  for (const row of rows) {
    const list = byPrinting.get(row.printingKey) ?? [];
    list.push({
      finish: row.finish,
      priceCents: row.priceCents,
      date: row.date,
      source: row.source,
    });
    byPrinting.set(row.printingKey, list);
  }
  return byPrinting;
}

function withPrices(
  db: Db,
  rows: Omit<PrintingSearchResult, "prices">[],
): PrintingSearchResult[] {
  const prices = latestPricesFor(db, rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, prices: prices.get(row.id) ?? [] }));
}

const PRINTING_COLUMNS = {
  id: printings.id,
  scryfallId: printings.scryfallId,
  name: printings.name,
  setCode: printings.setCode,
  setName: printings.setName,
  collectorNumber: printings.collectorNumber,
  imageUri: printings.imageUri,
  finishes: printings.finishes,
};

/**
 * Finds printings by card name, or by an exact `set/collector-number` pair.
 *
 * Name matching is a substring `like`, which cannot use the name index, but a
 * scan of ~108k rows is well under a frame and avoids the surprise of a prefix
 * search failing to find "Sol Ring" from "ring". Results are capped so a query
 * like "a" returns a page rather than the whole table.
 */
export function searchPrintings(
  db: Db,
  query: string,
): PrintingSearchResult[] {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  // "blb/280" or "blb 280" addresses one exact printing.
  const exact = /^([a-z0-9]{2,6})[\s/]+([a-z0-9★-]+)$/i.exec(trimmed);
  if (exact) {
    const [, setCode, collectorNumber] = exact;
    const rows = db
      .select(PRINTING_COLUMNS)
      .from(printings)
      .where(
        and(
          eq(printings.setCode, setCode.toLowerCase()),
          eq(printings.collectorNumber, collectorNumber),
        ),
      )
      .all();
    if (rows.length > 0) return withPrices(db, rows);
    // Fall through to a name search when that is not a real printing.
  }

  const rows = db
    .select(PRINTING_COLUMNS)
    .from(printings)
    .where(like(printings.name, `%${trimmed}%`))
    .orderBy(
      // Exact matches first, then names that start with the query, so
      // "Sol Ring" outranks "Sol Ring of Fate" for the query "Sol Ring".
      sql`case
            when lower(${printings.name}) = lower(${trimmed}) then 0
            when lower(${printings.name}) like lower(${trimmed + "%"}) then 1
            else 2
          end`,
      asc(printings.name),
      asc(printings.setCode),
      asc(printings.collectorNumber),
    )
    .limit(SEARCH_LIMIT)
    .all();

  return withPrices(db, rows);
}

/** One printing by its integer key, with its latest prices. */
export function getPrinting(db: Db, id: number): PrintingSearchResult | null {
  const row = db.select(PRINTING_COLUMNS).from(printings).where(eq(printings.id, id)).get();
  if (!row) return null;
  return withPrices(db, [row])[0];
}

/** How many printings the database knows about, for the empty state. */
export function countPrintings(db: Db): number {
  return db.select({ n: sql<number>`count(*)` }).from(printings).get()?.n ?? 0;
}

/**
 * Full price history for one printing and finish, oldest first.
 * Feature 2's chart reads this directly.
 */
export function priceHistory(db: Db, printingKey: number, finish: Finish) {
  return db
    .select({
      date: priceSnapshots.date,
      priceCents: priceSnapshots.priceCents,
      source: priceSnapshots.source,
      estimated: priceSnapshots.estimated,
    })
    .from(priceSnapshots)
    .where(
      and(
        eq(priceSnapshots.printingKey, printingKey),
        eq(priceSnapshots.finish, finish),
      ),
    )
    .orderBy(asc(priceSnapshots.date))
    .all();
}
