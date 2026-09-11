/**
 * Records today's prices from MTGJSON's `AllPricesToday`.
 *
 *   npm run ingest:today -- [--force] [--dry-run]
 *
 * This is what the daily cron runs, alongside the Scryfall metadata refresh.
 */
import { drizzle } from "drizzle-orm/better-sqlite3";

import { DB_PATH, openDatabase } from "@/db/client";
import { hasIdentifierMap, ingestMtgjsonToday } from "@/ingest/mtgjson-today.mjs";

const args = process.argv.slice(2);
const sqlite = openDatabase(DB_PATH);

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
} catch (error) {
  console.error(`Daily ingest failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  sqlite.close();
}
