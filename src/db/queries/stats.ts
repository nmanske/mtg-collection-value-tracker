import type { Db } from "./printings";

/**
 * Collection statistics.
 *
 * Every figure here comes from one pass: a single query returns one row per
 * holding with its card details, its first and latest tracked price, and Card
 * Kingdom's two sides, and the rankings are then done in memory. A collection
 * is a few thousand rows, so ranking it in JavaScript is far cheaper than
 * asking SQLite the same correlated question once per statistic — the first
 * version of this file did that and took 638ms.
 *
 * Two rules shape what is shown:
 *
 * - Percentage movers need a price floor. A card going from $0.02 to $0.06 is
 *   +200% and means nothing; without a floor the movers list is entirely penny
 *   commons rounding around.
 * - Every mover shows both prices and the date it was first seen, so the
 *   reader can judge the number rather than trust it.
 */

/** Below this, a percentage move is noise rather than news. */
const MOVER_FLOOR_CENTS = 100;

/**
 * Buylist spreads are only meaningful on cards worth selling.
 *
 * Card Kingdom buys in tiers with a floor around $0.65, so below roughly $20
 * the worst-spread list is dozens of unrelated cards all showing the identical
 * "$0.65 of $3.49, 19%" — the floor divided by a common price point, which
 * says nothing about the card. Above it the ratios actually differ.
 */
export const SPREAD_FLOOR_CENTS = 2_000;

export interface CardRef {
  name: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  scryfallId: string;
  finish: string;
  imageUri: string | null;
  quantity: number;
}

export interface ValuedCard extends CardRef {
  priceCents: number;
}

export interface Mover extends CardRef {
  fromCents: number;
  toCents: number;
  fromDate: string;
  changeCents: number;
  changeRatio: number;
  /** Change times quantity: what it did to the collection, not to the card. */
  impactCents: number;
}

export interface Spread extends CardRef {
  retailCents: number;
  buylistCents: number;
  ratio: number;
}

export interface SetTotal {
  setCode: string;
  setName: string;
  holdings: number;
  valueCents: number;
}

export interface MonthCount {
  month: string;
  holdings: number;
  cards: number;
}

export interface CollectionStats {
  totalValueCents: number;
  totalCards: number;
  totalHoldings: number;
  distinctPrintings: number;
  distinctSets: number;
  /** Median unit price — the typical card, which a mean would badly overstate. */
  medianCardCents: number;
  /** How few holdings carry half the value. */
  holdingsForHalfValue: number;
  underOneDollar: number;
  underOneDollarShare: number;
  topTenShare: number;

  mostValuable: ValuedCard[];
  cheapest: ValuedCard | null;
  mostCopies: { name: string; scryfallId: string; quantity: number }[];

  gainers: Mover[];
  losers: Mover[];
  /** Ranked by effect on the collection rather than by percentage. */
  biggestGains: Mover[];
  biggestLosses: Mover[];

  topSets: SetTotal[];
  finishSplit: { finish: string; holdings: number; valueCents: number }[];
  acquisitions: MonthCount[];
  firstAcquired: string | null;
  lastAcquired: string | null;

  /** Card Kingdom is the only vendor publishing a buylist. */
  buylistTotalCents: number;
  buylistRetailCents: number;
  buylistCoverage: number;
  bestSpreads: Spread[];
  worstSpreads: Spread[];
}

interface Row extends CardRef {
  oracleId: string;
  dateAdded: string;
  overrideCents: number | null;
  lastCents: number | null;
  firstCents: number | null;
  firstDate: string | null;
  ckRetail: number | null;
  ckBuylist: number | null;
}

function client(db: Db) {
  return (db as unknown as { $client: import("better-sqlite3").Database })
    .$client;
}

/** Descending by a key, then the first `count`. */
function top<T>(rows: T[], score: (row: T) => number, count: number): T[] {
  return [...rows].sort((a, b) => score(b) - score(a)).slice(0, count);
}

export function collectionStats(db: Db): CollectionStats {
  const rows = client(db)
    .prepare(
      `select p.name, p.set_code as setCode, p.set_name as setName,
              p.collector_number as collectorNumber, p.scryfall_id as scryfallId,
              p.oracle_id as oracleId, p.image_uri as imageUri,
              h.finish, h.quantity, h.date_added as dateAdded,
              h.price_override_cents as overrideCents,
              (select price_cents from price_snapshots s
                where s.printing_key = h.printing_key and s.finish = h.finish
                order by s.date desc limit 1) as lastCents,
              (select price_cents from price_snapshots s
                where s.printing_key = h.printing_key and s.finish = h.finish
                order by s.date asc limit 1) as firstCents,
              (select s.date from price_snapshots s
                where s.printing_key = h.printing_key and s.finish = h.finish
                order by s.date asc limit 1) as firstDate,
              (select price_cents from vendor_prices v
                where v.printing_key = h.printing_key and v.finish = h.finish
                  and v.vendor = 'cardkingdom' and v.side = 'retail'
                order by v.date desc limit 1) as ckRetail,
              (select price_cents from vendor_prices v
                where v.printing_key = h.printing_key and v.finish = h.finish
                  and v.vendor = 'cardkingdom' and v.side = 'buylist'
                order by v.date desc limit 1) as ckBuylist
         from holdings h join printings p on p.id = h.printing_key`,
    )
    .all() as Row[];

  const unit = (row: Row) => row.overrideCents ?? row.lastCents;
  const priced = rows.filter((row) => unit(row) != null);

  const lineValues = priced
    .map((row) => unit(row)! * row.quantity)
    .sort((a, b) => b - a);
  const totalValueCents = lineValues.reduce((sum, value) => sum + value, 0);

  let running = 0;
  let holdingsForHalfValue = 0;
  for (const value of lineValues) {
    running += value;
    holdingsForHalfValue += 1;
    if (running >= totalValueCents / 2) break;
  }

  const unitValues = priced.map((row) => unit(row)!).sort((a, b) => a - b);
  const cheapValues = lineValues.filter((value) => value < 100);
  const topTen = lineValues.slice(0, 10).reduce((sum, value) => sum + value, 0);

  const asCard = (row: Row): CardRef => ({
    name: row.name,
    setCode: row.setCode,
    setName: row.setName,
    collectorNumber: row.collectorNumber,
    scryfallId: row.scryfallId,
    finish: row.finish,
    imageUri: row.imageUri,
    quantity: row.quantity,
  });

  // Movers: a real earlier price above the floor, and a current one.
  const movers: Mover[] = rows
    .filter(
      (row) =>
        row.firstCents != null &&
        row.lastCents != null &&
        row.firstDate != null &&
        row.firstCents >= MOVER_FLOOR_CENTS,
    )
    .map((row) => {
      const from = row.firstCents!;
      const to = row.lastCents!;
      return {
        ...asCard(row),
        fromCents: from,
        toCents: to,
        fromDate: row.firstDate!,
        changeCents: to - from,
        changeRatio: to / from - 1,
        impactCents: (to - from) * row.quantity,
      };
    });

  const copies = new Map<string, { name: string; scryfallId: string; quantity: number }>();
  for (const row of rows) {
    // Grouped by oracle id, so every printing of Sol Ring counts as Sol Ring.
    const existing = copies.get(row.oracleId);
    if (existing) existing.quantity += row.quantity;
    else
      copies.set(row.oracleId, {
        name: row.name,
        scryfallId: row.scryfallId,
        quantity: row.quantity,
      });
  }

  const sets = new Map<string, SetTotal>();
  for (const row of priced) {
    const entry = sets.get(row.setCode) ?? {
      setCode: row.setCode,
      setName: row.setName,
      holdings: 0,
      valueCents: 0,
    };
    entry.holdings += 1;
    entry.valueCents += unit(row)! * row.quantity;
    sets.set(row.setCode, entry);
  }

  const finishes = new Map<string, { finish: string; holdings: number; valueCents: number }>();
  for (const row of rows) {
    const entry = finishes.get(row.finish) ?? {
      finish: row.finish,
      holdings: 0,
      valueCents: 0,
    };
    entry.holdings += 1;
    entry.valueCents += (unit(row) ?? 0) * row.quantity;
    finishes.set(row.finish, entry);
  }

  const months = new Map<string, MonthCount>();
  for (const row of rows) {
    const month = row.dateAdded.slice(0, 7);
    const entry = months.get(month) ?? { month, holdings: 0, cards: 0 };
    entry.holdings += 1;
    entry.cards += row.quantity;
    months.set(month, entry);
  }
  const dates = rows.map((row) => row.dateAdded).sort();

  // Both sides of the buylist total span only the holdings Card Kingdom quotes
  // on both, so the ratio compares like with like.
  const quoted = rows.filter(
    (row) => row.ckBuylist != null && row.ckRetail != null,
  );
  const buylistTotalCents = quoted.reduce(
    (sum, row) => sum + row.ckBuylist! * row.quantity,
    0,
  );
  const buylistRetailCents = quoted.reduce(
    (sum, row) => sum + row.ckRetail! * row.quantity,
    0,
  );

  const spreads: Spread[] = quoted
    .filter((row) => row.ckRetail! >= SPREAD_FLOOR_CENTS)
    .map((row) => ({
      ...asCard(row),
      retailCents: row.ckRetail!,
      buylistCents: row.ckBuylist!,
      ratio: row.ckBuylist! / row.ckRetail!,
    }));

  return {
    totalValueCents,
    totalCards: rows.reduce((sum, row) => sum + row.quantity, 0),
    totalHoldings: rows.length,
    distinctPrintings: new Set(rows.map((row) => row.scryfallId)).size,
    distinctSets: new Set(rows.map((row) => row.setCode)).size,
    medianCardCents: unitValues[Math.floor(unitValues.length / 2)] ?? 0,
    holdingsForHalfValue,
    underOneDollar: cheapValues.length,
    underOneDollarShare:
      totalValueCents > 0
        ? cheapValues.reduce((sum, value) => sum + value, 0) / totalValueCents
        : 0,
    topTenShare: totalValueCents > 0 ? topTen / totalValueCents : 0,

    mostValuable: top(priced, (row) => unit(row)!, 6).map((row) => ({
      ...asCard(row),
      priceCents: unit(row)!,
    })),
    cheapest: (() => {
      const row = [...priced].sort((a, b) => unit(a)! - unit(b)!)[0];
      return row ? { ...asCard(row), priceCents: unit(row)! } : null;
    })(),
    mostCopies: top([...copies.values()], (row) => row.quantity, 6),

    gainers: top(movers, (row) => row.changeRatio, 5),
    losers: top(movers, (row) => -row.changeRatio, 5),
    biggestGains: top(movers, (row) => row.impactCents, 5).filter(
      (row) => row.impactCents > 0,
    ),
    biggestLosses: top(movers, (row) => -row.impactCents, 5).filter(
      (row) => row.impactCents < 0,
    ),

    topSets: top([...sets.values()], (set) => set.valueCents, 8),
    finishSplit: [...finishes.values()].sort(
      (a, b) => b.valueCents - a.valueCents,
    ),
    acquisitions: [...months.values()].sort((a, b) =>
      a.month.localeCompare(b.month),
    ),
    firstAcquired: dates[0] ?? null,
    lastAcquired: dates[dates.length - 1] ?? null,

    buylistTotalCents,
    buylistRetailCents,
    buylistCoverage: rows.length > 0 ? quoted.length / rows.length : 0,
    // Ties are broken by retail price, not left to insertion order. Card
    // Kingdom has a floor buy price, so dozens of cards share the same ratio
    // at the bottom; without a tiebreak the panel lists five identical
    // percentages and says nothing. Sorted this way it surfaces the expensive
    // cards with a poor spread, which is the interesting case.
    bestSpreads: [...spreads]
      .sort((a, b) => b.ratio - a.ratio || b.retailCents - a.retailCents)
      .slice(0, 5),
    worstSpreads: [...spreads]
      .sort((a, b) => a.ratio - b.ratio || b.retailCents - a.retailCents)
      .slice(0, 5),
  };
}
