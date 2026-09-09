import "server-only";

import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sql } from "drizzle-orm";

import { DB_PATH, openDatabase } from "@/db/client";
import { printings } from "@/db/schema";
import { ingestScryfallBulk } from "@/ingest/scryfall";

/**
 * The daily price refresh, run inside the app process.
 *
 * Scryfall rebuilds its bulk files once a day, so this matches that cadence
 * rather than polling. A separate scheduler or queue would be more machinery
 * than a single-user, single-container app needs.
 */

/**
 * 10:15 UTC by default. Scryfall's `default_cards` file was built at 09:05 UTC
 * on the day this was written; an hour of slack means a late build is still
 * picked up, and if it is not, the ingest simply finds the same build and
 * skips, then catches it the next day.
 */
const DEFAULT_SCHEDULE = "15 10 * * *";

/**
 * Guards against double registration. Next calls `register` once per server
 * instance, but a dev server can re-evaluate modules on reload, and two live
 * timers would run two ingests over the same database.
 */
const globalForCron = globalThis as unknown as {
  mtgCronStarted?: boolean;
  mtgIngestRunning?: boolean;
};

function log(message: string) {
  console.log(`[cron] ${message}`);
}

/**
 * Applies any pending migrations. Idempotent, and run on every boot so a
 * container started against an older database file upgrades itself rather than
 * failing on a missing column.
 */
export function migrateOnStart() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const sqlite = openDatabase(DB_PATH);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
    log(`database ready at ${DB_PATH}`);
  } finally {
    sqlite.close();
  }
}

/** True when no card data has been ingested yet. */
function isEmpty(): boolean {
  const sqlite = openDatabase(DB_PATH);
  try {
    const row = drizzle(sqlite)
      .select({ n: sql<number>`count(*)` })
      .from(printings)
      .get();
    return (row?.n ?? 0) === 0;
  } finally {
    sqlite.close();
  }
}

/**
 * Runs the Scryfall ingest once.
 *
 * Never throws: a failed refresh must not take the web app down with it, and
 * yesterday's prices are still perfectly usable. The failure is logged and the
 * next scheduled run tries again.
 */
export async function runIngest(reason: string): Promise<void> {
  if (globalForCron.mtgIngestRunning) {
    log(`skipping ${reason}: an ingest is already running`);
    return;
  }
  globalForCron.mtgIngestRunning = true;

  const sqlite = openDatabase(DB_PATH);
  try {
    log(`starting ingest (${reason})`);
    const result = await ingestScryfallBulk(drizzle(sqlite), sqlite, {
      log: (message) => log(message),
    });

    if (result.skipped) {
      log("upstream build unchanged; nothing to do");
    } else {
      log(
        `ingest complete: ${result.printingsUpserted.toLocaleString()} printings, ` +
          `${result.snapshotsWritten.toLocaleString()} prices for ${result.snapshotDate}`,
      );
    }
  } catch (error) {
    // Deliberately swallowed. A price refresh is not worth crashing the server
    // for; the collection still renders from the prices already stored.
    log(`ingest failed: ${(error as Error).message}`);
  } finally {
    sqlite.close();
    globalForCron.mtgIngestRunning = false;
  }
}

/**
 * Starts the daily schedule. Called from `instrumentation.ts`.
 *
 * Disabled in development by default: a 20-second ingest on every dev server
 * start is not what anyone wants. Set `CRON_ENABLED=true` to override, or
 * `false` in production to run the ingest from outside the container instead.
 */
export async function startScheduler(): Promise<void> {
  if (globalForCron.mtgCronStarted) return;
  globalForCron.mtgCronStarted = true;

  migrateOnStart();

  const enabled =
    process.env.CRON_ENABLED === "true" ||
    (process.env.CRON_ENABLED !== "false" &&
      process.env.NODE_ENV === "production");

  if (!enabled) {
    log("scheduler disabled (set CRON_ENABLED=true to run it)");
    return;
  }

  const schedule = process.env.CRON_SCHEDULE ?? DEFAULT_SCHEDULE;
  const timezone = process.env.CRON_TIMEZONE ?? "UTC";

  const { schedule: scheduleTask, validate } = await import("node-cron");
  if (!validate(schedule)) {
    log(`invalid CRON_SCHEDULE "${schedule}"; scheduler not started`);
    return;
  }

  scheduleTask(schedule, () => void runIngest("scheduled"), {
    timezone,
    name: "scryfall-daily",
    // node-cron will not start a run while the previous one is still going.
    // The module-level guard covers the other case: the first-run ingest
    // overlapping with a scheduled one.
    noOverlap: true,
  });
  log(`scheduled daily ingest at "${schedule}" (${timezone})`);

  // A fresh container has no cards at all, so the app would render an empty
  // shell until the first scheduled run. Fill it immediately instead.
  if (isEmpty()) {
    log("no card data yet; running the first ingest now");
    void runIngest("first run");
  }
}
