import type { Currency, Finish } from "@/db/schema";

const FORMATTERS: Record<Currency, Intl.NumberFormat> = {
  USD: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }),
};

/** Formats whole cents as USD. Prices are stored as integers; only display divides. */
export function formatUsd(cents: number): string {
  return FORMATTERS.USD.format(cents / 100);
}

/**
 * Formats whole minor units in a given currency.
 *
 * Cardmarket quotes euros. Nothing in this app converts between currencies, so
 * the symbol is the only thing stopping a euro figure being read as dollars.
 */
export function formatMoney(cents: number, currency: Currency): string {
  return FORMATTERS[currency].format(cents / 100);
}

export const FINISH_LABEL: Record<Finish, string> = {
  nonfoil: "Non-foil",
  foil: "Foil",
  etched: "Etched",
};

/**
 * e.g. "BLB #280 (2024)" — how players actually identify a printing.
 *
 * The hash marks the collector number as a number rather than a second part of
 * the set code, which matters where the two sit side by side.
 */
export function printingCode(
  setCode: string,
  collectorNumber: string,
  /** The set's release date, `YYYY-MM-DD`. Omitted before a metadata ingest. */
  releasedAt?: string | null,
): string {
  const base = `${setCode.toUpperCase()} #${collectorNumber}`;
  const year = releaseYear(releasedAt);
  return year ? `${base} (${year})` : base;
}

/**
 * The year a set came out, or null.
 *
 * A set code says nothing about when a card was printed unless you already
 * know the code, which is most of the value of showing it.
 */
export function releaseYear(releasedAt?: string | null): string | null {
  if (!releasedAt) return null;
  const year = releasedAt.slice(0, 4);
  return /^\d{4}$/.test(year) ? year : null;
}

/** "3 days ago" style staleness for a price date, kept deliberately coarse. */
export function daysAgo(isoDate: string, from = new Date()): number {
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  const now = Date.parse(`${from.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((now - then) / 86_400_000);
}
