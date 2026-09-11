/**
 * One-time historical price backfill from MTGJSON (~90 days of TCGplayer
 * retail), joined to Scryfall printing ids through MTGJSON's uuid.
 *
 *   npm run backfill:mtgjson -- [--all] [--force] [--dry-run] [--limit N]
 *
 *   --all       backfill every printing, not just those you hold
 *   --vendors   also record every vendor and both market sides (retail and
 *               buylist) into vendor_prices, for the printings in scope
 *   --force     re-run even if this MTGJSON build was already processed
 *   --dry-run   parse and report without writing
 *   --limit N   stop after N uuids (measurement; does not record the run)
 */
import { drizzle } from "drizzle-orm/better-sqlite3";

import { DB_PATH, openDatabase } from "@/db/client";
import { backfillMtgjsonPrices } from "@/ingest/mtgjson.mjs";

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

const sqlite = openDatabase(DB_PATH);

try {
  const result = await backfillMtgjsonPrices(drizzle(sqlite), sqlite, {
    all: args.includes("--all"),
    vendors: args.includes("--vendors"),
    force: args.includes("--force"),
    dryRun: args.includes("--dry-run"),
    limit: numericFlag("--limit"),
    log: (message) => console.log(message),
  });

  if (!result.skipped) {
    console.log("");
    console.table({
      "mtgjson build": `${result.version} (${result.buildDate})`,
      "printings in scope": result.scopedPrintings.toLocaleString(),
      "uuids seen": result.uuidsSeen.toLocaleString(),
      "uuids not in scope": result.uuidsUnmapped.toLocaleString(),
      "in scope, no tcgplayer retail": result.uuidsWithoutVendor.toLocaleString(),
      "snapshots inserted": result.snapshotsInserted.toLocaleString(),
      "already present (kept)": result.snapshotsAlreadyPresent.toLocaleString(),
      "date range": `${result.earliestDate ?? "-"} .. ${result.latestDate ?? "-"}`,
    });

    if (result.vendorResult) {
      const v = result.vendorResult;
      console.log(
        `
Vendor comparison rows: ${v.rowsWritten.toLocaleString()} (${v.earliestDate ?? "-"} .. ${v.latestDate ?? "-"})`,
      );
      for (const series of v.bySeries) {
        console.log(
          `  ${String(series.rows).padStart(9)}  ${series.vendor}.${series.side}`,
        );
      }
    }
  }
} catch (error) {
  console.error(`Backfill failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  sqlite.close();
}
