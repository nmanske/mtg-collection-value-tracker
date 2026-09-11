/**
 * Historical price backfill from a local archive of MTGJSON builds.
 *
 * MTGJSON's live `AllPrices.json` carries a rolling ~90-day window, so the
 * public API can never reach further back than three months. An archive of past
 * builds can: each dump contributes its own window, and consecutive dumps
 * overlap enough to stitch into a continuous series.
 *
 * Verified against the Kaggle `mirhagk/mtg-json` dumps on 2026-09-11:
 * - The 2021-era files use the same shape as the live ones —
 *   `{meta, data: {<uuid>: {paper: {<vendor>: {currency, retail, buylist}}}}}`
 *   with prices at `.<side>.<finish>["YYYY-MM-DD"]` — so one parser serves both.
 * - `Meta.json` and `AllPrices.json`'s own `meta` can disagree by a day or two
 *   (build 0001 says 2021-03-08 and 2021-03-10 respectively). The price file's
 *   own header is authoritative for the data it contains, so that is what is
 *   read; `Meta.json` is not consulted.
 * - Files are uncompressed JSON, each in a directory named after itself
 *   (`version_0001/AllPrices.json/AllPrices.json`) — an artifact of how Kaggle
 *   serves a dataset directory. A flat layout is accepted too.
 *
 * Scope matters more here than in the live backfill. One 90-day build is 2.7M
 * vendor rows for a 3,700-printing collection and ~80M for all 108k printings;
 * multiplied by the ~2,500 distinct days an archive spans, the second figure is
 * billions of rows. Held printings are therefore the default for vendor data,
 * while the single TCGplayer retail series that drives the charts can afford to
 * cover everything.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createGunzip } from "node:zlib";

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
  vendorPrices,
} from "@/db/schema";

import { FINISH_CODES, SIDE_CODES, VENDOR_CODES } from "@/db/codec";

import { FINISH_BY_MTGJSON_KEY, MAX_BIND_PARAMS } from "./mtgjson.mjs";
import { priceNumberToCents } from "./money";

/**
 * The snapshot series that drives the portfolio chart.
 *
 * Scryfall's `prices.usd` is also TCGplayer retail, so holding the backfill to
 * the same vendor and side is what keeps five years of history continuous with
 * ongoing daily tracking instead of putting a vendor-switch step in the chart.
 */
const SNAPSHOT_VENDOR = "tcgplayer";

/**
 * The vendors kept from an archived build.
 *
 * Narrower than `VENDORS`, which is what the live 90-day ingest records. At
 * archive scale the difference is tens of gigabytes, and the two that are cut
 * earn their removal on the merits rather than only on size:
 *
 * - Cardmarket quotes EUR, and v1 is USD-only. Its series cannot join a dollar
 *   total without an exchange-rate history the project does not have.
 * - Manapool only appears in recent builds, so it cannot contribute the deep
 *   history that is the whole point of reading an archive.
 *
 * TCGplayer is absent from this list for two separate reasons, and both matter:
 *
 * - Its retail series is the canonical one and already lives in
 *   `price_snapshots`. Writing it here too put the same series on both sides of
 *   the vendor-comparison union, which counted every held card twice and
 *   reported a collection total of $27,484 against a real $15,187.
 * - Its buylist stops at 2022-01-04 — MTGJSON discontinued the series — so the
 *   only place it could appear is a "latest quote" panel, where a four-year-old
 *   price sits beside current ones and reads as an offer that still stands.
 *   Archived builds still contain it, so this is a decision not to keep it
 *   rather than an absence of data; re-adding it is a one-line change and a
 *   re-run.
 *
 * Only `paper` is read. Builds also carry `mtgo.cardhoarder`, priced in event
 * tickets, which does not belong in a dollar total.
 */
const ARCHIVE_VENDORS: readonly Vendor[] = ["cardkingdom"];

/** Highest archive build already ingested, so 280 files can resume. */
export const ARCHIVE_VERSION_KEY = "mtgjson_archive_version";
/** Latest price date ingested, used to skip the overlap between builds. */
export const ARCHIVE_DATE_KEY = "mtgjson_archive_max_date";

const VENDOR_BATCH_SIZE = Math.floor(MAX_BIND_PARAMS / 6);
const SNAPSHOT_BATCH_SIZE = Math.floor(MAX_BIND_PARAMS / 6);
const ID_BATCH_SIZE = 5_000;
const PROGRESS_EVERY = 50_000;

/**
 * Rows buffered before a flush, far above the per-statement batch size.
 *
 * Both price tables are WITHOUT ROWID, so their rows live in a B-tree clustered
 * on `printing_key`. MTGJSON iterates in uuid order, which against that key is
 * random, so inserting as the file is read writes to a random page every time.
 * Buffering a large run and sorting it into key order first turns that back
 * into a mostly-sequential append.
 *
 * Sized to keep the buffer in the low hundreds of MB: one build contributes
 * ~17M vendor rows, which could not be held whole.
 */
const SORT_BUFFER_ROWS = 1_000_000;

/**
 * Page cache for a bulk load, in KiB (negative means KiB rather than pages).
 *
 * The default is 2 MB. Random inserts into a multi-gigabyte clustered index
 * miss that cache almost every time, and the read-modify-write of a random page
 * is what the load actually spends its time on.
 */
const BULK_CACHE_KIB = -1_048_576;

/**
 * Applies pragmas worth setting only while bulk loading.
 *
 * Durability is deliberately untouched — WAL and its default synchronous level
 * stay as they are. A backfill that corrupts the database on a power cut would
 * cost far more than it saves, and the run is resumable anyway.
 */
export function tuneForBulkLoad(sqlite: SqliteDatabase): void {
  sqlite.pragma(`cache_size = ${BULK_CACHE_KIB}`);
  sqlite.pragma("temp_store = MEMORY");
}

export type Scope = "none" | "held" | "all";

export interface ArchiveBuild {
  /** Directory name, e.g. `version_0001` — the archive's own ordering. */
  label: string;
  pricesPath: string;
  identifiersPath: string | null;
}

export interface VersionResult {
  label: string;
  version: string;
  buildDate: string;
  skipped: boolean;
  reason?: string;
  uuidsSeen: number;
  uuidsUnmapped: number;
  snapshotsInserted: number;
  vendorRowsWritten: number;
  /** Date points ignored because an earlier build already covered them. */
  datesSkippedAsOverlap: number;
  earliestDate: string | null;
  latestDate: string | null;
  seconds: number;
}

export interface ArchiveOptions {
  snapshotScope?: Scope;
  vendorScope?: Scope;
  /** Vendors to record. Defaults to TCGplayer and Card Kingdom. */
  keepVendors?: readonly Vendor[];
  /** Re-read builds already recorded, and ignore the overlap watermark. */
  force?: boolean;
  /** Parse and count without writing. */
  dryRun?: boolean;
  /** Merge each build's own `AllIdentifiers.json` into the uuid map first. */
  refreshIds?: boolean;
  /**
   * Only rebuild the uuid map; read no price file.
   *
   * The map has to be complete *before* prices are read, because a uuid it
   * cannot resolve is skipped silently and that history simply never lands. A
   * uuid is never remapped to a different printing — verified across builds
   * 0001 and 0277, where zero uuids changed meaning — but MTGJSON does retire
   * them: 2,508 of 2021's uuids are absent from the current build. Most remain
   * reachable through another uuid for the same printing; 82 printings are
   * reachable only through a retired one. Merging every build's identifiers
   * before the price pass is what closes that gap.
   */
  idsOnly?: boolean;
  /** Process only every Nth build. Identifier merges tolerate sampling. */
  every?: number;
  /** Stop after this many uuids per build. For measurement. */
  limit?: number;
  log?: (message: string) => void;
}

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

interface VendorRow {
  printingKey: number;
  finish: Finish;
  vendor: Vendor;
  side: MarketSide;
  date: string;
  priceCents: number;
}

/**
 * The read stages for a build file, decompressing a `.gz` archive on the way.
 *
 * Returned as stages to be spread into a `chain` rather than as a stream:
 * `chain` is typed over fixed-length tuples, and a `ReadStream | ChainOutput`
 * union does not satisfy any of its overloads.
 */
function readStages(path: string) {
  const file = createReadStream(path);
  return path.endsWith(".gz") ? [file, createGunzip()] : [file];
}

/**
 * Resolves a build file, accepting both the Kaggle layout and a flat one.
 *
 * Kaggle serves each file inside a directory of the same name; a hand-assembled
 * archive is more likely to be flat. Returns null when neither exists.
 */
async function resolveFile(dir: string, name: string): Promise<string | null> {
  for (const candidate of [
    join(dir, name),
    join(dir, name, name),
    join(dir, `${name}.gz`),
    join(dir, `${name}.gz`, `${name}.gz`),
  ]) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile() && info.size > 0) return candidate;
  }
  return null;
}

/**
 * Lists the builds in an archive root, in ascending order.
 *
 * Sorted by directory name, which the downloader zero-pads (`version_0001`), so
 * lexical order is chronological order. That matters: the overlap watermark is
 * only correct if builds are ingested oldest-first.
 */
export async function discoverArchive(root: string): Promise<ArchiveBuild[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const builds: ArchiveBuild[] = [];

  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const dir = join(root, entry.name);
    const pricesPath = await resolveFile(dir, "AllPrices.json");
    // A build still downloading has no price file yet; skip rather than fail,
    // so the loader can run against a partially fetched archive.
    if (!pricesPath) continue;
    builds.push({
      label: entry.name,
      pricesPath,
      identifiersPath: await resolveFile(dir, "AllIdentifiers.json"),
    });
  }

  return builds;
}

/** Reads `{"meta": {...}}` from the head of a build without parsing the file. */
export async function readBuildMeta(
  path: string,
): Promise<{ version: string; date: string }> {
  const stream = chain(readStages(path));
  let head = "";
  try {
    for await (const piece of stream as AsyncIterable<Buffer | string>) {
      head += piece.toString("utf8");
      if (head.length > 4_096) break;
    }
  } finally {
    stream.destroy();
  }

  const match = head.match(
    /"meta"\s*:\s*\{\s*"date"\s*:\s*"([\d-]+)"\s*,\s*"version"\s*:\s*"([^"]+)"/,
  );
  if (!match) {
    throw new Error(`No meta header in ${basename(path)}`);
  }
  return { date: match[1], version: match[2] };
}

/**
 * Merges a build's `AllIdentifiers.json` into the uuid map.
 *
 * Upsert rather than the live path's delete-and-replace: the live map is built
 * from a current MTGJSON build and would not contain a uuid that has since been
 * retired, yet an archived build from 2021 may price it. Merging keeps both.
 */
export async function mergeIdentifiers(
  db: BetterSQLite3Database<Record<string, never>>,
  sqlite: SqliteDatabase,
  path: string,
  log: (message: string) => void,
): Promise<number> {
  const stream = chain([
    ...readStages(path),
    parser(),
    pick({ filter: "data" }),
    streamObject(),
  ]);

  const rows: { uuid: string; scryfallId: string }[] = [];
  let added = 0;

  const flush = sqlite.transaction(() => {
    for (let i = 0; i < rows.length; i += ID_BATCH_SIZE) {
      added += db
        .insert(mtgjsonIds)
        .values(rows.slice(i, i + ID_BATCH_SIZE))
        .onConflictDoNothing()
        .run().changes;
    }
    rows.length = 0;
  });

  try {
    for await (const item of stream as AsyncIterable<{
      key: string;
      value: { identifiers?: { scryfallId?: string } };
    }>) {
      const scryfallId = item.value?.identifiers?.scryfallId;
      if (!scryfallId) continue;
      rows.push({ uuid: item.key, scryfallId });
      if (rows.length >= ID_BATCH_SIZE * 4) flush();
    }
    flush();
  } finally {
    stream.destroy();
  }

  log(`  identifiers: ${added.toLocaleString()} new uuid mappings`);
  return added;
}

/** Builds the uuid -> printing key map, restricted to the widest scope in use. */
function loadUuidMap(
  db: BetterSQLite3Database<Record<string, never>>,
  scope: Set<number> | null,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of db
    .select({ uuid: mtgjsonIds.uuid, printingKey: printings.id })
    .from(mtgjsonIds)
    .innerJoin(printings, eq(printings.scryfallId, mtgjsonIds.scryfallId))
    .all()) {
    if (scope === null || scope.has(row.printingKey)) {
      map.set(row.uuid, row.printingKey);
    }
  }
  return map;
}

function heldPrintings(
  db: BetterSQLite3Database<Record<string, never>>,
): Set<number> {
  return new Set(
    db.selectDistinct({ id: holdings.printingKey }).from(holdings).all().map(
      (row) => row.id,
    ),
  );
}

/**
 * Ingests one archived build.
 *
 * `after` is the watermark: date points at or before it were already taken from
 * an earlier build and are skipped without being buffered. Consecutive dumps in
 * the Kaggle set are ~8 days apart but each carries ~90 days, so roughly 90% of
 * every file is overlap — skipping it early is the difference between writing
 * 3M rows per build and writing 300k.
 */
export async function ingestArchiveBuild(
  db: BetterSQLite3Database<Record<string, never>>,
  sqlite: SqliteDatabase,
  build: ArchiveBuild,
  uuidToPrinting: Map<string, number>,
  held: Set<number>,
  after: string | null,
  options: ArchiveOptions,
): Promise<VersionResult> {
  const log = options.log ?? (() => {});
  const snapshotScope = options.snapshotScope ?? "all";
  const vendorScope = options.vendorScope ?? "held";
  const keepVendors = options.keepVendors ?? ARCHIVE_VENDORS;
  const startedAt = Date.now();

  const { version, date: buildDate } = await readBuildMeta(build.pricesPath);

  const result: VersionResult = {
    label: build.label,
    version,
    buildDate,
    skipped: false,
    uuidsSeen: 0,
    uuidsUnmapped: 0,
    snapshotsInserted: 0,
    vendorRowsWritten: 0,
    datesSkippedAsOverlap: 0,
    earliestDate: null,
    latestDate: null,
    seconds: 0,
  };

  const snapshots: NewPriceSnapshot[] = [];
  const vendorRows: VendorRow[] = [];

  const flushSnapshots = sqlite.transaction(() => {
    // Sorted into primary-key order before insert; see SORT_BUFFER_ROWS.
    snapshots.sort(
      (a, b) =>
        a.printingKey - b.printingKey ||
        FINISH_CODES[a.finish] - FINISH_CODES[b.finish] ||
        (a.date < b.date ? -1 : a.date > b.date ? 1 : 0),
    );
    for (let i = 0; i < snapshots.length; i += SNAPSHOT_BATCH_SIZE) {
      // onConflictDoNothing: whichever build first supplied a day owns it.
      // Archived builds agree on past dates, and the live ingest's own rows
      // must not be rewritten by a five-year-old file.
      result.snapshotsInserted += db
        .insert(priceSnapshots)
        .values(snapshots.slice(i, i + SNAPSHOT_BATCH_SIZE))
        .onConflictDoNothing({
          target: [
            priceSnapshots.printingKey,
            priceSnapshots.finish,
            priceSnapshots.date,
          ],
        })
        .run().changes;
    }
    snapshots.length = 0;
  });

  const flushVendors = sqlite.transaction(() => {
    vendorRows.sort(
      (a, b) =>
        a.printingKey - b.printingKey ||
        FINISH_CODES[a.finish] - FINISH_CODES[b.finish] ||
        VENDOR_CODES[a.vendor] - VENDOR_CODES[b.vendor] ||
        SIDE_CODES[a.side] - SIDE_CODES[b.side] ||
        (a.date < b.date ? -1 : a.date > b.date ? 1 : 0),
    );
    for (let i = 0; i < vendorRows.length; i += VENDOR_BATCH_SIZE) {
      result.vendorRowsWritten += db
        .insert(vendorPrices)
        .values(vendorRows.slice(i, i + VENDOR_BATCH_SIZE))
        .onConflictDoNothing({
          target: [
            vendorPrices.printingKey,
            vendorPrices.finish,
            vendorPrices.vendor,
            vendorPrices.side,
            vendorPrices.date,
          ],
        })
        .run().changes;
    }
    vendorRows.length = 0;
  });

  // Buffers overshoot their batch size — one card contributes a date series per
  // vendor, side and finish in a single iteration — so both flushes slice
  // internally rather than trusting the length check to keep them under
  // SQLite's bind-parameter cap.
  const maybeFlushSnapshots = (force = false) => {
    if (!force && snapshots.length < SORT_BUFFER_ROWS) return;
    if (options.dryRun) {
      result.snapshotsInserted += snapshots.length;
      snapshots.length = 0;
      return;
    }
    flushSnapshots();
  };

  const maybeFlushVendors = (force = false) => {
    if (!force && vendorRows.length < SORT_BUFFER_ROWS) return;
    if (options.dryRun) {
      result.vendorRowsWritten += vendorRows.length;
      vendorRows.length = 0;
      return;
    }
    flushVendors();
  };

  const newer = (date: string) => after === null || date > after;

  const stream = chain([
    ...readStages(build.pricesPath),
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
          `  ${result.uuidsSeen.toLocaleString()} uuids, ` +
            `${result.snapshotsInserted.toLocaleString()} snapshots, ` +
            `${result.vendorRowsWritten.toLocaleString()} vendor rows...`,
        );
      }

      const printingKey = uuidToPrinting.get(item.key);
      if (printingKey === undefined) {
        result.uuidsUnmapped += 1;
        continue;
      }

      const isHeld = held.has(printingKey);
      const wantSnapshot = snapshotScope === "all" || (snapshotScope === "held" && isHeld);
      const wantVendor = vendorScope === "all" || (vendorScope === "held" && isHeld);
      if (!wantSnapshot && !wantVendor) continue;

      const paper = item.value?.paper;
      if (!paper) continue;

      if (wantSnapshot) {
        const tcg = paper[SNAPSHOT_VENDOR];
        // Guard rather than assume: the snapshot series is USD by definition,
        // and importing a EUR figure as dollars would corrupt the portfolio
        // total invisibly.
        if (tcg?.retail && (!tcg.currency || tcg.currency === "USD")) {
          for (const [key, series] of Object.entries(tcg.retail)) {
            const finish = FINISH_BY_MTGJSON_KEY[key];
            if (!finish || !series) continue;

            for (const [date, price] of Object.entries(series)) {
              if (!newer(date)) {
                result.datesSkippedAsOverlap += 1;
                continue;
              }
              const priceCents = priceNumberToCents(price);
              if (priceCents == null) continue;

              if (!result.earliestDate || date < result.earliestDate) {
                result.earliestDate = date;
              }
              if (!result.latestDate || date > result.latestDate) {
                result.latestDate = date;
              }

              snapshots.push({
                printingKey,
                finish,
                date,
                priceCents,
                source: "mtgjson",
                estimated: false,
              });
            }
          }
        }
      }

      if (wantVendor) {
        for (const [name, body] of Object.entries(paper)) {
          if (!(keepVendors as readonly string[]).includes(name)) continue;
          const vendor = name as Vendor;
          // Both kept vendors quote USD, so there is no currency to carry.
          // Guard anyway: a build that ever said otherwise must be skipped
          // rather than silently counted as dollars.
          if (body?.currency && body.currency !== "USD") continue;

          for (const side of MARKET_SIDES) {
            const series = body?.[side];
            if (!series) continue;

            for (const [key, points] of Object.entries(series)) {
              const finish = FINISH_BY_MTGJSON_KEY[key];
              if (!finish || !points) continue;

              for (const [date, price] of Object.entries(points)) {
                if (!newer(date)) continue;
                const priceCents = priceNumberToCents(price);
                if (priceCents == null) continue;

                if (!result.earliestDate || date < result.earliestDate) {
                  result.earliestDate = date;
                }
                if (!result.latestDate || date > result.latestDate) {
                  result.latestDate = date;
                }

                vendorRows.push({
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
      }

      maybeFlushSnapshots();
      maybeFlushVendors();
      if (options.limit && result.uuidsSeen >= options.limit) break;
    }

    maybeFlushSnapshots(true);
    maybeFlushVendors(true);
  } finally {
    stream.destroy();
  }

  result.seconds = (Date.now() - startedAt) / 1000;
  return result;
}

export interface ArchiveResult {
  builds: VersionResult[];
  snapshotsInserted: number;
  vendorRowsWritten: number;
  earliestDate: string | null;
  latestDate: string | null;
}

/** Walks an archive root oldest-first, recording progress after each build. */
export async function backfillFromArchive(
  db: BetterSQLite3Database<Record<string, never>>,
  sqlite: SqliteDatabase,
  root: string,
  options: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const log = options.log ?? (() => {});
  const snapshotScope = options.snapshotScope ?? "all";
  const vendorScope = options.vendorScope ?? "held";

  let builds = await discoverArchive(root);
  if (options.every && options.every > 1) {
    // The newest build is always kept: it defines the current map, and a
    // sample that stopped short of it would miss every recent printing.
    const sampled = builds.filter((_, i) => i % options.every! === 0);
    if (builds.length > 0 && sampled.at(-1) !== builds.at(-1)) {
      sampled.push(builds.at(-1)!);
    }
    builds = sampled;
    log(`Sampling every ${options.every} builds`);
  }
  log(`${builds.length} build(s) in ${root}`);
  log(
    `Scope: snapshots=${snapshotScope}, vendor prices=${vendorScope} ` +
      `(${(options.keepVendors ?? ARCHIVE_VENDORS).join(", ")})`,
  );

  const held = heldPrintings(db);
  log(`${held.size.toLocaleString()} held printings`);

  // The uuid map covers every printing when either scope is "all"; otherwise
  // only held ones, so the hot loop's misses cost a single Map lookup.
  const widest: Scope[] = [snapshotScope, vendorScope];
  const uuidToPrinting = loadUuidMap(
    db,
    widest.includes("all") ? null : held,
  );
  log(`${uuidToPrinting.size.toLocaleString()} uuids map into scope`);

  const doneVersion = db
    .select()
    .from(syncMeta)
    .where(eq(syncMeta.key, ARCHIVE_VERSION_KEY))
    .get()?.value;
  let watermark = options.force
    ? null
    : (db
        .select()
        .from(syncMeta)
        .where(eq(syncMeta.key, ARCHIVE_DATE_KEY))
        .get()?.value ?? null);

  if (watermark) log(`Resuming after ${watermark} (last build ${doneVersion})`);

  const results: ArchiveResult = {
    builds: [],
    snapshotsInserted: 0,
    vendorRowsWritten: 0,
    earliestDate: null,
    latestDate: null,
  };

  // Builds already completed are skipped outright rather than re-read.
  //
  // The overlap watermark alone makes them harmless — every date is below it,
  // so nothing is written — but "harmless" still means streaming a 500 MB file
  // to discover there is nothing to do, at 65-85 seconds each. That is a cost
  // paid on every restart and it grows as the watermark advances: resuming at
  // build 200 would spend nearly three hours re-parsing before reaching new
  // data.
  //
  // Keyed on the build's own date rather than its label. A build's window ends
  // at its build date, so one dated at or before the watermark can contribute
  // nothing, whatever it is called. Reading that date is a 4 KB head read
  // against a full parse, and unlike a label it cannot be thrown off by the
  // recorded position moving.
  let skipped = 0;

  for (const [index, build] of builds.entries()) {
    if (watermark && !options.force) {
      const { date } = await readBuildMeta(build.pricesPath).catch(() => ({
        date: "",
      }));
      if (date && date <= watermark) {
        skipped += 1;
        continue;
      }
    }
    if (skipped > 0) {
      log(`Skipped ${skipped} build(s) already covered through ${watermark}`);
      skipped = 0;
    }

    log(`\n[${index + 1}/${builds.length}] ${build.label}`);

    if ((options.refreshIds || options.idsOnly) && build.identifiersPath) {
      await mergeIdentifiers(db, sqlite, build.identifiersPath, log);
    }
    // Nothing past here touches the price file, the expensive half of a build.
    if (options.idsOnly) continue;

    const outcome = await ingestArchiveBuild(
      db,
      sqlite,
      build,
      uuidToPrinting,
      held,
      watermark,
      options,
    );

    log(
      `  ${outcome.version} (${outcome.buildDate}): ` +
        `${outcome.snapshotsInserted.toLocaleString()} snapshots, ` +
        `${outcome.vendorRowsWritten.toLocaleString()} vendor rows, ` +
        `${outcome.earliestDate ?? "-"}..${outcome.latestDate ?? "-"} ` +
        `in ${outcome.seconds.toFixed(1)}s`,
    );

    results.builds.push(outcome);
    results.snapshotsInserted += outcome.snapshotsInserted;
    results.vendorRowsWritten += outcome.vendorRowsWritten;
    if (
      outcome.earliestDate &&
      (!results.earliestDate || outcome.earliestDate < results.earliestDate)
    ) {
      results.earliestDate = outcome.earliestDate;
    }
    if (
      outcome.latestDate &&
      (!results.latestDate || outcome.latestDate > results.latestDate)
    ) {
      results.latestDate = outcome.latestDate;
    }

    // Advance the watermark only on a real write. A dry run or a --limit pass
    // would otherwise record coverage it never actually ingested, and the next
    // real run would skip those dates for good.
    if (!options.dryRun && !options.limit) {
      if (outcome.latestDate && (!watermark || outcome.latestDate > watermark)) {
        watermark = outcome.latestDate;
      }
      const now = new Date();
      // Monotonic, like the date. Re-reading an older build must not move the
      // recorded position backwards — that is how version_0043 became
      // version_0010 and bought another pass of no-op re-parsing.
      const recordedVersion =
        doneVersion && doneVersion > build.label ? doneVersion : build.label;
      for (const [key, value] of [
        [ARCHIVE_VERSION_KEY, recordedVersion],
        [ARCHIVE_DATE_KEY, watermark ?? ""],
      ] as const) {
        db.insert(syncMeta)
          .values({ key, value, updatedAt: now })
          .onConflictDoUpdate({
            target: syncMeta.key,
            set: {
              value: sql`excluded.value`,
              updatedAt: sql`excluded.updated_at`,
            },
          })
          .run();
      }
    }
  }

  return results;
}
