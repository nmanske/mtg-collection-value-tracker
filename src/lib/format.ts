import type { Finish } from "@/db/schema";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** Formats whole cents as USD. Prices are stored as integers; only display divides. */
export function formatUsd(cents: number): string {
  return USD.format(cents / 100);
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
