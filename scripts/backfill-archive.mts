/**
 * Backfills price history from a local archive of MTGJSON builds.
 *
 *   npm run backfill:archive -- [options]
 *
 *   --root DIR        archive root (default ./data/archive)
 *   --snapshots WHICH all | held | none   (default all)
 *   --vendors WHICH   all | held | none   (default held)
 *   --vendor-list A,B which vendors to record (default tcgplayer,cardkingdom)
 *   --refresh-ids     merge each build's AllIdentifiers.json into the uuid map
 *   --ids-only        rebuild the uuid map only; read no price file
 *   --every N         process only every Nth build
 *   --force           re-read every build and ignore the overlap watermark
 *   --dry-run         parse and count without writing
 *   --limit N         stop after N uuids per build (measurement; not recorded)
 *
 * Builds are processed oldest-first and progress is recorded after each one, so
 * an interrupted run resumes where it stopped.
 */
import { drizzle } from "drizzle-orm/better-sqlite3";

import { DB_PATH, openDatabase } from "@/db/client";
import { type Vendor, VENDORS } from "@/db/schema";
import {
  backfillFromArchive,
  type Scope,
  tuneForBulkLoad,
} from "@/ingest/mtgjson-archive.mjs";

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function scopeFlag(name: string, fallback: Scope): Scope {
  const value = flag(name);
  if (value === undefined) return fallback;
  if (value !== "all" && value !== "held" && value !== "none") {
    throw new Error(`${name} must be one of: all, held, none`);
  }
  return value;
}

function vendorListFlag(): Vendor[] | undefined {
  const value = flag("--vendor-list");
  if (value === undefined) return undefined;
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  for (const name of names) {
    if (!(VENDORS as readonly string[]).includes(name)) {
      throw new Error(
        `--vendor-list: unknown vendor "${name}" (known: ${VENDORS.join(", ")})`,
      );
    }
  }
  return names as Vendor[];
}

function numericFlag(name: string): number | undefined {
  const value = flag(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} requires a positive integer`);
  }
  return parsed;
}

const sqlite = openDatabase(DB_PATH);
tuneForBulkLoad(sqlite);

try {
  const result = await backfillFromArchive(
    drizzle(sqlite),
    sqlite,
    flag("--root") ?? "./data/archive",
    {
      snapshotScope: scopeFlag("--snapshots", "all"),
      vendorScope: scopeFlag("--vendors", "held"),
      keepVendors: vendorListFlag(),
      refreshIds: args.includes("--refresh-ids"),
      idsOnly: args.includes("--ids-only"),
      every: numericFlag("--every"),
      force: args.includes("--force"),
      dryRun: args.includes("--dry-run"),
      limit: numericFlag("--limit"),
      log: (message) => console.log(message),
    },
  );

  console.log("");
  console.table({
    "builds processed": result.builds.length.toLocaleString(),
    "snapshots inserted": result.snapshotsInserted.toLocaleString(),
    "vendor rows written": result.vendorRowsWritten.toLocaleString(),
    "date range": `${result.earliestDate ?? "-"} .. ${result.latestDate ?? "-"}`,
    "total time": `${result.builds
      .reduce((sum, build) => sum + build.seconds, 0)
      .toFixed(1)}s`,
  });
} catch (error) {
  console.error(`Archive backfill failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  sqlite.close();
}
