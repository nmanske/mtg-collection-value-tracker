import { and, asc, eq, sql, type SQL } from "drizzle-orm";

import { FINISH_CODES } from "@/db/codec";
import type { Db } from "@/db/queries/printings";
import {
  DEFAULT_FILTER,
  DEFAULT_SORT,
  defaultDir,
  type FilterId,
  type SortDir,
  type SortId,
} from "@/lib/collection-view";
import {
  type Condition,
  type Finish,
  holdings,
  type HoldingSource,
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
  /** The set's release date, `YYYY-MM-DD`; null before a metadata ingest. */
  releasedAt: string | null;
  collectorNumber: string;
  imageUri: string | null;
  imageUriLarge: string | null;
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

export interface CollectionTotals {
  /** Distinct holdings, i.e. table rows. */
  holdingCount: number;
  totalCards: number;
  /** Sum over holdings that have a price. Excludes unpriced ones entirely. */
  totalValueCents: number;
  /**
   * Holdings with no price from any source and no override. Surfaced rather
   * than folded into the total as zero — a silent $0 misreports the collection.
   */
  unpricedCount: number;
}

export interface CollectionPage extends CollectionTotals {
  rows: HoldingRow[];
  page: number;
  pageCount: number;
  /**
   * Holdings matching the current filter and search.
   *
   * Distinct from `holdingCount`, which stays the whole collection. A filtered
   * view must not make the headline value drop — that reads as cards having
   * been lost rather than hidden — so the totals describe everything and this
   * describes what is on screen.
   */
  matched: number;
}

/** Rows per page. Rendering a whole 4,000-holding collection at once costs
 * seconds of server render time, while the underlying query takes ~76ms — the
 * cost is React, not SQLite, so the table is paged and the totals are not. */
export const PAGE_SIZE = 100;

/**
 * Collection totals, computed in one aggregate pass over every holding.
 *
 * Kept separate from the row query so that paging the table never changes the
 * headline value: the total is always the whole collection.
 */
export function collectionTotals(db: Db): CollectionTotals {
  const latest = sql`(
    select ps.price_cents
    from price_snapshots ps
    where ps.printing_key = ${holdings.printingKey}
      and ps.finish = ${holdings.finish}
    order by ps.date desc
    limit 1
  )`;

  // A manual override wins over any snapshot; a holding with neither is
  // counted as unpriced rather than as zero.
  const unit = sql`coalesce(${holdings.priceOverrideCents}, ${latest})`;

  const row = db
    .select({
      holdingCount: sql<number>`count(*)`,
      totalCards: sql<number>`coalesce(sum(${holdings.quantity}), 0)`,
      totalValueCents: sql<number>`coalesce(sum(case when ${unit} is null then 0 else ${unit} * ${holdings.quantity} end), 0)`,
      unpricedCount: sql<number>`coalesce(sum(case when ${unit} is null then 1 else 0 end), 0)`,
    })
    .from(holdings)
    .get();

  return {
    holdingCount: row?.holdingCount ?? 0,
    totalCards: row?.totalCards ?? 0,
    totalValueCents: row?.totalValueCents ?? 0,
    unpricedCount: row?.unpricedCount ?? 0,
  };
}

/**
 * The whole collection with each holding's latest unit price.
 *
 * The price join uses a lateral-style correlated subquery rather than the
 * grouped scan used for search: a collection is small, and this keeps each
 * lookup on the price table's primary key.
 */
export interface ListOptions {
  page?: number;
  sort?: SortId;
  dir?: SortDir;
  filter?: FilterId;
  /** Case-insensitive substring of the card or set name. */
  search?: string;
}

export function listHoldings(
  db: Db,
  options: ListOptions = {},
): CollectionPage {
  const totals = collectionTotals(db);
  const sort = options.sort ?? DEFAULT_SORT;
  const dir = options.dir ?? defaultDir(sort);
  const filter = options.filter ?? DEFAULT_FILTER;
  const search = options.search?.trim() ?? "";

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

  // The filter and search have to be applied before paging, and the count of
  // matches has to come from the same predicate — otherwise the page count
  // describes the whole collection while the rows describe a subset, and the
  // last pages are empty.
  const unitPrice = sql`coalesce(${holdings.priceOverrideCents}, ${latestPrice})`;
  const conditions = [];

  if (filter === "nonfoil") {
    conditions.push(sql`${holdings.finish} = ${FINISH_CODES.nonfoil}`);
  } else if (filter === "foil") {
    conditions.push(sql`${holdings.finish} = ${FINISH_CODES.foil}`);
  } else if (filter === "etched") {
    conditions.push(sql`${holdings.finish} = ${FINISH_CODES.etched}`);
  }

  if (search) {
    // Matched against the set name too: "ravnica" is how people look for a
    // set, and the code alone would not find it.
    //
    // `%` and `_` are LIKE wildcards, and a search box is a place people type
    // literal characters. Unescaped, "100%" silently matched anything starting
    // "100", and "_____" matched every holding in the collection — five
    // single-character wildcards. The term is already bound as a parameter, so
    // this is a correctness fix rather than an injection one, but a search that
    // quietly returns everything is its own kind of wrong.
    // The backslash must be escaped first, or it would double the escapes
    // added for % and _ on the next two lines.
    const escaped = search
      .toLowerCase()
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    const like = `%${escaped}%`;
    conditions.push(
      sql`(lower(${printings.name}) like ${like} escape '\\'
           or lower(${printings.setName}) like ${like} escape '\\'
           or lower(${printings.setCode}) like ${like} escape '\\')`,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const matched =
    db
      .select({ n: sql<number>`count(*)` })
      .from(holdings)
      .innerJoin(printings, eq(printings.id, holdings.printingKey))
      .where(where)
      .get()?.n ?? 0;

  const pageCount = Math.max(1, Math.ceil(matched / PAGE_SIZE));
  const current = Math.min(
    Math.max(1, Math.trunc(options.page ?? 1) || 1),
    pageCount,
  );

  // Every ordering ends with a unique-enough tiebreak. Without one, SQLite is
  // free to return equal rows in any order, and a holding could appear on two
  // pages or on none as the reader pages through.
  // Direction comes from the column header the reader clicked. Nulls are
  // pinned last in both directions for the money columns: an unpriced holding
  // leading a "most valuable" list is noise, and leading a "least valuable"
  // one is a different kind of wrong.
  const order = (expr: SQL) =>
    dir === "asc" ? sql`${expr} asc` : sql`${expr} desc`;
  const pricedFirst = sql`case when ${unitPrice} is null then 1 else 0 end`;

  const primary: Record<SortId, SQL[]> = {
    // Line value, not unit price: two copies of a $50 card outrank one $80
    // card in what the collection is actually worth.
    value: [pricedFirst, order(sql`${unitPrice} * ${holdings.quantity}`)],
    unit: [pricedFirst, order(sql`${unitPrice}`)],
    name: [order(sql`${printings.name}`)],
    acquired: [order(sql`${holdings.dateAdded}`)],
    quantity: [order(sql`${holdings.quantity}`)],
    set: [
      order(sql`${printings.setCode}`),
      // Collector numbers are text and sort "10" before "9"; casting compares
      // them as the numbers they are wherever they are numeric.
      order(sql`cast(${printings.collectorNumber} as integer)`),
      order(sql`${printings.collectorNumber}`),
    ],
    finish: [order(sql`${holdings.finish}`)],
    condition: [order(sql`${holdings.condition}`)],
  };

  const ordering = [
    ...primary[sort],
    asc(printings.name),
    asc(holdings.id),
  ];

  const rows = db
    .select({
      id: holdings.id,
      printingKey: holdings.printingKey,
      scryfallId: printings.scryfallId,
      name: printings.name,
      setCode: printings.setCode,
      setName: printings.setName,
      releasedAt: printings.releasedAt,
      collectorNumber: printings.collectorNumber,
      imageUri: printings.imageUri,
      imageUriLarge: printings.imageUriLarge,
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
    .where(where)
    .orderBy(...ordering)
    .limit(PAGE_SIZE)
    .offset((current - 1) * PAGE_SIZE)
    .all();

  const result: HoldingRow[] = rows.map((row) => {
    // A manual override wins over any snapshot: it exists precisely for
    // printings the price sources do not cover.
    const overridden = row.priceOverrideCents != null;
    const unitPriceCents = overridden
      ? row.priceOverrideCents
      : (row.snapshotPriceCents ?? null);

    return {
      id: row.id,
      printingKey: row.printingKey,
      scryfallId: row.scryfallId,
      name: row.name,
      setCode: row.setCode,
      setName: row.setName,
      releasedAt: row.releasedAt,
      collectorNumber: row.collectorNumber,
      imageUri: row.imageUri,
      imageUriLarge: row.imageUriLarge,
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

  // `totals` stays the whole collection: a filtered view should not make the
  // headline value drop, which would read as cards having been lost rather
  // than hidden. `matched` says how much of it is on screen.
  return { ...totals, rows: result, page: current, pageCount, matched };
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

/**
 * One desired holding from an import, before it is reconciled against what is
 * already stored.
 */
export interface DesiredHolding {
  printingKey: number;
  quantity: number;
  finish: Finish;
  condition: Condition;
  dateAdded: string;
  /** See `holdings.date_added_approx`. */
  dateAddedApprox?: boolean;
}

export interface ReconcileResult {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  /** Cards removed, for a report that talks in cards rather than rows. */
  cardsRemoved: number;
}

/** What makes two holdings the same holding for reconciliation purposes. */
const identity = (holding: DesiredHolding | HoldingRow) =>
  `${holding.printingKey}|${holding.finish}|${holding.condition}|${holding.dateAdded}`;

/**
 * Makes the holdings owned by `source` match `desired` exactly.
 *
 * A CSV export is a snapshot of a whole collection, not a batch to append, so
 * importing one has to add what is new, correct quantities that changed, and
 * remove what is no longer there. Appending instead means re-importing the same
 * file doubles the collection.
 *
 * Only rows belonging to `source` are touched, so hand-added cards survive an
 * import that does not mention them. Quantity is *set*, never accumulated —
 * the file is authoritative. A surviving row keeps its id, and with it any
 * price override or note, rather than being deleted and recreated.
 */
export function reconcileHoldings(
  db: Db,
  desired: DesiredHolding[],
  source: HoldingSource,
  now = new Date(),
): ReconcileResult {
  const wanted = new Map<string, DesiredHolding>();
  for (const holding of desired) {
    const key = identity(holding);
    const existing = wanted.get(key);
    // Two rows of the same card in one file are one holding of their sum;
    // that is a real thing Moxfield exports.
    if (existing) existing.quantity += holding.quantity;
    else wanted.set(key, { ...holding });
  }

  const current = db
    .select({
      id: holdings.id,
      printingKey: holdings.printingKey,
      quantity: holdings.quantity,
      finish: holdings.finish,
      condition: holdings.condition,
      dateAdded: holdings.dateAdded,
      dateAddedApprox: holdings.dateAddedApprox,
    })
    .from(holdings)
    .where(eq(holdings.source, source))
    .all();

  const result: ReconcileResult = {
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    cardsRemoved: 0,
  };

  const seen = new Set<string>();
  for (const row of current) {
    const key = identity(row);
    seen.add(key);
    const target = wanted.get(key);

    if (!target) {
      db.delete(holdings).where(eq(holdings.id, row.id)).run();
      result.removed += 1;
      result.cardsRemoved += row.quantity;
      continue;
    }

    // The flag is refreshed on every import, not only on insert: which rows sit
    // at the export's floor changes as the collection is edited, and a row that
    // stops being the oldest must stop claiming an inferred date.
    if (
      target.quantity !== row.quantity ||
      (target.dateAddedApprox ?? false) !== row.dateAddedApprox
    ) {
      db.update(holdings)
        .set({
          quantity: target.quantity,
          dateAddedApprox: target.dateAddedApprox ?? false,
        })
        .where(eq(holdings.id, row.id))
        .run();
      result.updated += 1;
    } else {
      result.unchanged += 1;
    }
  }

  const fresh = [...wanted.entries()]
    .filter(([key]) => !seen.has(key))
    .map(([, holding]) => ({ ...holding, source, createdAt: now }));

  for (let i = 0; i < fresh.length; i += 500) {
    db.insert(holdings).values(fresh.slice(i, i + 500)).run();
  }
  result.added = fresh.length;

  return result;
}

/**
 * Computes what {@link reconcileHoldings} would do, without writing. Used by
 * the importer's dry run, which must report removals before performing them.
 */
export function previewReconcile(
  db: Db,
  desired: DesiredHolding[],
  source: HoldingSource,
  /** Preview as though --adopt had claimed every unowned holding first. */
  adopt = false,
): ReconcileResult {
  const wanted = new Map<string, number>();
  for (const holding of desired) {
    const key = identity(holding);
    wanted.set(key, (wanted.get(key) ?? 0) + holding.quantity);
  }

  const current = db
    .select({
      printingKey: holdings.printingKey,
      quantity: holdings.quantity,
      finish: holdings.finish,
      condition: holdings.condition,
      dateAdded: holdings.dateAdded,
    })
    .from(holdings)
    .where(adopt ? undefined : eq(holdings.source, source))
    .all();

  const result: ReconcileResult = {
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    cardsRemoved: 0,
  };

  const seen = new Set<string>();
  for (const row of current) {
    const key = identity(row);
    seen.add(key);
    const target = wanted.get(key);
    if (target === undefined) {
      result.removed += 1;
      result.cardsRemoved += row.quantity;
    } else if (target !== row.quantity) {
      result.updated += 1;
    } else {
      result.unchanged += 1;
    }
  }

  for (const key of wanted.keys()) if (!seen.has(key)) result.added += 1;

  return result;
}

/**
 * Marks every holding of unknown provenance as owned by `source`.
 *
 * A one-time step for databases that were imported before holdings recorded
 * where they came from. Without it those rows read as hand-added, and the
 * first reconciling import would insert a second copy of the whole collection
 * beside them.
 */
export function adoptHoldings(db: Db, source: HoldingSource): number {
  return db
    .update(holdings)
    .set({ source })
    .where(eq(holdings.source, "manual"))
    .run().changes;
}

/** Every holding of one printing, for the card page's "you own this" line. */
export function holdingsForPrinting(db: Db, printingKey: number) {
  return db
    .select({
      id: holdings.id,
      quantity: holdings.quantity,
      finish: holdings.finish,
      condition: holdings.condition,
      dateAdded: holdings.dateAdded,
    })
    .from(holdings)
    .where(eq(holdings.printingKey, printingKey))
    .orderBy(asc(holdings.dateAdded))
    .all();
}

export function removeHolding(db: Db, id: number): boolean {
  return db.delete(holdings).where(eq(holdings.id, id)).run().changes > 0;
}

export function countHoldings(db: Db): number {
  return db.select({ n: sql<number>`count(*)` }).from(holdings).get()?.n ?? 0;
}
