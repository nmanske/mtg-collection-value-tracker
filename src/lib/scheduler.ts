import "server-only";

import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sql } from "drizzle-orm";

import { DB_PATH, openDatabase } from "@/db/client";
import { printings } from "@/db/schema";
import { ingestScryfallBulk } from "@/ingest/scryfall";
import { recordDailyRun, runDailyPriceIngest } from "@/lib/daily-ingest";

/**
 * The daily refresh: Scryfall card metadata, then MTGJSON prices.
 *
 * Both upstreams rebuild once a day, so this matches that cadence rather than
 * polling. A separate scheduler or queue would be more machinery than a
 * single-user, single-container app needs.
 *
 * The schedule lives in this process; the price ingest does not — it is spawned
 * as a child. See `@/lib/daily-ingest`. Metadata stays in-process because it is
 * a plain upsert with no ESM-only dependencies, and it is the step a first run
 * cannot start without.
 */

/**
 * 04:30 in `DEFAULT_TIMEZONE` — an hour nobody is looking at the site, so the
 * ingest has the write lock to itself.
 *
 * A named zone rather than a fixed UTC offset, so the run stays at 04:30 local
 * across daylight saving rather than drifting an hour twice a year. Node ships
 * full ICU, so the zone resolves without a tzdata package in the image.
 *
 * The trade-off is upstream timing. Scryfall's `default_cards` was built at
 * 09:05 UTC on the day this was written, which leaves about 90 minutes of slack
 * under CST and only 25 under CDT. If a build is late the ingest finds the
 * previous one, skips, and catches it the next day; the dashboard only reports
 * a problem once prices are two days behind. Worth knowing, not worth moving
 * the schedule for.
 *
 * MTGJSON rebuilds `AllPricesToday` daily too, and the price job skips when the
 * build version is one already recorded, so a run that lands between the two
 * upstream builds costs nothing beyond a wasted download.
 */
const DEFAULT_SCHEDULE = "30 4 * * *";

/** US Central, which handles CST and CDT without the schedule moving. */
const DEFAULT_TIMEZONE = "America/Chicago";

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
 * Runs the daily refresh once: Scryfall metadata, then MTGJSON prices.
 *
 * Never throws: a failed refresh must not take the web app down with it, and
 * yesterday's prices are still perfectly usable. The failure is logged, written
 * to `sync_meta` so the dashboard can say so, and retried on the next tick.
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
    const db = drizzle(sqlite);

    // Metadata first, and prices second, because a price can only be recorded
    // against a printing that already exists. On release day the order is the
    // difference between a new set being priced and being silently skipped.
    const metadata = await ingestScryfallBulk(db, sqlite, {
      log: (message) => log(message),
    });
    log(
      metadata.skipped
        ? "metadata: upstream build unchanged"
        : `metadata: ${metadata.printingsUpserted.toLocaleString()} printings`,
    );

    // Prices run as a child process rather than an import. See the comment on
    // `runDailyPriceIngest` for why — briefly, the ingest is ESM-only in a way
    // Turbopack cannot bundle, and a 50 MB parse does not belong in the server
    // process regardless.
    const run = await runDailyPriceIngest(reason, { log: (m) => log(m) });
    if (run) {
      // Recorded before it is judged, so a failure leaves a trace. Losing a day
      // silently is the failure this whole job exists to prevent.
      recordDailyRun(db, run);
      log(
        run.ok
          ? `prices: done in ${run.seconds.toFixed(1)}s`
          : `prices: FAILED after ${run.seconds.toFixed(1)}s — ${run.message}`,
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
  const timezone = process.env.CRON_TIMEZONE ?? DEFAULT_TIMEZONE;

  const { schedule: scheduleTask, validate } = await import("node-cron");
  if (!validate(schedule)) {
    log(`invalid CRON_SCHEDULE "${schedule}"; scheduler not started`);
    return;
  }

  // An unrecognised timezone throws from here. Caught, because this runs inside
  // the instrumentation hook: an unhandled throw stops the whole server
  // booting, and a mistyped zone should cost the schedule, not the site.
  try {
    scheduleTask(schedule, () => void runIngest("scheduled"), {
      timezone,
      name: "daily-refresh",
      // node-cron will not start a run while the previous one is still going.
      // The module-level guard covers the other case: the first-run ingest
      // overlapping with a scheduled one.
      noOverlap: true,
    });
    log(`scheduled daily ingest at "${schedule}" (${timezone})`);
  } catch (error) {
    log(
      `could not schedule with timezone "${timezone}": ${(error as Error).message}`,
    );
    return;
  }

  // A fresh container has no cards at all, so the app would render an empty
  // shell until the first scheduled run. Fill it immediately instead.
  if (isEmpty()) {
    log("no card data yet; running the first ingest now");
    void runIngest("first run");
  }
}
