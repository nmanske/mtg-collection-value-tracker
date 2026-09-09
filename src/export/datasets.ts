import type { Db } from "@/db/queries/printings";
import { portfolioSeries } from "@/db/queries/valuation";
import { MARKET_SIDES, VENDORS } from "@/db/schema";

import { csvRow, moneyCell, UTF8_BOM } from "./csv";

/**
 * The three exports.
 *
 * Kept to three because the useful groupings are: what you own, what it has
 * been worth, and what each card cost day by day. Everything else folds into
 * one of those rather than becoming a fourth file — vendor prices in
 * particular are columns, not their own export.
 *
 * Volume is the design constraint. Exporting the price tables as they are
 * stored would be 12.9 million canonical rows plus 2.7 million vendor rows.
 * Every export here is bounded by the size of the collection instead:
 *
 * - collection: one row per holding (3,724)
 * - value-history: one row per date (89)
 * - price-history: one row per held card, finish and date, with every vendor
 *   as a column (331,170 rather than ~3.1 million)
 */

export type ExportId = "collection" | "value-history" | "price-history";

export interface ExportSpec {
  id: ExportId;
  title: string;
  description: string;
  /** Rows this export would produce right now. */
  rows: (db: Db) => number;
  /** Emits the file a chunk at a time, so a large one never lands in memory. */
  stream: (db: Db) => Iterable<string>;
}

/** The vendor and side pairs that become columns, in a fixed order. */
const VENDOR_COLUMNS = VENDORS.flatMap((vendor) =>
  MARKET_SIDES.map((side) => ({ vendor, side })),
);

/** Cardmarket quotes euros; the header has to say so or the number lies. */
const CURRENCY_OF: Record<string, string> = {
  tcgplayer: "usd",
  cardkingdom: "usd",
  cardmarket: "eur",
  manapool: "usd",
};

const vendorHeader = ({ vendor, side }: { vendor: string; side: string }) =>
  `${vendor}_${side}_${CURRENCY_OF[vendor] ?? "usd"}`;

function client(db: Db) {
  return (db as unknown as { $client: import("better-sqlite3").Database })
    .$client;
}

function count(db: Db, statement: string): number {
  return (client(db).prepare(statement).get() as { c: number }).c;
}

/**
 * Everything you own, with today's prices from every vendor beside it.
 *
 * The vendor comparison lives here rather than in its own file: a row per
 * holding per vendor would be five times the rows to say the same thing, and
 * the interesting comparison is across a row, not down a column.
 */
const collection: ExportSpec = {
  id: "collection",
  title: "Collection",
  description:
    "One row per holding: card, quantity, condition, acquisition date, current value, and the latest price from every vendor including Card Kingdom's buylist.",
  rows: (db) => count(db, "select count(*) c from holdings"),
  *stream(db) {
    const header = [
      "name",
      "set_code",
      "set_name",
      "collector_number",
      "scryfall_id",
      "finish",
      "condition",
      "quantity",
      "date_added",
      "unit_price_usd",
      "value_usd",
      "price_date",
      "price_source",
      "manual_override_usd",
      "note",
      ...VENDOR_COLUMNS.map(vendorHeader),
    ];
    yield UTF8_BOM + csvRow(header);

    // The canonical price and every vendor series are read as correlated
    // lookups per holding. A collection is small, and each lookup rides the
    // price tables' primary keys.
    const vendorSelects = VENDOR_COLUMNS.map(
      ({ vendor, side }) => `(
        select vp.price_cents from vendor_prices vp
         where vp.printing_key = h.printing_key and vp.finish = h.finish
           and vp.vendor = '${vendor}' and vp.side = '${side}'
         order by vp.date desc limit 1
      ) as ${vendor}_${side}`,
    ).join(",\n");

    const statement = client(db).prepare(`
      select p.name, p.set_code, p.set_name, p.collector_number, p.scryfall_id,
             h.finish, h.condition, h.quantity, h.date_added,
             h.price_override_cents, h.note,
             (select ps.price_cents from price_snapshots ps
               where ps.printing_key = h.printing_key and ps.finish = h.finish
               order by ps.date desc limit 1) as unit_cents,
             (select ps.date from price_snapshots ps
               where ps.printing_key = h.printing_key and ps.finish = h.finish
               order by ps.date desc limit 1) as price_date,
             (select ps.source from price_snapshots ps
               where ps.printing_key = h.printing_key and ps.finish = h.finish
               order by ps.date desc limit 1) as price_source,
             ${vendorSelects}
        from holdings h
        join printings p on p.id = h.printing_key
       order by p.name, p.set_code, p.collector_number, h.finish
    `);

    for (const row of statement.iterate() as Iterable<
      Record<string, string | number | null>
    >) {
      // The override wins wherever it is set, matching how the app values it.
      const unit =
        row.price_override_cents != null
          ? (row.price_override_cents as number)
          : (row.unit_cents as number | null);

      yield csvRow([
        row.name,
        row.set_code,
        row.set_name,
        row.collector_number,
        row.scryfall_id,
        row.finish,
        row.condition,
        row.quantity,
        row.date_added,
        moneyCell(unit),
        unit == null ? "" : moneyCell(unit * (row.quantity as number)),
        row.price_override_cents != null ? "" : (row.price_date ?? ""),
        row.price_override_cents != null ? "manual" : (row.price_source ?? ""),
        moneyCell(row.price_override_cents as number | null),
        row.note ?? "",
        ...VENDOR_COLUMNS.map(({ vendor, side }) =>
          moneyCell(row[`${vendor}_${side}`] as number | null),
        ),
      ]);
    }
  },
};

/** The dashboard chart, both lines, one row per date. */
const valueHistory: ExportSpec = {
  id: "value-history",
  title: "Value history",
  description:
    "One row per date: the collection's value as held, the same cards valued across the whole window, and how many holdings each figure covers. This is the dashboard chart.",
  rows: (db) =>
    count(db, "select count(distinct date) c from price_snapshots"),
  *stream(db) {
    yield UTF8_BOM +
      csvRow([
        "date",
        "value_as_held_usd",
        "value_fixed_basket_usd",
        "holdings_held",
        "holdings_priced",
        "holdings_unpriced",
      ]);

    const asHeld = portfolioSeries(db).points;
    const basket = new Map(
      portfolioSeries(db, { constantBasket: true }).points.map((point) => [
        point.date,
        point.valueCents,
      ]),
    );

    for (const point of asHeld) {
      yield csvRow([
        point.date,
        moneyCell(point.valueCents),
        moneyCell(basket.get(point.date) ?? null),
        point.holdingsHeld,
        point.pricedHoldings,
        point.unpricedHoldings,
      ]);
    }
  },
};

/**
 * Daily prices for the cards you hold, every vendor on one row.
 *
 * Scoped to held printings and pivoted so each date is a single row. Exporting
 * the tables as stored would be roughly 3.1 million rows across two files; this
 * is 331,170 rows in one.
 *
 * Deliberately carries no card names, set codes or collector numbers. Those
 * belong to the card, not to the day, so repeating them once per date wrote
 * 8.3 MB of the 42 MB file to say the same 3,724 things 89 times. This file is
 * the time series and nothing else; join it to the collection export on
 * (scryfall_id, finish) to get names back.
 */
const priceHistory: ExportSpec = {
  id: "price-history",
  title: "Price history",
  description:
    "One row per card, finish and date, with every vendor and the buylist as columns. Identified by scryfall_id and finish — join it to the collection export on those two columns for names and set codes. The largest export by far.",
  rows: (db) =>
    count(
      db,
      `select count(*) c from (
         select printing_key, finish, date from price_snapshots ps
          where exists (select 1 from holdings h
                         where h.printing_key = ps.printing_key and h.finish = ps.finish)
         union
         select printing_key, finish, date from vendor_prices vp
          where exists (select 1 from holdings h
                         where h.printing_key = vp.printing_key and h.finish = vp.finish))`,
    ),
  *stream(db) {
    yield UTF8_BOM +
      csvRow([
        "date",
        // The join key back to the collection export.
        "scryfall_id",
        "finish",
        "tracked_price_usd",
        "tracked_source",
        "estimated",
        ...VENDOR_COLUMNS.map(vendorHeader),
      ]);

    const vendorSelects = VENDOR_COLUMNS.map(
      ({ vendor, side }) =>
        `max(case when vp.vendor = '${vendor}' and vp.side = '${side}'
                  then vp.price_cents end) as ${vendor}_${side}`,
    ).join(",\n");

    // Driven from the held (printing, finish) pairs so both price tables are
    // read along their primary keys, and grouped so a date is one row.
    const statement = client(db).prepare(`
      with held as (select distinct printing_key, finish from holdings)
      select d.date, p.scryfall_id,
             d.finish, ps.price_cents as tracked, ps.source, ps.estimated,
             ${vendorSelects}
        from (
          select h.printing_key, h.finish, s.date
            from held h join price_snapshots s
              on s.printing_key = h.printing_key and s.finish = h.finish
          union
          select h.printing_key, h.finish, v.date
            from held h join vendor_prices v
              on v.printing_key = h.printing_key and v.finish = h.finish
        ) d
        join printings p on p.id = d.printing_key
        left join price_snapshots ps
          on ps.printing_key = d.printing_key and ps.finish = d.finish
         and ps.date = d.date
        left join vendor_prices vp
          on vp.printing_key = d.printing_key and vp.finish = d.finish
         and vp.date = d.date
       group by d.printing_key, d.finish, d.date
       order by d.date desc, p.scryfall_id, d.finish
    `);

    for (const row of statement.iterate() as Iterable<
      Record<string, string | number | null>
    >) {
      yield csvRow([
        row.date,
        row.scryfall_id,
        row.finish,
        moneyCell(row.tracked as number | null),
        row.source ?? "",
        row.estimated ? "true" : "false",
        ...VENDOR_COLUMNS.map(({ vendor, side }) =>
          moneyCell(row[`${vendor}_${side}`] as number | null),
        ),
      ]);
    }
  },
};

export const EXPORTS: Record<ExportId, ExportSpec> = {
  collection,
  "value-history": valueHistory,
  "price-history": priceHistory,
};

export const EXPORT_ORDER: ExportId[] = [
  "collection",
  "value-history",
  "price-history",
];

export function isExportId(value: string): value is ExportId {
  return value in EXPORTS;
}

/** Row counts for every export, for the download page. */
export function exportSizes(db: Db): { id: ExportId; rows: number }[] {
  return EXPORT_ORDER.map((id) => ({ id, rows: EXPORTS[id].rows(db) }));
}
