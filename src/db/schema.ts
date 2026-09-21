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

// Re-exported by name rather than with `export *`. The `.mts` ingest modules
// are ESM importing this CommonJS one, and Node detects a CJS module's named
// exports by static analysis that does not follow star re-exports: the star
// form type-checks and passes the CJS-only tests, then fails at runtime with
// "does not provide an export named 'MARKET_SIDES'".
export {
  CONDITIONS,
  CURRENCIES,
  FINISH_PRICE_FIELD,
  FINISHES,
  HOLDING_SOURCES,
  MARKET_SIDES,
  PRICE_SOURCES,
  VENDORS,
} from "./schema-enums";
export type {
  Condition,
  Currency,
  Finish,
  HoldingSource,
  MarketSide,
  PriceSource,
  Vendor,
} from "./schema-enums";

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
    /**
     * Scryfall `image_uris.large`, for the zoomed view.
     *
     * Stored rather than derived from `imageUri`. The URLs differ only in a
     * path segment today, but Scryfall documents image URIs as opaque and
     * reserves the right to change them, and the variants already disagree on
     * file extension (`png` is `.png`, the newer sizes are `.webp`). Null until
     * the next metadata ingest, so readers must fall back to `imageUri`.
     */
    imageUriLarge: text("image_uri_large"),
    /**
     * The reverse of a double-faced card, when there is one.
     *
     * Scryfall gives multi-faced layouts no top-level `image_uris` and one
     * entry per face instead. Only the front was ever stored, so a transform
     * or modal card could not be turned over.
     */
    /**
     * The set's release date, `YYYY-MM-DD`, straight from Scryfall.
     *
     * Stored per printing rather than in a sets table: a printing is the only
     * thing this app has, and the date is what turns "BLB 280" into something
     * a reader can place in time.
     */
    releasedAt: text("released_at"),
    imageUriBack: text("image_uri_back"),
    imageUriBackLarge: text("image_uri_back_large"),
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
/**
 * The scope value standing for the host's own collection.
 *
 * A sentinel rather than NULL so that every scope comparison is an equality
 * and a primary key containing it behaves. Empty because no generated session
 * id can collide with it.
 */
export const OWNER_SCOPE = "";

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
     * True when `dateAdded` means "on or before", not "on".
     *
     * Moxfield's CSV carries only a last-modified timestamp, which moves
     * forward whenever a row is touched and says nothing about when a card was
     * acquired. Against a real export, 673 of 3,724 holdings land on the two
     * days the collection was bulk-loaded into Moxfield — cards owned for years
     * before, all dated to the day they were first typed in.
     *
     * Rows at the export's earliest date are flagged here, because that date is
     * provably a floor rather than a fact: nothing in the file can be older, so
     * anything sitting on it was acquired then or earlier, unknowably.
     */
    dateAddedApprox: integer("date_added_approx", { mode: "boolean" })
      .notNull()
      .default(false),
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
    /**
     * Which collection this row belongs to. `OWNER_SCOPE` is the host's own.
     *
     * The empty string is the collection a self-hosted instance imports and
     * the daily job prices — the one this app was built around. Any other
     * value is somebody else's file, uploaded to look at once: it belongs to a
     * browser rather than a person, there is no account behind it, and a sweep
     * deletes it after its time is up.
     *
     * One table rather than two, because every valuation and statistics query
     * already joins holdings to the price tables and would otherwise need a
     * second copy of itself. The scope is one extra predicate, applied in
     * `collectionWhere`, and no query can see rows outside its scope.
     *
     * Not null, and not a foreign key. SQLite permits NULLs in a PRIMARY KEY,
     * so a nullable scope column on the cache tables below would let the
     * owner's rows duplicate silently; the same shape is used here so both
     * read the same way. Deleting a session deletes its rows explicitly, which
     * has to be reliable rather than implied — see `deleteSession`.
     */
    sessionId: text("session_id").notNull().default(OWNER_SCOPE),
  },
  (t) => [
    index("holdings_printing_idx").on(t.printingKey),
    // The importer reconciles against its own rows only.
    index("holdings_source_idx").on(t.source),
    // The valuation query walks holdings by date_added.
    index("holdings_date_added_idx").on(t.dateAdded),
    // Every read is scoped to one collection, so this leads most queries.
    index("holdings_session_idx").on(t.sessionId),
  ],
);

/**
 * An uploaded collection, for as long as one browser is looking at it.
 *
 * There are no accounts here and nothing is kept: a visitor uploads a file,
 * gets an opaque id in a cookie, and both the id and the rows it points at are
 * swept away on a timer. The row exists to carry what the dashboard needs to
 * describe the upload — where it came from and how big it was — and to give
 * the sweep and the cascade something to hang off.
 */
export const collectionSessions = sqliteTable(
  "collection_sessions",
  {
    /** Opaque, 128 bits of randomness. Never derived from anything.  */
    id: text("id").primaryKey(),
    /** What the reader called it: a file name, or a deck's title. */
    label: text("label").notNull(),
    /** How it arrived, for the dashboard's provenance line. */
    source: text("source").$type<SessionSource>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    /** Touched on every read, so an open tab is not swept out from under it. */
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }).notNull(),
    /** Rows that resolved to a printing, and rows the file named but we could not. */
    matched: integer("matched").notNull(),
    unmatched: integer("unmatched").notNull(),
    /**
     * How far the out-of-process pricing has got.
     *
     * Valuing a collection over five years of prices takes seconds — nearly
     * nine for a large one — and better-sqlite3 is synchronous, so doing it
     * inside the upload request froze the whole site for everybody. It runs as
     * a child process instead, and this is how the page knows whether to show
     * a dashboard, a wait, or an apology.
     *
     * Defaults to `ready` so that anything created outside that flow — a test,
     * a fixture — is simply usable.
     */
    warmState: text("warm_state").$type<WarmState>().notNull().default("ready"),
    /** Why it failed, for the reader. Null unless `warmState` is `failed`. */
    warmError: text("warm_error"),
  },
  (t) => [index("collection_sessions_last_seen_idx").on(t.lastSeenAt)],
);

export const WARM_STATES = ["pending", "ready", "failed"] as const;
export type WarmState = (typeof WARM_STATES)[number];

export const SESSION_SOURCES = ["csv", "decklist", "url"] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

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
 * Precomputed portfolio totals, one row per date per view.
 *
 * The value series depends only on the holdings and the price history, both of
 * which change about once a day — yet it was recomputed on every page load,
 * walking a holdings-by-dates matrix each time. That cost 230ms over 89 days
 * and 5.6 seconds over 930, and the archive backfill is still adding dates.
 *
 * Keyed by view as well as date because there are four of them: two price
 * sources times as-held and constant-basket. That is ~8,000 rows against a
 * matrix of several million cells, so the whole cache is smaller than one
 * request used to allocate.
 *
 * A cache that can go stale silently is worse than no cache, so the reader
 * compares a fingerprint of the inputs and recomputes when it does not match.
 * See `portfolio-cache.ts`.
 */
export const portfolioDaily = sqliteTable(
  "portfolio_daily",
  {
    /** Vendor code; see `codec.ts`. */
    priceSource: integer("price_source").notNull(),
    /** 1 for the constant-basket view, 0 for as-held. */
    basket: integer("basket", { mode: "boolean" }).notNull(),
    date: text("date").notNull(),
    valueCents: integer("value_cents").notNull(),
    holdingsHeld: integer("holdings_held").notNull(),
    pricedHoldings: integer("priced_holdings").notNull(),
    unpricedHoldings: integer("unpriced_holdings").notNull(),
    inferredHoldings: integer("inferred_holdings").notNull(),
    acquiredHoldings: integer("acquired_holdings").notNull(),
    acquiredCards: integer("acquired_cards").notNull(),
    /** The collection this row was computed for; see `holdings.sessionId`. */
    sessionId: text("session_id").notNull().default(OWNER_SCOPE),
  },
  (t) => [
    primaryKey({ columns: [t.priceSource, t.basket, t.date, t.sessionId] }),
  ],
);

/**
 * Month-to-month links for the like-for-like index, cached alongside the daily
 * totals and rebuilt by the same pass.
 *
 * Separate from `portfolio_daily` rather than another column on it: this is one
 * row per month, not per day, and only for the basket view. Folding it in would
 * leave the column null on 98% of rows.
 *
 * Each row holds the common basket's value at both ends of the step — the
 * holdings priced on both dates — which is what makes a move mean prices
 * changed rather than the collection having grown into existence.
 */
export const portfolioMonthly = sqliteTable(
  "portfolio_monthly",
  {
    /** Vendor code; see `codec.ts`. */
    priceSource: integer("price_source").notNull(),
    /** The later month of the step, `YYYY-MM`. */
    month: text("month").notNull(),
    /** The priced dates the step runs between. */
    date: text("date").notNull(),
    prevDate: text("prev_date").notNull(),
    fromCents: integer("from_cents").notNull(),
    toCents: integer("to_cents").notNull(),
    compared: integer("compared").notNull(),
    excluded: integer("excluded").notNull(),
    /** The collection this row was computed for; see `holdings.sessionId`. */
    sessionId: text("session_id").notNull().default(OWNER_SCOPE),
  },
  (t) => [primaryKey({ columns: [t.priceSource, t.month, t.sessionId] })],
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
export type CollectionSession = typeof collectionSessions.$inferSelect;
export type NewCollectionSession = typeof collectionSessions.$inferInsert;
export type Holding = typeof holdings.$inferSelect;
export type NewHolding = typeof holdings.$inferInsert;
export type PriceSnapshot = typeof priceSnapshots.$inferSelect;
export type NewPriceSnapshot = typeof priceSnapshots.$inferInsert;
