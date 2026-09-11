/**
 * The closed vocabularies the schema is built from.
 *
 * Split out of `schema.ts` so that `codec.ts` can encode them without importing
 * the tables that are themselves defined in terms of those encodings. Every
 * name here is re-exported from `schema.ts`, which stays the single import site
 * for the rest of the app.
 */

/**
 * Finish of a specific physical card, using Scryfall's own vocabulary so that
 * ingest needs no translation layer: each finish maps directly onto a price
 * field (`prices.usd`, `usd_foil`, `usd_etched`).
 *
 * Note this is `nonfoil`, not `normal` — Scryfall's `finishes` array uses the
 * former. MTGJSON says `normal` and Moxfield's CSV uses an empty string; both
 * are mapped at their own boundary.
 */
export const FINISHES = ["nonfoil", "foil", "etched"] as const;
export type Finish = (typeof FINISHES)[number];

/** The `prices` field on a Scryfall card object that carries each finish. */
export const FINISH_PRICE_FIELD = {
  nonfoil: "usd",
  foil: "usd_foil",
  etched: "usd_etched",
} as const satisfies Record<Finish, string>;

/** Card condition, mapped from Moxfield's CSV export values on import. */
export const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const;
export type Condition = (typeof CONDITIONS)[number];

/**
 * Where a holding came from.
 *
 * A CSV export is a snapshot of an entire collection, so importing one has to
 * reconcile — add what is new, update what changed, remove what is gone. That
 * is only safe if the importer can tell which holdings it owns; hand-added
 * cards must survive an import that does not mention them.
 */
export const HOLDING_SOURCES = ["manual", "moxfield"] as const;
export type HoldingSource = (typeof HOLDING_SOURCES)[number];

/**
 * Vendors whose paper prices are kept.
 *
 * MTGJSON also aggregates Cardmarket and Manapool, and both were stored until
 * the archive backfill made the cost of a vendor concrete — roughly 350 million
 * rows each across five years. Neither survived the trade:
 *
 * - Cardmarket quotes EUR. Nothing in this app converts currency, so its series
 *   can never join a dollar total; it could only ever sit beside one.
 * - Manapool appears only in recent builds, so it cannot contribute the deep
 *   history that is the point of reading an archive at all.
 *
 * Dropping them is what lets `vendor_prices` omit a currency column entirely:
 * every remaining row is USD.
 */
export const VENDORS = ["tcgplayer", "cardkingdom"] as const;
export type Vendor = (typeof VENDORS)[number];

/**
 * Which side of the market a price is.
 *
 * `retail` is what a shop asks; `buylist` is what it pays. A collection is
 * worth the buylist if you actually sell it, which is a different and usually
 * much smaller number than the retail total.
 *
 * Card Kingdom quotes both throughout. TCGplayer's buylist exists only in older
 * MTGJSON builds — present in 2021, absent from current data — so it is a
 * series the archive can supply and live ingest cannot.
 */
export const MARKET_SIDES = ["retail", "buylist"] as const;
export type MarketSide = (typeof MARKET_SIDES)[number];

/**
 * Currencies the app can display.
 *
 * Only USD, and no longer a stored column. It was one while Cardmarket's euro
 * series was kept, purely so a EUR figure could not be summed into a dollar
 * total; with that vendor dropped every price in the database is dollars and
 * the per-row column was 350 million copies of the same three bytes. The type
 * survives because formatting money still needs to name a currency.
 */
export const CURRENCIES = ["USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Where a price snapshot came from. Used to reason about continuity. */
export const PRICE_SOURCES = ["scryfall", "mtgjson", "manual"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];
