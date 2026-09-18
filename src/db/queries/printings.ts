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
  /** Groups printings of the same card; used to cross-link a card page. */
  oracleId: string;
  name: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  imageUri: string | null;
  imageUriLarge: string | null;
  imageUriBack: string | null;
  imageUriBackLarge: string | null;
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
  oracleId: printings.oracleId,
  name: printings.name,
  setCode: printings.setCode,
  setName: printings.setName,
  collectorNumber: printings.collectorNumber,
  imageUri: printings.imageUri,
  imageUriLarge: printings.imageUriLarge,
  imageUriBack: printings.imageUriBack,
  imageUriBackLarge: printings.imageUriBackLarge,
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

/**
 * One printing by its Scryfall id, with its latest prices.
 *
 * Card pages are addressed by Scryfall id rather than the integer key: the
 * integer is an autoincrement that changes if the database is rebuilt from the
 * ingest, which would break every saved link. The Scryfall id is stable.
 */
export function getPrintingByScryfallId(
  db: Db,
  scryfallId: string,
): PrintingSearchResult | null {
  const row = db
    .select(PRINTING_COLUMNS)
    .from(printings)
    .where(eq(printings.scryfallId, scryfallId))
    .get();
  if (!row) return null;
  return withPrices(db, [row])[0];
}

/** Other printings of the same card, for cross-linking from a card page. */
export function otherPrintings(
  db: Db,
  oracleId: string,
  excludeScryfallId: string,
  limit = 24,
): PrintingSearchResult[] {
  const rows = db
    .select(PRINTING_COLUMNS)
    .from(printings)
    .where(
      and(
        eq(printings.oracleId, oracleId),
        sql`${printings.scryfallId} <> ${excludeScryfallId}`,
      ),
    )
    .orderBy(asc(printings.setCode), asc(printings.collectorNumber))
    .limit(limit)
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

export interface PricePoint {
  date: string;
  priceCents: number;
  source: string;
  /** True for synthetic points; rendered visually distinct from tracked data. */
  estimated: boolean;
}

/**
 * Full price history for one printing and finish, oldest first.
 *
 * Reads along the price table's primary key, (printing_key, finish, date), so
 * one card's history is a contiguous range scan rather than a lookup per day.
 */
export function priceHistory(
  db: Db,
  printingKey: number,
  finish: Finish,
): PricePoint[] {
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

export interface PriceStats {
  currentCents: number | null;
  currentDate: string | null;
  lowCents: number | null;
  lowDate: string | null;
  highCents: number | null;
  highDate: string | null;
  /** Change against the point N entries back, or null if history is shorter. */
  changeCents: number | null;
  changeRatio: number | null;
  changeFromDate: string | null;
}

/** Headline numbers for one card's price series. */
export function priceStats(points: PricePoint[], lookback = 30): PriceStats {
  if (points.length === 0) {
    return {
      currentCents: null,
      currentDate: null,
      lowCents: null,
      lowDate: null,
      highCents: null,
      highDate: null,
      changeCents: null,
      changeRatio: null,
      changeFromDate: null,
    };
  }

  const last = points[points.length - 1];
  let low = points[0];
  let high = points[0];
  for (const point of points) {
    if (point.priceCents < low.priceCents) low = point;
    if (point.priceCents > high.priceCents) high = point;
  }

  const index = points.length - 1 - lookback;
  const base = index >= 0 ? points[index] : null;

  return {
    currentCents: last.priceCents,
    currentDate: last.date,
    lowCents: low.priceCents,
    lowDate: low.date,
    highCents: high.priceCents,
    highDate: high.date,
    changeCents: base ? last.priceCents - base.priceCents : null,
    // A ratio against zero is not meaningful; the absolute change still is.
    changeRatio:
      base && base.priceCents !== 0
        ? (last.priceCents - base.priceCents) / base.priceCents
        : null,
    changeFromDate: base?.date ?? null,
  };
}
