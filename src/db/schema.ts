import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Finish of a specific physical card. Scryfall reports prices per finish
 * (`prices.usd` vs `prices.usd_foil`), so finish is part of the identity of a
 * price, not a property of a holding alone.
 *
 * `etched` is carried because Scryfall lists it in `finishes`, but v1 has no
 * price source for it (Scryfall exposes `usd_etched` only sometimes) — treat
 * etched holdings as "price unavailable" until that is handled.
 */
export const FINISHES = ["normal", "foil", "etched"] as const;
export type Finish = (typeof FINISHES)[number];

/** Card condition, mapped from Moxfield's CSV export values on import. */
export const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const;
export type Condition = (typeof CONDITIONS)[number];

/** Where a price snapshot came from. Used to reason about continuity. */
export const PRICE_SOURCES = ["scryfall", "mtgjson", "manual"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/**
 * One row per Scryfall printing. Prices vary by printing, so `scryfallId` — not
 * `oracleId` — is the identity used everywhere else in the schema.
 */
export const printings = sqliteTable(
  "printings",
  {
    /** Scryfall `id`. */
    scryfallId: text("scryfall_id").primaryKey(),
    /** Scryfall `oracle_id`. Groups printings of the same card; never a price key. */
    oracleId: text("oracle_id").notNull(),
    name: text("name").notNull(),
    setCode: text("set_code").notNull(),
    setName: text("set_name").notNull(),
    collectorNumber: text("collector_number").notNull(),
    /** Scryfall `image_uris.normal`. Null for cards whose images are per-face. */
    imageUri: text("image_uri"),
    /** Scryfall `finishes`, as a JSON array of {@link Finish}. */
    finishes: text("finishes", { mode: "json" })
      .$type<Finish[]>()
      .notNull()
      .default(sql`'["normal"]'`),
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
    printingId: text("printing_id")
      .notNull()
      .references(() => printings.scryfallId, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    finish: text("finish").$type<Finish>().notNull(),
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
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("holdings_printing_idx").on(t.printingId),
    // The valuation query walks holdings by date_added.
    index("holdings_date_added_idx").on(t.dateAdded),
  ],
);

/**
 * Daily price per printing and finish. The unique index over
 * (printing, finish, date) is what makes ingestion idempotent and enforces the
 * "never re-fetch a price already stored for that day" rule.
 */
export const priceSnapshots = sqliteTable(
  "price_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    printingId: text("printing_id")
      .notNull()
      .references(() => printings.scryfallId, { onDelete: "cascade" }),
    finish: text("finish").$type<Finish>().notNull(),
    /** `YYYY-MM-DD`, UTC. */
    date: text("date").notNull(),
    /**
     * USD in whole cents. Integer rather than float so that summing a whole
     * collection is exact.
     */
    priceCents: integer("price_cents").notNull(),
    source: text("source").$type<PriceSource>().notNull(),
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
    uniqueIndex("price_snapshots_unique_idx").on(
      t.printingId,
      t.finish,
      t.date,
    ),
    // Serves both the single-card history chart and the per-date portfolio
    // valuation lookup.
    index("price_snapshots_date_idx").on(t.date),
  ],
);

/**
 * Printings with no usable price from any source, so they can be surfaced in
 * the UI as "price unavailable" instead of being silently valued at zero.
 */
export const unpricedPrintings = sqliteTable("unpriced_printings", {
  printingId: text("printing_id")
    .primaryKey()
    .references(() => printings.scryfallId, { onDelete: "cascade" }),
  finish: text("finish").$type<Finish>().notNull(),
  reason: text("reason").notNull(),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }).notNull(),
});

/**
 * Key/value bookkeeping for the ingest jobs: the Scryfall bulk file's
 * `updated_at`, MTGJSON's `Meta.json` build date, last successful run, etc.
 * Lets a job skip work when the upstream file has not changed.
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
