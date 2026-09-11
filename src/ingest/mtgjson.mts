/**
 * MTGJSON historical price backfill.
 *
 * ESM (`.mts`) because `stream-json` v3 is ESM-only, and `AllPrices.json` is
 * 1.23 GB as a single JSON object — far too large for `JSON.parse`, and not
 * line-delimited the way Scryfall's bulk file is, so it needs a real streaming
 * parser rather than `readline`.
 *
 * Verified against the live files on 2026-09-09:
 * - `AllPrices.json` is `{meta, data: {<uuid>: {<game>: {<vendor>: ...}}}}`,
 *   with prices as JSON numbers and a rolling ~90-day window.
 * - Prices sit at `paper.<vendor>.retail.<finish>["YYYY-MM-DD"]`, where finish
 *   is `normal` / `foil` / `etched`.
 * - `AllPrintings.sqlite` carries `cardIdentifiers(uuid, scryfallId)`, which
 *   replaces parsing the 638 MB `AllIdentifiers.json` with a SQL read.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import BetterSqlite3 from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { chain } from "stream-chain";
import { pick } from "stream-json/filters/pick.js";
import { parser } from "stream-json/parser.js";
import { streamObject } from "stream-json/streamers/stream-object.js";

import {
  type Finish,
  holdings,
  MARKET_SIDES,
  type MarketSide,
  mtgjsonIds,
  type NewPriceSnapshot,
  priceSnapshots,
  printings,
  syncMeta,
  type Vendor,
  VENDORS,
  vendorPrices,
} from "@/db/schema";

import { priceNumberToCents } from "./money";

const BASE_URL = "https://mtgjson.com/api/v5";
const HEADERS = { "User-Agent": "mtg-collection-value-tracker/0.1" };

export const PRICES_SYNC_KEY = "mtgjson_all_prices_version";
export const IDS_SYNC_KEY = "mtgjson_identifiers_version";

/**
 * Only TCGplayer retail is read. Scryfall's `prices.usd` is also TCGplayer, so
 * restricting the backfill to the same vendor and side of the market is what
 * keeps the history continuous with ongoing tracking — mixing in Card Kingdom
 * or Cardsphere would put a vendor-switch step in the middle of every chart.
 */
const VENDOR = "tcgplayer";

/** MTGJSON's finish keys, mapped onto ours. `normal` is Scryfall's `nonfoil`. */
export const FINISH_BY_MTGJSON_KEY: Record<string, Finish> = {
  normal: "nonfoil",
  foil: "foil",
  etched: "etched",
};

const BATCH_SIZE = 5_000;
const PROGRESS_EVERY = 20_000;

/**
 * SQLite caps how many bind parameters one statement may carry — 32,766 in
 * current builds. A multi-row insert uses one per column per row, so the batch
 * size has to account for the width of the table: vendor_prices has six
 * columns, and 5,000 rows of it is 30,000 parameters, which fails with
 * "too many SQL variables".
 */
export const MAX_BIND_PARAMS = 30_000;
const VENDOR_COLUMNS = 6;
const VENDOR_BATCH_SIZE = Math.floor(MAX_BIND_PARAMS / VENDOR_COLUMNS);

interface MtgjsonMeta {
  meta: { date: string; version: string };
}

/** `data[uuid]` — only the parts read here are typed. */
interface PriceEntry {
  paper?: Record<
    string,
    {
      currency?: string;
      retail?: Record<string, Record<string, number>>;
      buylist?: Record<string, Record<string, number>>;
    }
  >;
}

/** A row destined for `vendor_prices`. */
interface VendorRow {
  printingKey: number;
  finish: Finish;
  vendor: Vendor;
  side: MarketSide;
  date: string;
  priceCents: number;
}

/**
 * Also record every vendor and both sides of the market into `vendor_prices`,
 * for the printings in scope.
 *
 * Off by default and deliberately never applied to every printing: measured
 * against a real build, all vendors and sides for all printings is roughly 60
 * million rows, against 2.9 million for one collection.
 */
export interface VendorBackfillResult {
  rowsWritten: number;
  bySeries: { vendor: Vendor; side: MarketSide; rows: number }[];
  earliestDate: string | null;
  latestDate: string | null;
}

export interface BackfillOptions {
  /** Re-run even if this MTGJSON build has already been processed. */
  force?: boolean;
  /**
   * Backfill every printing rather than only those referenced by a holding.
   * Needed for the browse-any-card price history; costs a much larger database.
   */
  all?: boolean;
  /** Stop after this many uuids. For measurement. */
  limit?: number;
  /** Record all vendors and both market sides into `vendor_prices` too. */
  vendors?: boolean;
  dryRun?: boolean;
  cacheDir?: string;
  log?: (message: string) => void;
}

export interface BackfillResult {
  skipped: boolean;
  version: string;
  buildDate: string;
  /** Printings the backfill was scoped to. */
  scopedPrintings: number;
  uuidsSeen: number;
  /** Entries whose uuid maps to no printing we track. */
  uuidsUnmapped: number;
  /** Entries in scope with no TCGplayer paper retail series at all. */
  uuidsWithoutVendor: number;
  snapshotsInserted: number;
  /** Rows skipped because a snapshot already existed for that day. */
  snapshotsAlreadyPresent: number;
  earliestDate: string | null;
  latestDate: string | null;
  /** Present when `vendors` was requested. */
  vendorResult: VendorBackfillResult | null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/**
 * Downloads to `cacheDir`, reusing an existing file of the same name.
 *
 * Unlike Scryfall's, MTGJSON's filenames carry no build stamp, so the cache is
 * keyed by the build version passed in — a new build lands under a new name and
 * the old one is pruned by the caller.
 */
async function downloadCached(
  url: string,
  target: string,
  log: (message: string) => void,
): Promise<string> {
  const cached = await stat(target).catch(() => null);
  if (cached?.isFile() && cached.size > 0) {
    log(`Using cached ${target} (${formatBytes(cached.size)})`);
    return target;
  }

  log(`Downloading ${url}...`);
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok || !response.body) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }

  const partial = `${target}.part`;
  const body = Readable.fromWeb(
    response.body as Parameters<typeof Readable.fromWeb>[0],
  );

  // Gzipped sources are decompressed on the way to disk when the consumer
  // needs random access (SQLite); the price file stays compressed and is
  // decompressed while streaming.
  if (url.endsWith(".gz") && !target.endsWith(".gz")) {
    await pipeline(body, createGunzip(), createWriteStream(partial));
  } else {
    await pipeline(body, createWriteStream(partial));
  }
  await rename(partial, target);

  const { size } = await stat(target);
  log(`Ready: ${target} (${formatBytes(size)})`);
  return target;
}

/**
 * Refreshes the persisted uuid -> scryfallId map from `AllPrintings.sqlite`.
 *
 * Read out of MTGJSON's own SQLite build rather than `AllIdentifiers.json`,
 * which would mean streaming another 638 MB of JSON for two columns.
 */
export async function refreshIdentifierMap(
  db: BetterSQLite3Database<Record<string, never>>,
  sqlite: SqliteDatabase,
  version: string,
  cacheDir: string,
  log: (message: string) => void,
  force = false,
): Promise<number> {
  const current = db
    .select()
    .from(syncMeta)
    .where(eq(syncMeta.key, IDS_SYNC_KEY))
    .get();

  const existing = db.select({ n: sql<number>`count(*)` }).from(mtgjsonIds).get();

  if (current?.value === version && (existing?.n ?? 0) > 0 && !force) {
    log(`Identifier map already at ${version} (${existing?.n} rows)`);
    return existing?.n ?? 0;
  }

  const path = join(cacheDir, `AllPrintings-${version}.sqlite`);
  await downloadCached(`${BASE_URL}/AllPrintings.sqlite.gz`, path, log);

  const source = new BetterSqlite3(path, { readonly: true });
  let rows: { uuid: string; scryfallId: string }[];
  try {
    rows = source
      .prepare(
        "select uuid, scryfallId from cardIdentifiers where scryfallId is not null and scryfallId != ''",
      )
      .all() as { uuid: string; scryfallId: string }[];
  } finally {
    source.close();
  }

  log(`Loaded ${rows.length.toLocaleString()} identifiers; writing map...`);

  sqlite.transaction(() => {
    // A full replace rather than an upsert: MTGJSON occasionally retires a
    // uuid, and a stale row would silently attach history to the wrong
    // printing.
    db.delete(mtgjsonIds).run();
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      db.insert(mtgjsonIds).values(rows.slice(i, i + BATCH_SIZE)).run();
    }
    const now = new Date();
    db.insert(syncMeta)
      .values({ key: IDS_SYNC_KEY, value: version, updatedAt: now })
      .onConflictDoUpdate({
        target: syncMeta.key,
        set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
      })
      .run();
  })();

  // The 678 MB decompressed build is only needed for those two columns.
  await rm(path, { force: true });

  return rows.length;
}

export async function backfillMtgjsonPrices(
  db: BetterSQLite3Database<Record<string, never>>,
  sqlite: SqliteDatabase,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const log = options.log ?? (() => {});
  const cacheDir = options.cacheDir ?? "./data/cache";
  await mkdir(cacheDir, { recursive: true });

  const meta = await fetchJson<MtgjsonMeta>(`${BASE_URL}/Meta.json`);
  const { version, date: buildDate } = meta.meta;
  log(`MTGJSON build ${version} (${buildDate})`);

  const result: BackfillResult = {
    skipped: false,
    version,
    buildDate,
    scopedPrintings: 0,
    uuidsSeen: 0,
    uuidsUnmapped: 0,
    uuidsWithoutVendor: 0,
    snapshotsInserted: 0,
    snapshotsAlreadyPresent: 0,
    earliestDate: null,
    latestDate: null,
    vendorResult: null,
  };

  const lastRun = db
    .select()
    .from(syncMeta)
    .where(eq(syncMeta.key, PRICES_SYNC_KEY))
    .get();

  if (lastRun?.value === version && !options.force) {
    log("Already backfilled this build; nothing to do. Use --force to re-run.");
    return { ...result, skipped: true };
  }

  // Deliberately not passed options.force: the map is keyed on the same build
  // version, so re-running the price backfill should reuse it rather than
  // re-download 243 MB.
  await refreshIdentifierMap(db, sqlite, version, cacheDir, log);

  // Scope. Held printings only by default: a full backfill is ~90x more rows
  // than a single day and most of them are for cards nobody owns.
  const scopeRows = options.all
    ? db.select({ id: printings.id }).from(printings).all()
    : db.selectDistinct({ id: holdings.printingKey }).from(holdings).all();
  const scope = new Set(scopeRows.map((row) => row.id));
  result.scopedPrintings = scope.size;

  if (scope.size === 0) {
    log(
      options.all
        ? "No printings in the database; run the Scryfall ingest first."
        : "No holdings yet, so nothing is in scope. Import a collection first, or pass --all to backfill every printing.",
    );
    return { ...result, skipped: true };
  }
  log(
    `Scope: ${scope.size.toLocaleString()} printings (${options.all ? "--all" : "held only"})`,
  );

  // uuid -> integer printing key, resolved in SQL and restricted to the scope,
  // so the hot loop is a single Map lookup with no post-filter and no second
  // hop through the Scryfall id.
  const uuidToPrinting = new Map<string, number>();
  for (const row of db
    .select({ uuid: mtgjsonIds.uuid, printingKey: printings.id })
    .from(mtgjsonIds)
    .innerJoin(printings, eq(printings.scryfallId, mtgjsonIds.scryfallId))
    .all()) {
    if (scope.has(row.printingKey)) {
      uuidToPrinting.set(row.uuid, row.printingKey);
    }
  }
  log(`${uuidToPrinting.size.toLocaleString()} MTGJSON uuids map into scope`);

  const pricesPath = join(cacheDir, `AllPrices-${version}.json.gz`);
  await downloadCached(`${BASE_URL}/AllPrices.json.gz`, pricesPath, log);

  const buffer: NewPriceSnapshot[] = [];
  const wantVendors = options.vendors ?? false;
  const vendorBuffer: VendorRow[] = [];
  const vendorCounts = new Map<string, number>();
  const vendorResult: VendorBackfillResult = {
    rowsWritten: 0,
    bySeries: [],
    earliestDate: null,
    latestDate: null,
  };
  const startedAt = Date.now();

  const flushVendors = sqlite.transaction(() => {
    if (vendorBuffer.length === 0) return;
    // Sliced here rather than trusting the buffer's length: one card can push
    // several hundred rows in a single iteration (a vendor and side per finish
    // across ~90 days), so the buffer routinely overshoots the batch size
    // before it is next checked. Exceeding SQLite's bind-parameter cap fails
    // the whole run with "too many SQL variables".
    for (let i = 0; i < vendorBuffer.length; i += VENDOR_BATCH_SIZE) {
      const slice = vendorBuffer.slice(i, i + VENDOR_BATCH_SIZE);
      const info = db
      .insert(vendorPrices)
      .values(slice)
      .onConflictDoUpdate({
        target: [
          vendorPrices.printingKey,
          vendorPrices.finish,
          vendorPrices.vendor,
          vendorPrices.side,
          vendorPrices.date,
        ],
        set: { priceCents: sql`excluded.price_cents` },
      })
      .run();
      vendorResult.rowsWritten += info.changes;
    }
    vendorBuffer.length = 0;
  });

  const flush = sqlite.transaction(() => {
    if (buffer.length === 0) return;
    // onConflictDoNothing, not an update: Scryfall owns the days it has
    // written. Backfill fills gaps in history and never overwrites a price
    // already recorded for a day, which keeps the series single-sourced
    // wherever the two overlap.
    // Sliced for the same reason as the vendor insert below: the buffer
    // overshoots its batch size, and six columns leaves less headroom than it
    // looks.
    const SNAPSHOT_BATCH = Math.floor(MAX_BIND_PARAMS / 6);
    for (let i = 0; i < buffer.length; i += SNAPSHOT_BATCH) {
      const slice = buffer.slice(i, i + SNAPSHOT_BATCH);
      const info = db
        .insert(priceSnapshots)
        .values(slice)
        .onConflictDoNothing({
          target: [
            priceSnapshots.printingKey,
            priceSnapshots.finish,
            priceSnapshots.date,
          ],
        })
        .run();
      result.snapshotsInserted += info.changes;
      result.snapshotsAlreadyPresent += slice.length - info.changes;
    }
    buffer.length = 0;
  });

  const maybeFlushVendors = (force = false) => {
    if (!force && vendorBuffer.length < VENDOR_BATCH_SIZE) return;
    if (options.dryRun) {
      vendorResult.rowsWritten += vendorBuffer.length;
      vendorBuffer.length = 0;
      return;
    }
    flushVendors();
  };

  const maybeFlush = (force = false) => {
    if (!force && buffer.length < BATCH_SIZE) return;
    if (options.dryRun) {
      result.snapshotsInserted += buffer.length;
      buffer.length = 0;
      return;
    }
    flush();
  };

  const stream = chain([
    createReadStream(pricesPath),
    createGunzip(),
    parser(),
    pick({ filter: "data" }),
    streamObject(),
  ]);

  try {
    for await (const item of stream as AsyncIterable<{
      key: string;
      value: PriceEntry;
    }>) {
      result.uuidsSeen += 1;

      if (result.uuidsSeen % PROGRESS_EVERY === 0) {
        log(
          `  ${result.uuidsSeen.toLocaleString()} uuids, ${result.snapshotsInserted.toLocaleString()} snapshots...`,
        );
      }

      const printingKey = uuidToPrinting.get(item.key);
      if (printingKey === undefined) {
        result.uuidsUnmapped += 1;
        continue;
      }

      const vendor = item.value?.paper?.[VENDOR];
      const retail = vendor?.retail;
      if (!retail) {
        result.uuidsWithoutVendor += 1;
        continue;
      }
      // Guard rather than assume: v1 is USD-only, and silently importing a
      // EUR series as dollars would corrupt the history invisibly.
      if (vendor.currency && vendor.currency !== "USD") {
        result.uuidsWithoutVendor += 1;
        continue;
      }

      for (const [mtgjsonFinish, series] of Object.entries(retail)) {
        const finish = FINISH_BY_MTGJSON_KEY[mtgjsonFinish];
        if (!finish || !series) continue;

        for (const [date, price] of Object.entries(series)) {
          const priceCents = priceNumberToCents(price);
          if (priceCents == null) continue;

          if (!result.earliestDate || date < result.earliestDate) {
            result.earliestDate = date;
          }
          if (!result.latestDate || date > result.latestDate) {
            result.latestDate = date;
          }

          buffer.push({
            printingKey,
            finish,
            date,
            priceCents,
            source: "mtgjson",
            // Real vendor data, not a flat-filled guess.
            estimated: false,
          });
        }
      }

      if (wantVendors) {
        for (const [vendorName, body] of Object.entries(item.value?.paper ?? {})) {
          if (!(VENDORS as readonly string[]).includes(vendorName)) continue;
          const vendor = vendorName as Vendor;

          // Both kept vendors quote USD. A build that ever said otherwise is
          // skipped rather than silently counted as dollars.
          if (body?.currency && body.currency !== "USD") continue;

          for (const side of MARKET_SIDES) {
            const series = body?.[side];
            if (!series) continue;

            for (const [mtgjsonFinish, points] of Object.entries(series)) {
              const finish = FINISH_BY_MTGJSON_KEY[mtgjsonFinish];
              if (!finish || !points) continue;

              for (const [date, price] of Object.entries(points)) {
                const priceCents = priceNumberToCents(price);
                if (priceCents == null) continue;

                if (!vendorResult.earliestDate || date < vendorResult.earliestDate) {
                  vendorResult.earliestDate = date;
                }
                if (!vendorResult.latestDate || date > vendorResult.latestDate) {
                  vendorResult.latestDate = date;
                }

                const key = `${vendor}.${side}`;
                vendorCounts.set(key, (vendorCounts.get(key) ?? 0) + 1);
                vendorBuffer.push({
                  printingKey,
                  finish,
                  vendor,
                  side,
                  date,
                  priceCents,
                });
              }
            }
          }
        }
        maybeFlushVendors();
      }

      maybeFlush();
      if (options.limit && result.uuidsSeen >= options.limit) break;
    }

    maybeFlush(true);
    maybeFlushVendors(true);
  } finally {
    stream.destroy();
  }

  if (wantVendors) {
    vendorResult.bySeries = [...vendorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, rows]) => {
        const [vendor, side] = key.split(".");
        return { vendor: vendor as Vendor, side: side as MarketSide, rows };
      });
    result.vendorResult = vendorResult;
  }

  if (!options.dryRun && !options.limit) {
    const now = new Date();
    db.insert(syncMeta)
      .values({ key: PRICES_SYNC_KEY, value: version, updatedAt: now })
      .onConflictDoUpdate({
        target: syncMeta.key,
        set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
      })
      .run();
  }

  log(`Finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  return result;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}
