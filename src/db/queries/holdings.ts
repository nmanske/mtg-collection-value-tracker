import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { Db } from "@/db/queries/printings";
import {
  type Condition,
  type Finish,
  holdings,
  type NewHolding,
  printings,
} from "@/db/schema";

export interface HoldingRow {
  id: number;
  printingKey: number;
  scryfallId: string;
  name: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  imageUri: string | null;
  quantity: number;
  finish: Finish;
  condition: Condition;
  dateAdded: string;
  priceOverrideCents: number | null;
  /** Latest known unit price, or null when nothing prices this finish. */
  unitPriceCents: number | null;
  /** The date `unitPriceCents` came from, for staleness display. */
  priceDate: string | null;
  /** True when the unit price is the user's manual override. */
  overridden: boolean;
}

export interface CollectionSummary {
  rows: HoldingRow[];
  totalCards: number;
  /** Sum over holdings that have a price. Excludes unpriced ones entirely. */
  totalValueCents: number;
  /**
   * Holdings with no price from any source and no override. Surfaced rather
   * than folded into the total as zero — a silent $0 misreports the collection.
   */
  unpricedCount: number;
}

/**
 * The whole collection with each holding's latest unit price.
 *
 * The price join uses a lateral-style correlated subquery rather than the
 * grouped scan used for search: a collection is small, and this keeps each
 * lookup on the price table's primary key.
 */
export function listHoldings(db: Db): CollectionSummary {
  const latestPrice = sql<number | null>`(
    select ps.price_cents
    from price_snapshots ps
    where ps.printing_key = ${holdings.printingKey}
      and ps.finish = ${holdings.finish}
    order by ps.date desc
    limit 1
  )`;

  const latestDate = sql<string | null>`(
    select ps.date
    from price_snapshots ps
    where ps.printing_key = ${holdings.printingKey}
      and ps.finish = ${holdings.finish}
    order by ps.date desc
    limit 1
  )`;

  const rows = db
    .select({
      id: holdings.id,
      printingKey: holdings.printingKey,
      scryfallId: printings.scryfallId,
      name: printings.name,
      setCode: printings.setCode,
      setName: printings.setName,
      collectorNumber: printings.collectorNumber,
      imageUri: printings.imageUri,
      quantity: holdings.quantity,
      finish: holdings.finish,
      condition: holdings.condition,
      dateAdded: holdings.dateAdded,
      priceOverrideCents: holdings.priceOverrideCents,
      snapshotPriceCents: latestPrice,
      priceDate: latestDate,
    })
    .from(holdings)
    .innerJoin(printings, eq(printings.id, holdings.printingKey))
    .orderBy(desc(holdings.dateAdded), asc(printings.name))
    .all();

  let totalCards = 0;
  let totalValueCents = 0;
  let unpricedCount = 0;

  const result: HoldingRow[] = rows.map((row) => {
    // A manual override wins over any snapshot: it exists precisely for
    // printings the price sources do not cover.
    const overridden = row.priceOverrideCents != null;
    const unitPriceCents = overridden
      ? row.priceOverrideCents
      : (row.snapshotPriceCents ?? null);

    totalCards += row.quantity;
    if (unitPriceCents == null) unpricedCount += 1;
    else totalValueCents += unitPriceCents * row.quantity;

    return {
      id: row.id,
      printingKey: row.printingKey,
      scryfallId: row.scryfallId,
      name: row.name,
      setCode: row.setCode,
      setName: row.setName,
      collectorNumber: row.collectorNumber,
      imageUri: row.imageUri,
      quantity: row.quantity,
      finish: row.finish,
      condition: row.condition,
      dateAdded: row.dateAdded,
      priceOverrideCents: row.priceOverrideCents,
      unitPriceCents,
      priceDate: overridden ? null : row.priceDate,
      overridden,
    };
  });

  return { rows: result, totalCards, totalValueCents, unpricedCount };
}

/**
 * Adds a holding, merging into an existing row when every identifying field
 * matches.
 *
 * Merging is limited to an exact match on printing, finish, condition *and*
 * acquisition date. Two copies bought on different days stay separate rows,
 * because `date_added` is what decides when a card starts contributing to the
 * value-over-time chart and collapsing them would backdate value.
 */
export function addHolding(
  db: Db,
  input: NewHolding,
): { id: number; merged: boolean } {
  const existing = db
    .select({ id: holdings.id, quantity: holdings.quantity })
    .from(holdings)
    .where(
      and(
        eq(holdings.printingKey, input.printingKey),
        eq(holdings.finish, input.finish),
        eq(holdings.condition, input.condition),
        eq(holdings.dateAdded, input.dateAdded),
      ),
    )
    .get();

  if (existing) {
    db.update(holdings)
      .set({ quantity: existing.quantity + input.quantity })
      .where(eq(holdings.id, existing.id))
      .run();
    return { id: existing.id, merged: true };
  }

  const [inserted] = db
    .insert(holdings)
    .values(input)
    .returning({ id: holdings.id })
    .all();

  return { id: inserted.id, merged: false };
}

export function removeHolding(db: Db, id: number): boolean {
  return db.delete(holdings).where(eq(holdings.id, id)).run().changes > 0;
}

export function countHoldings(db: Db): number {
  return db.select({ n: sql<number>`count(*)` }).from(holdings).get()?.n ?? 0;
}
