/**
 * Pulls Scryfall's `default_cards` bulk file: refreshes printing metadata and
 * writes one day of price snapshots. This is the job the daily cron will run.
 *
 *   npm run ingest:scryfall -- [--force] [--dry-run] [--limit N]
 *
 *   --force     re-ingest even if this build has already been processed
 *   --dry-run   parse and report without writing
 *   --limit N   stop after ~N paper printings (development only)
 */
import { drizzle } from "drizzle-orm/better-sqlite3";

import { DB_PATH, openDatabase } from "@/db/client";
import { ingestScryfallBulk } from "@/ingest/scryfall";

const args = process.argv.slice(2);

function numericFlag(name: string): number | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} requires a positive integer`);
  }
  return value;
}

async function main() {
  const sqlite = openDatabase(DB_PATH);

  try {
    const result = await ingestScryfallBulk(drizzle(sqlite), sqlite, {
      force: args.includes("--force"),
      dryRun: args.includes("--dry-run"),
      limit: numericFlag("--limit"),
      log: (message) => console.log(message),
    });

    if (result.skipped) return;

    console.log("");
    console.table({
      "bulk build": result.bulkUpdatedAt,
      "snapshot date": result.snapshotDate,
      "lines read": result.linesRead,
      "skipped (digital only)": result.nonPaperSkipped,
      "printings upserted": result.printingsUpserted,
      "snapshots written": result.snapshotsWritten,
      "printings with no USD price": result.printingsWithNoPrice,
    });
  } finally {
    sqlite.close();
  }
}

main().catch((error: Error) => {
  console.error(`Ingest failed: ${error.message}`);
  process.exitCode = 1;
});
