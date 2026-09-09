import type { Currency, Finish } from "@/db/schema";

const FORMATTERS: Record<Currency, Intl.NumberFormat> = {
  USD: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }),
  // Shown in en-US so the digit grouping matches the rest of the page; the
  // symbol still marks it as euros, which is the part that must not be lost.
  EUR: new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" }),
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

/** e.g. "BLB 280" — how players actually identify a printing. */
export function printingCode(setCode: string, collectorNumber: string): string {
  return `${setCode.toUpperCase()} ${collectorNumber}`;
}

/** "3 days ago" style staleness for a price date, kept deliberately coarse. */
export function daysAgo(isoDate: string, from = new Date()): number {
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  const now = Date.parse(`${from.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((now - then) / 86_400_000);
}
