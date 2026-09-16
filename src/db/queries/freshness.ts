import "server-only";

import { sql } from "drizzle-orm";

import type { Db } from "./printings";
import { lastDailyRun, type DailyRunRecord } from "@/lib/daily-ingest";

/**
 * How healthy the daily price job is.
 *
 * This exists because of a specific failure: the job was a manual CLI step, it
 * was not run on 2026-09-10, and nobody noticed for five days. Nothing on the
 * site looked wrong — a chart missing its newest point looks exactly like a
 * chart. MTGJSON's price window is only ~90 days deep, so a day unnoticed for
 * three months is a day lost permanently.
 */

/**
 * Two days, not one. MTGJSON builds daily but not at a fixed hour, and the
 * scheduled run can land before the day's build; one late build is normal
 * operation and a banner that cries wolf gets ignored precisely when it is
 * right.
 */
export const PRICES_STALE_AFTER_DAYS = 2;

export interface PriceFreshness {
  /** Newest date in the canonical series, or null if there are no prices. */
  newestDate: string | null;
  /** Whole days between `newestDate` and today, UTC. */
  daysBehind: number | null;
  stale: boolean;
  /** The last automated run, successful or failed; null if it never ran. */
  lastRun: DailyRunRecord | null;
}

export function priceFreshness(db: Db): PriceFreshness {
  // `price_snapshots` alone: it holds TCGplayer retail, the series the
  // portfolio is actually valued from. Card Kingdom lagging is worth knowing
  // but is not the collection going stale.
  const row = db.get<{ newest: string | null }>(
    sql`select max(date) as newest from price_snapshots`,
  );
  const newestDate = row?.newest ?? null;

  const daysBehind =
    newestDate === null
      ? null
      : Math.floor(
          (Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) -
            Date.parse(`${newestDate}T00:00:00Z`)) /
            86_400_000,
        );

  return {
    newestDate,
    daysBehind,
    stale: daysBehind !== null && daysBehind > PRICES_STALE_AFTER_DAYS,
    lastRun: lastDailyRun(db),
  };
}
