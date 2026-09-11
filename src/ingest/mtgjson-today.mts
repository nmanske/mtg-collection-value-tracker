/**
 * The daily price refresh, from MTGJSON's `AllPricesToday`.
 *
 * MTGJSON is the sole source of price data. Scryfall still supplies card
 * metadata — it is the only source of printings — but its `prices.usd` is no
 * longer read, so there is exactly one pricing provider to reason about, one
 * set of terms to honour, and no seam where two providers meet.
 *
 * `AllPricesToday` is the same shape as `AllPrices` with a single date per
 * series, which is why this reuses the archive's parser rather than repeating
 * it. Verified against the live file on 2026-09-11:
 * `{meta: {date, version}, data: {<uuid>: {paper: {<vendor>: {currency,
 * retail, buylist}}}}}`, with empty `buylist: {}` objects where a vendor does
 * not buy.
 *
 * The gzipped variant is fetched: 5.2 MB against 50.5 MB uncompressed. MTGJSON
 * also publishes bzip2 at 3.3 MB, but Node's `zlib` has no bzip2, and a
 * dependency is not worth 1.9 MB a day.
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { holdings, mtgjsonIds, printings, syncMeta } from "@/db/schema";

import {
  type ArchiveBuild,
  ingestArchiveBuild,
  readBuildMeta,
  tuneForBulkLoad,
} from "./mtgjson-archive.mjs";

const URL = "https://mtgjson.com/api/v5/AllPricesToday.json.gz";
const HEADERS = { "User-Agent": "mtg-collection-value-tracker/0.1" };

/** The MTGJSON build whose daily prices were last recorded. */
export const TODAY_SYNC_KEY = "mtgjson_today_version";

export interface TodayOptions {
  /** Re-run even if this build was already recorded. */
  force?: boolean;
  dryRun?: boolean;
  cacheDir?: string;
  log?: (message: string) => void;
}

export interface TodayResult {
  skipped: boolean;
  version: string;
  date: string;
  snapshotsInserted: number;
  vendorRowsWritten: number;
  uuidsSeen: number;
  uuidsUnmapped: number;
  seconds: number;
}

/**
 * Downloads today's prices, replacing any previous copy.
 *
 * Unlike the archive's builds this file is not worth keeping — it is supplanted
 * every day and its contents live in the database afterwards — so it is written
 * to a fixed name and deleted once read.
 */
async function download(
  target: string,
  log: (message: string) => void,
): Promise<void> {
  log(`Downloading ${URL}...`);
  const response = await fetch(URL, { headers: HEADERS });
  if (!response.ok || !response.body) {
    throw new Error(`${URL} returned ${response.status} ${response.statusText}`);
  }

  const partial = `${target}.part`;
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(partial),
  );
  await rename(partial, target);

  const { size } = await stat(target);
  log(`Ready: ${(size / 1e6).toFixed(1)} MB`);
}

/** Records one day of prices for every printing, from MTGJSON. */
export async function ingestMtgjsonToday(
  db: BetterSQLite3Database<Record<string, never>>,
  sqlite: SqliteDatabase,
  options: TodayOptions = {},
): Promise<TodayResult> {
  const log = options.log ?? (() => {});
  const cacheDir = options.cacheDir ?? "./data/cache";
  await mkdir(cacheDir, { recursive: true });

  const path = join(cacheDir, "AllPricesToday.json.gz");
  await download(path, log);

  // Read from the file's own header rather than a separate Meta.json request:
  // one fetch, and no chance of pairing a version string with a file built at
  // a different moment.
  const { version, date } = await readBuildMeta(path);
  log(`MTGJSON build ${version} (${date})`);

  const result: TodayResult = {
    skipped: false,
    version,
    date,
    snapshotsInserted: 0,
    vendorRowsWritten: 0,
    uuidsSeen: 0,
    uuidsUnmapped: 0,
    seconds: 0,
  };

  const lastRun = db
    .select()
    .from(syncMeta)
    .where(eq(syncMeta.key, TODAY_SYNC_KEY))
    .get();

  if (lastRun?.value === version && !options.force) {
    log("Already recorded this build; nothing to do.");
    await unlink(path).catch(() => {});
    return { ...result, skipped: true };
  }

  tuneForBulkLoad(sqlite);

  // Every printing, so a card can be looked up whether or not it is held.
  const uuidToPrinting = new Map<string, number>();
  for (const row of db
    .select({ uuid: mtgjsonIds.uuid, printingKey: printings.id })
    .from(mtgjsonIds)
    .innerJoin(printings, eq(printings.scryfallId, mtgjsonIds.scryfallId))
    .all()) {
    uuidToPrinting.set(row.uuid, row.printingKey);
  }
  if (uuidToPrinting.size === 0) {
    throw new Error(
      "No uuid map. Run ingest:scryfall for metadata, then backfill:mtgjson to build it.",
    );
  }

  const held = new Set(
    db.selectDistinct({ id: holdings.printingKey }).from(holdings).all().map(
      (row) => row.id,
    ),
  );

  const build: ArchiveBuild = {
    label: version,
    pricesPath: path,
    identifiersPath: null,
  };

  // `after` is null: this file carries one date, and the insert is
  // onConflictDoNothing, so a re-run cannot overwrite a day already recorded.
  const outcome = await ingestArchiveBuild(
    db,
    sqlite,
    build,
    uuidToPrinting,
    held,
    null,
    { snapshotScope: "all", vendorScope: "all", dryRun: options.dryRun, log },
  );

  result.snapshotsInserted = outcome.snapshotsInserted;
  result.vendorRowsWritten = outcome.vendorRowsWritten;
  result.uuidsSeen = outcome.uuidsSeen;
  result.uuidsUnmapped = outcome.uuidsUnmapped;
  result.seconds = outcome.seconds;

  if (!options.dryRun) {
    const now = new Date();
    db.insert(syncMeta)
      .values({ key: TODAY_SYNC_KEY, value: version, updatedAt: now })
      .onConflictDoUpdate({
        target: syncMeta.key,
        set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
      })
      .run();
  }

  await unlink(path).catch(() => {});
  return result;
}

/** Whether the uuid map exists, which the daily price job depends on. */
export function hasIdentifierMap(
  db: BetterSQLite3Database<Record<string, never>>,
): boolean {
  return (
    (db.select({ n: sql<number>`count(*)` }).from(mtgjsonIds).get()?.n ?? 0) > 0
  );
}
