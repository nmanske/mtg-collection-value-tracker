import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { finishCode, priceSourceCode, sideCode, vendorCode } from "./codec";
import type {
  Condition,
  Finish,
  HoldingSource,
} from "./schema-enums";

export * from "./schema-enums";

/**
 * One row per Scryfall printing.
 *
 * Carries a surrogate integer `id` alongside the natural `scryfallId` key.
 * Everything that references a printing does so by the integer: price history
 * runs to ~13 million rows, and repeating a 36-character UUID there — in the
 * row and again in its primary-key index — costs more than the price data
 * itself. `scryfallId` stays unique, so ingest still upserts on it.
 */
export const printings = sqliteTable(
  "printings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Scryfall `id`. The natural key, and what upstream data joins on. */
    scryfallId: text("scryfall_id").notNull().unique(),
    /** Scryfall `oracle_id`. Groups printings of a card; never a price key. */
    oracleId: text("oracle_id").notNull(),
    name: text("name").notNull(),
    setCode: text("set_code").notNull(),
    setName: text("set_name").notNull(),
    collectorNumber: text("collector_number").notNull(),
    /** Scryfall `image_uris.normal`, or the front face's for split layouts. */
    imageUri: text("image_uri"),
    /** Scryfall `finishes`, as a JSON array of {@link Finish}. */
    finishes: text("finishes", { mode: "json" })
      .$type<Finish[]>()
      .notNull()
      .default(sql`'["nonfoil"]'`),
    /** When this row was last written by the Scryfall bulk ingest. */
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Card search by name, and the Moxfield CSV import's
    // set + collector number lookup.
    index("printings_name_idx").on(t.name),
    index("printings_set_collector_idx").on(t.setCode, t.collectorNumber),
    index("printings_oracle_idx").on(t.oracleId),
  ],
);

/**
 * A card the user owns. Quantity is per (printing, finish, condition) — the
 * same printing in NM foil and LP foil are two holdings.
 */
export const holdings = sqliteTable(
  "holdings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    printingKey: integer("printing_key")
      .notNull()
      .references(() => printings.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    /**
     * Integer-coded like the price tables' own `finish`, not for size — this
     * table is tiny — but because every valuation query joins holdings to
     * price_snapshots on it. A text column here against a coded one there is a
     * comparison that simply never matches, and silently prices the whole
     * collection at nothing.
     */
    finish: finishCode("finish").notNull(),
    condition: text("condition").$type<Condition>().notNull(),
    /**
     * Acquisition date, `YYYY-MM-DD`. Drives the value-over-time chart: a
     * holding contributes nothing before this date. Moxfield's CSV has no
     * acquisition date, so bulk imports default this to the import date.
     */
    dateAdded: text("date_added").notNull(),
    /**
     * Manual price in whole cents, overriding all snapshots for this holding.
     * For printings with no price data at all (see "Case B") the user can set
     * a value rather than have the card silently counted as $0.
     *
     * Scoped to the holding rather than the printing: simpler for a
     * single-user app, at the cost of duplication if the same printing is held
     * twice. Revisit if per-printing overrides are ever wanted.
     */
    priceOverrideCents: integer("price_override_cents"),
    note: text("note"),
    /**
     * Which path created this holding. Defaults to `manual` so that a row of
     * unknown provenance is never deleted by an import; see the importer's
     * --adopt flag for claiming pre-existing rows.
     */
    source: text("source")
      .$type<HoldingSource>()
      .notNull()
      .default("manual"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("holdings_printing_idx").on(t.printingKey),
    // The importer reconciles against its own rows only.
    index("holdings_source_idx").on(t.source),
    // The valuation query walks holdings by date_added.
    index("holdings_date_added_idx").on(t.dateAdded),
  ],
);

/**
 * Daily price per printing and finish — the largest table by a wide margin,
 * so its shape is chosen for size.
 *
 * `(printing_key, finish, date)` is the primary key rather than a uniqueness
 * constraint bolted onto an autoincrement id. That drops a redundant column
 * and a second index over the same three values, and it is what makes
 * ingestion idempotent: the "never re-fetch a price already stored for that
 * day" rule is enforced by the key itself.
 *
 * Declared WITHOUT ROWID in the migration (see the note there): for a table
 * that is nothing but its key plus three small values, storing rows in the
 * primary-key B-tree rather than in a separate rowid table roughly halves the
 * footprint.
 */
export const priceSnapshots = sqliteTable(
  "price_snapshots",
  {
    printingKey: integer("printing_key")
      .notNull()
      .references(() => printings.id, { onDelete: "cascade" }),
    /** Stored as a small integer; see `codec.ts`. Reads and writes as a string. */
    finish: finishCode("finish").notNull(),
    /** `YYYY-MM-DD`, UTC. */
    date: text("date").notNull(),
    /**
     * USD in whole cents. Integer rather than float so that summing a whole
     * collection is exact.
     */
    priceCents: integer("price_cents").notNull(),
    source: priceSourceCode("source").notNull(),
    /**
     * True for synthetic points — e.g. an earliest-known price flat-filled
     * backward to cover a holding acquired before price history exists. The
     * chart must render these visibly differently from tracked data.
     */
    estimated: integer("estimated", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (t) => [
    primaryKey({ columns: [t.printingKey, t.finish, t.date] }),
    // Serves the per-date portfolio valuation, which sweeps every held
    // printing for one date. The primary key covers the other direction —
    // one printing's history — on its own.
    index("price_snapshots_date_idx").on(t.date),
  ],
);

/**
 * Multi-vendor price comparison, kept apart from `price_snapshots`.
 *
 * Two deliberate differences from the canonical series:
 *
 * - It is not what the portfolio is valued from. `price_snapshots` stays the
 *   single canonical TCGplayer-retail series so valuation keeps one definition
 *   and one fast query; this table is for answering "what would Card Kingdom
 *   pay me" beside it.
 * - It holds only what `price_snapshots` does not: Card Kingdom's two sides and
 *   TCGplayer's buylist. TCGplayer retail is deliberately *not* duplicated
 *   here. That duplication was cheap while this table covered one collection
 *   over 90 days; across every printing and five years it is ~355 million rows
 *   and ~18 GB of nothing, so the vendor comparison reads that one series from
 *   `price_snapshots` and unions it in.
 *
 * Its columns are integer-coded (see `codec.ts`) and carry no currency, both
 * for size: this table is the largest in the database after `price_snapshots`.
 */
export const vendorPrices = sqliteTable(
  "vendor_prices",
  {
    printingKey: integer("printing_key")
      .notNull()
      .references(() => printings.id, { onDelete: "cascade" }),
    /** All three stored as small integers; see `codec.ts`. */
    finish: finishCode("finish").notNull(),
    vendor: vendorCode("vendor").notNull(),
    side: sideCode("side").notNull(),
    /** `YYYY-MM-DD`, UTC. */
    date: text("date").notNull(),
    /** USD in whole cents. Every kept vendor quotes dollars. */
    priceCents: integer("price_cents").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.printingKey, t.finish, t.vendor, t.side, t.date],
    }),
    // Serves "every vendor on this date" for a collection-wide comparison.
    index("vendor_prices_date_idx").on(t.date),
  ],
);

/**
 * Printings with no usable price from any source, so they can be surfaced in
 * the UI as "price unavailable" instead of being silently valued at zero.
 *
 * Written for held printings only. Recording all ~10,000 unpriced printings
 * would be noise; what matters is the ones a valuation has to account for.
 */
export const unpricedPrintings = sqliteTable(
  "unpriced_printings",
  {
    printingKey: integer("printing_key")
      .notNull()
      .references(() => printings.id, { onDelete: "cascade" }),
    /** Coded, so this joins to holdings and price_snapshots on equal terms. */
    finish: finishCode("finish").notNull(),
    reason: text("reason").notNull(),
    lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.printingKey, t.finish] })],
);

/**
 * MTGJSON's `uuid` to Scryfall `id` map, copied from its `AllPrintings.sqlite`
 * `cardIdentifiers` table.
 *
 * MTGJSON keys its price data on its own uuid, so historical backfill has to
 * join through this to reach a printing. Persisted rather than rebuilt per run
 * so a re-run does not re-download a 243 MB file, and so the join is
 * inspectable after the fact.
 *
 * Deliberately keyed on `scryfall_id` text rather than `printings.id`: this is
 * a verbatim copy of an upstream table, including rows for printings Scryfall's
 * `default_cards` file leaves out. `scryfall_id` is not unique here either —
 * 2,420 of them carry more than one uuid, usually a separate foil and non-foil
 * entry for the same printing.
 */
export const mtgjsonIds = sqliteTable(
  "mtgjson_ids",
  {
    uuid: text("uuid").primaryKey(),
    scryfallId: text("scryfall_id").notNull(),
  },
  (t) => [index("mtgjson_ids_scryfall_idx").on(t.scryfallId)],
);

/**
 * Key/value bookkeeping for the ingest jobs: the Scryfall bulk file's
 * `updated_at`, MTGJSON's build version, and so on. Lets a job skip work when
 * the upstream file has not changed.
 */
export const syncMeta = sqliteTable("sync_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export type Printing = typeof printings.$inferSelect;
export type NewPrinting = typeof printings.$inferInsert;
export type Holding = typeof holdings.$inferSelect;
export type NewHolding = typeof holdings.$inferInsert;
export type PriceSnapshot = typeof priceSnapshots.$inferSelect;
export type NewPriceSnapshot = typeof priceSnapshots.$inferInsert;
