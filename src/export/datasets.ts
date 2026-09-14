import type { Db } from "@/db/queries/printings";
import { portfolioSeries } from "@/db/queries/valuation";
import {
  FINISH_CODES,
  PRICE_SOURCE_CODES,
  SIDE_CODES,
  VENDOR_CODES,
} from "@/db/codec";
import { MARKET_SIDES, VENDORS } from "@/db/schema";

import { csvRow, moneyCell, UTF8_BOM } from "./csv";

/**
 * The two exports: what you own, and what it has been worth.
 *
 * Both describe the user's own collection. `collection` is a snapshot of their
 * holdings with today's prices beside each one; `value-history` is a derived
 * daily total. Vendor prices are columns on the collection rather than their
 * own file, because the comparison a reader wants runs across a row.
 *
 * A per-card daily price series was deliberately removed. Price providers'
 * terms consistently forbid repackaging their data as a standalone feed or
 * bulk dataset, and an export button emitting one row per card per day is
 * exactly that shape — a risk that grows if this is ever offered commercially.
 * It was also 34 MB against 600 KB for everything else. The database file
 * remains the backup route for the accumulated history; see the README.
 *
 * Volume is still the design constraint on what is left. The price tables hold
 * 12.9 million canonical rows plus 2.7 million vendor rows; both exports here
 * are bounded by the size of the collection instead — one row per holding
 * (3,724) and one row per date (89).
 */

export type ExportId = "collection" | "value-history";

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

/** Every kept vendor quotes USD, and the header still says so explicitly. */
const vendorHeader = ({ vendor, side }: { vendor: string; side: string }) =>
  `${vendor}_${side}_usd`;

const FINISH_BY_CODE = new Map(
  Object.entries(FINISH_CODES).map(([name, code]) => [code, name]),
);
const PRICE_SOURCE_BY_CODE = new Map(
  Object.entries(PRICE_SOURCE_CODES).map(([name, code]) => [code, name]),
);

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
      // Whether that date is a floor rather than a fact. Without it an export
      // of 539 inferred holdings reads as 539 cards genuinely bought that day.
      "date_added_inferred",
      "unit_price_usd",
      "value_usd",
      "price_date",
      "price_source",
      "manual_override_usd",
      "note",
      ...VENDOR_COLUMNS.flatMap(({ vendor, side }) => [
        vendorHeader({ vendor, side }),
        // The date beside each price, so a three-year-old buylist quote does
        // not export looking identical to today's.
        `${vendor}_${side}_date`,
      ]),
    ];
    yield UTF8_BOM + csvRow(header);

    // The canonical price and every vendor series are read as correlated
    // lookups per holding. A collection is small, and each lookup rides the
    // price tables' primary keys.
    //
    // TCGplayer retail is the canonical series and lives in price_snapshots,
    // not vendor_prices. The column is emitted either way, so the file's shape
    // does not depend on which table happens to hold a given series.
    const vendorSelects = VENDOR_COLUMNS.map(({ vendor, side }) =>
      vendor === "tcgplayer" && side === "retail"
        ? `(
        select ps.price_cents from price_snapshots ps
         where ps.printing_key = h.printing_key and ps.finish = h.finish
         order by ps.date desc limit 1
      ) as ${vendor}_${side}, (
        select ps.date from price_snapshots ps
         where ps.printing_key = h.printing_key and ps.finish = h.finish
         order by ps.date desc limit 1
      ) as ${vendor}_${side}_date`
        : `(
        select vp.price_cents from vendor_prices vp
         where vp.printing_key = h.printing_key and vp.finish = h.finish
           and vp.vendor = ${VENDOR_CODES[vendor]} and vp.side = ${SIDE_CODES[side]}
         order by vp.date desc limit 1
      ) as ${vendor}_${side}, (
        select vp.date from vendor_prices vp
         where vp.printing_key = h.printing_key and vp.finish = h.finish
           and vp.vendor = ${VENDOR_CODES[vendor]} and vp.side = ${SIDE_CODES[side]}
         order by vp.date desc limit 1
      ) as ${vendor}_${side}_date`,
    ).join(",\n");

    const statement = client(db).prepare(`
      select p.name, p.set_code, p.set_name, p.collector_number, p.scryfall_id,
             h.finish, h.condition, h.quantity, h.date_added,
             h.date_added_approx, h.price_override_cents, h.note,
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
        // Coded on disk; the export must carry the name, not the code.
        FINISH_BY_CODE.get(row.finish as number) ?? "",
        row.condition,
        row.quantity,
        row.date_added,
        row.date_added_approx ? "yes" : "no",
        moneyCell(unit),
        unit == null ? "" : moneyCell(unit * (row.quantity as number)),
        row.price_override_cents != null ? "" : (row.price_date ?? ""),
        row.price_override_cents != null
          ? "manual"
          : (PRICE_SOURCE_BY_CODE.get(row.price_source as number) ?? ""),
        moneyCell(row.price_override_cents as number | null),
        row.note ?? "",
        ...VENDOR_COLUMNS.flatMap(({ vendor, side }) => [
          moneyCell(row[`${vendor}_${side}`] as number | null),
          (row[`${vendor}_${side}_date`] as string | null) ?? "",
        ]),
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

export const EXPORTS: Record<ExportId, ExportSpec> = {
  collection,
  "value-history": valueHistory,
};

export const EXPORT_ORDER: ExportId[] = ["collection", "value-history"];

export function isExportId(value: string): value is ExportId {
  return value in EXPORTS;
}

/** Row counts for every export, for the download page. */
export function exportSizes(db: Db): { id: ExportId; rows: number }[] {
  return EXPORT_ORDER.map((id) => ({ id, rows: EXPORTS[id].rows(db) }));
}
