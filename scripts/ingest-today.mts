/**
 * Records today's prices from MTGJSON's `AllPricesToday`.
 *
 *   npm run ingest:today -- [--force] [--dry-run] [--rebuild-cache]
 *
 * This is what the daily cron runs, alongside the Scryfall metadata refresh.
 *
 * `--rebuild-cache` recomputes the portfolio totals afterwards. The scheduler
 * passes it, because any ingest invalidates the cache and the first visitor
 * each morning would otherwise pay a multi-second recompute. It is not done in
 * the server process on purpose: the rebuild is synchronous and would block
 * request handling for as long as it takes.
 */
import { drizzle } from "drizzle-orm/better-sqlite3";

import { DB_PATH, openDatabase } from "@/db/client";
import { rebuildPortfolioCache } from "@/db/queries/portfolio-cache";
import { hasIdentifierMap, ingestMtgjsonToday } from "@/ingest/mtgjson-today.mjs";

const args = process.argv.slice(2);
const sqlite = openDatabase(DB_PATH);
// The rebuild reads while the web app may be writing nothing but still holds
// readers open; the default 5s is not enough margin for a table this size.
sqlite.pragma("busy_timeout = 120000");

try {
  const db = drizzle(sqlite);
  if (!hasIdentifierMap(db)) {
    throw new Error(
      "No MTGJSON uuid map yet. Run `npm run backfill:mtgjson` once to build it.",
    );
  }

  const result = await ingestMtgjsonToday(db, sqlite, {
    force: args.includes("--force"),
    dryRun: args.includes("--dry-run"),
    log: (message) => console.log(message),
  });

  if (!result.skipped) {
    console.log("");
    console.table({
      "mtgjson build": `${result.version} (${result.date})`,
      "uuids seen": result.uuidsSeen.toLocaleString(),
      "uuids not tracked": result.uuidsUnmapped.toLocaleString(),
      "snapshots inserted": result.snapshotsInserted.toLocaleString(),
      "vendor rows written": result.vendorRowsWritten.toLocaleString(),
      elapsed: `${result.seconds.toFixed(1)}s`,
    });
  }

  // Skipped after a dry run — there is nothing new to reflect — and after a
  // no-op, where the cache is already consistent with what is stored.
  if (
    args.includes("--rebuild-cache") &&
    !result.skipped &&
    !args.includes("--dry-run")
  ) {
    console.log("\nRebuilding the portfolio cache...");
    const cache = rebuildPortfolioCache(db, (message) => console.log(message));
    console.log(
      `${cache.views} views, ${cache.points.toLocaleString()} points, ${cache.seconds.toFixed(1)}s`,
    );
  }
} catch (error) {
  console.error(`Daily ingest failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  sqlite.close();
}
