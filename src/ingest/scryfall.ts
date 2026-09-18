import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import type BetterSqlite3 from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import {
  FINISH_PRICE_FIELD,
  FINISHES,
  type Finish,
  type NewPriceSnapshot,
  type NewPrinting,
  priceSnapshots,
  printings,
  syncMeta,
} from "@/db/schema";

import { priceStringToCents } from "./money";
import type { ScryfallBulkIndex, ScryfallCard } from "./scryfall-types";

const BULK_INDEX_URL = "https://api.scryfall.com/bulk-data";
const BULK_TYPE = "default_cards";

/** Scryfall asks that clients identify themselves and accept JSON. */
const HEADERS = {
  "User-Agent": "mtg-collection-value-tracker/0.1",
  Accept: "application/json",
};

/** `sync_meta` key holding the `updated_at` of the last ingested bulk file. */
export const SYNC_KEY = "scryfall_default_cards_updated_at";

/** Rows are flushed in batches this size; each flush is one transaction. */
const BATCH_SIZE = 2_000;

export interface IngestOptions {
  /** Ingest even if the bulk file's `updated_at` matches the last run. */
  force?: boolean;
  /** Stop after roughly this many paper printings. For development only. */
  limit?: number;
  /** Parse and report without writing to the database. */
  dryRun?: boolean;
  /** Where downloaded bulk files are cached. */
  cacheDir?: string;
  /**
   * Record `prices.usd` alongside the metadata.
   *
   * Off by default. MTGJSON is the sole price source, and Scryfall's figures
   * are TCGplayer's — the same series MTGJSON publishes as `tcgplayer` retail —
   * so writing them too would mean two providers filling one series, with
   * whichever ran first owning each day. Scryfall remains essential for card
   * metadata, which nothing else supplies.
   */
  prices?: boolean;
  log?: (message: string) => void;
}

export interface IngestResult {
  skipped: boolean;
  bulkUpdatedAt: string;
  snapshotDate: string;
  linesRead: number;
  /** Skipped because the printing has no paper game — digital only. */
  nonPaperSkipped: number;
  printingsUpserted: number;
  snapshotsWritten: number;
  /** Paper printings where every finish had a null USD price. */
  printingsWithNoPrice: number;
}

/**
 * The date a snapshot is filed under: the bulk file's own build date, not the
 * wall clock. Re-running a stale file then cannot overwrite today's prices, and
 * a run just after midnight UTC files against the day the prices are from.
 */
export function snapshotDateFor(bulkUpdatedAt: string): string {
  return new Date(bulkUpdatedAt).toISOString().slice(0, 10);
}

export async function fetchBulkEntry(type: string = BULK_TYPE) {
  const response = await fetch(BULK_INDEX_URL, { headers: HEADERS });
  if (!response.ok) {
    throw new Error(
      `Scryfall bulk index returned ${response.status} ${response.statusText}`,
    );
  }

  const index = (await response.json()) as ScryfallBulkIndex;
  const entry = index.data.find((candidate) => candidate.type === type);
  if (!entry) {
    const seen = index.data.map((candidate) => candidate.type).join(", ");
    throw new Error(`No "${type}" entry in Scryfall bulk index (saw: ${seen})`);
  }
  if (!entry.jsonl_download_uri) {
    throw new Error(
      `Scryfall bulk entry "${type}" has no jsonl_download_uri; the API shape has changed`,
    );
  }
  return entry;
}

/**
 * Downloads the bulk file into `cacheDir`, or reuses it if already present.
 *
 * The upstream filename embeds a build timestamp, so it is effectively
 * content-addressed: a cached file of the right name is the right file. Older
 * builds are pruned so the cache holds one file. Downloads land on a `.part`
 * path first, so an interrupted transfer is never mistaken for a complete one.
 */
export async function downloadBulkFile(
  url: string,
  cacheDir: string,
  log: (message: string) => void,
): Promise<string> {
  await mkdir(cacheDir, { recursive: true });

  const fileName = basename(new URL(url).pathname);
  const target = join(cacheDir, fileName);

  const cached = await stat(target).catch(() => null);
  if (cached?.isFile() && cached.size > 0) {
    log(`Using cached bulk file ${fileName} (${formatBytes(cached.size)})`);
    return target;
  }

  log(`Downloading ${fileName}...`);
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok || !response.body) {
    throw new Error(
      `Bulk download returned ${response.status} ${response.statusText}`,
    );
  }

  const partial = `${target}.part`;
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(partial),
  );
  await rename(partial, target);

  const { size } = await stat(target);
  log(`Downloaded ${formatBytes(size)}`);

  for (const stale of await readdir(cacheDir)) {
    if (stale !== fileName) await rm(join(cacheDir, stale), { force: true });
  }

  return target;
}

/**
 * The image to show for a printing. Multi-faced layouts carry no top-level
 * `image_uris`, so fall back to the front face.
 */
function imageUriFor(
  card: ScryfallCard,
  size: "normal" | "large",
): string | null {
  return (
    card.image_uris?.[size] ?? card.card_faces?.[0]?.image_uris?.[size] ?? null
  );
}

/**
 * The back of a double-faced card, or null for a single-faced one.
 *
 * Only faces with their own images count. Split and adventure cards also have
 * two `card_faces`, but both halves are printed on one piece of card and
 * neither face carries `image_uris` — treating those as flippable would offer
 * a button that turns a card over to the same picture.
 */
function backImageUriFor(
  card: ScryfallCard,
  size: "normal" | "large",
): string | null {
  const faces = card.card_faces;
  if (!faces || faces.length < 2) return null;
  if (!faces[0]?.image_uris) return null;
  return faces[1]?.image_uris?.[size] ?? null;
}

/** `reversible_card` layouts carry `oracle_id` per face rather than at the top. */
function oracleIdFor(card: ScryfallCard): string | null {
  return card.oracle_id ?? card.card_faces?.[0]?.oracle_id ?? null;
}

/** Only the finishes Scryfall says this printing exists in, narrowed to ours. */
function knownFinishes(card: ScryfallCard): Finish[] {
  return (card.finishes ?? []).filter((finish): finish is Finish =>
    (FINISHES as readonly string[]).includes(finish),
  );
}

/**
 * Streams the bulk file and writes printings plus one day of price snapshots.
 *
 * Reads gzipped JSON Lines a record at a time — the decompressed file is
 * several gigabytes and cannot be held in memory, let alone passed through
 * `JSON.parse` in one go.
 */
export async function ingestScryfallBulk(
  db: BetterSQLite3Database<Record<string, never>>,
  sqlite: BetterSqlite3.Database,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const log = options.log ?? (() => {});
  const cacheDir = options.cacheDir ?? "./data/cache";

  const entry = await fetchBulkEntry();
  const snapshotDate = snapshotDateFor(entry.updated_at);
  log(
    `Scryfall ${entry.type} built ${entry.updated_at} -> snapshot ${snapshotDate}`,
  );

  const lastRun = db
    .select()
    .from(syncMeta)
    .where(eq(syncMeta.key, SYNC_KEY))
    .get();

  const result: IngestResult = {
    skipped: false,
    bulkUpdatedAt: entry.updated_at,
    snapshotDate,
    linesRead: 0,
    nonPaperSkipped: 0,
    printingsUpserted: 0,
    snapshotsWritten: 0,
    printingsWithNoPrice: 0,
  };

  if (lastRun?.value === entry.updated_at && !options.force) {
    log("Already ingested this build; nothing to do. Use --force to re-run.");
    return { ...result, skipped: true };
  }

  const path = await downloadBulkFile(entry.jsonl_download_uri, cacheDir, log);

  const printingBuffer: NewPrinting[] = [];
  // Snapshots are buffered against the Scryfall id, because the integer
  // printing key is only known once the printing rows have been written.
  const snapshotBuffer: (Omit<NewPriceSnapshot, "printingKey"> & {
    scryfallId: string;
  })[] = [];
  const startedAt = Date.now();

  // better-sqlite3 transactions are synchronous, so one cannot be held open
  // across the async read. Each flush is instead its own transaction over a
  // batch, which also keeps the WAL from growing without bound.
  const flush = sqlite.transaction(() => {
    // RETURNING gives back the integer key for both inserted and updated rows,
    // which is what the buffered snapshots need. Doing it here rather than with
    // a follow-up SELECT keeps the whole batch to two statements.
    const keyByScryfallId = new Map<string, number>();

    if (printingBuffer.length > 0) {
      const written = db
        .insert(printings)
        .values(printingBuffer)
        .onConflictDoUpdate({
          target: printings.scryfallId,
          set: {
            oracleId: sql`excluded.oracle_id`,
            name: sql`excluded.name`,
            setCode: sql`excluded.set_code`,
            setName: sql`excluded.set_name`,
            collectorNumber: sql`excluded.collector_number`,
            imageUri: sql`excluded.image_uri`,
            // Every column that is written must also be updated here. Adding
            // image_uri_large to the insert and not to this list meant a
            // re-ingest populated it only on printings that happened to be
            // new: 229 rows of 108,449, with no error anywhere.
            imageUriLarge: sql`excluded.image_uri_large`,
            imageUriBack: sql`excluded.image_uri_back`,
            imageUriBackLarge: sql`excluded.image_uri_back_large`,
            finishes: sql`excluded.finishes`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .returning({ id: printings.id, scryfallId: printings.scryfallId })
        .all();

      for (const row of written) keyByScryfallId.set(row.scryfallId, row.id);
      result.printingsUpserted += printingBuffer.length;
    }

    if (snapshotBuffer.length > 0) {
      const rows: NewPriceSnapshot[] = [];
      for (const pending of snapshotBuffer) {
        const printingKey = keyByScryfallId.get(pending.scryfallId);
        // Every snapshot is buffered alongside the printing it came from in
        // the same batch, so a miss means the upsert did not return that row —
        // worth failing on rather than dropping a price silently.
        if (printingKey === undefined) {
          throw new Error(
            `No printing key returned for ${pending.scryfallId}; cannot attach its price`,
          );
        }
        rows.push({
          printingKey,
          finish: pending.finish,
          date: pending.date,
          priceCents: pending.priceCents,
          source: pending.source,
          estimated: pending.estimated,
        });
      }

      // Re-running the same build is a no-op; a corrected price for a day
      // already stored overwrites in place rather than duplicating.
      db.insert(priceSnapshots)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            priceSnapshots.printingKey,
            priceSnapshots.finish,
            priceSnapshots.date,
          ],
          set: {
            priceCents: sql`excluded.price_cents`,
            source: sql`excluded.source`,
            estimated: sql`excluded.estimated`,
          },
        })
        .run();
      result.snapshotsWritten += rows.length;
    }

    printingBuffer.length = 0;
    snapshotBuffer.length = 0;
  });

  const flushDryRun = () => {
    result.printingsUpserted += printingBuffer.length;
    result.snapshotsWritten += snapshotBuffer.length;
    printingBuffer.length = 0;
    snapshotBuffer.length = 0;
  };

  const maybeFlush = (force = false) => {
    if (!force && printingBuffer.length < BATCH_SIZE) return;
    if (options.dryRun) flushDryRun();
    else flush();
  };

  const lines = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  const ingestedAt = new Date(entry.updated_at);

  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      // The JSONL feed carries no wrapping punctuation, but tolerate blank
      // lines and the stray array brackets the older format would produce.
      if (trimmed === "" || trimmed === "[" || trimmed === "]") continue;

      result.linesRead += 1;

      let card: ScryfallCard;
      try {
        card = JSON.parse(trimmed.replace(/,$/, "")) as ScryfallCard;
      } catch (error) {
        throw new Error(
          `Malformed JSON on line ${result.linesRead}: ${(error as Error).message}`,
        );
      }

      // Digital-only printings have no paper price to track.
      if (!card.games?.includes("paper")) {
        result.nonPaperSkipped += 1;
        continue;
      }

      const oracleId = oracleIdFor(card);
      if (!oracleId) {
        // Every paper printing should have one; a miss means a layout this
        // code has not been taught about, and is worth failing loudly for.
        throw new Error(
          `Printing ${card.id} (${card.name}, layout ${card.layout}) has no oracle_id`,
        );
      }

      const finishes = knownFinishes(card);
      printingBuffer.push({
        scryfallId: card.id,
        oracleId,
        name: card.name,
        setCode: card.set,
        setName: card.set_name,
        collectorNumber: card.collector_number,
        imageUri: imageUriFor(card, "normal"),
        // Read from Scryfall rather than derived from the normal URL; see the
        // column's note in the schema.
        imageUriLarge: imageUriFor(card, "large"),
        imageUriBack: backImageUriFor(card, "normal"),
        imageUriBackLarge: backImageUriFor(card, "large"),
        finishes: finishes.length > 0 ? finishes : ["nonfoil"],
        updatedAt: ingestedAt,
      });

      let priced = false;
      for (const finish of options.prices ? finishes : []) {
        const cents = priceStringToCents(
          card.prices?.[FINISH_PRICE_FIELD[finish]],
        );
        // A null price is a real state — the printing exists in this finish
        // but has no USD listing. Recorded as absence, never as zero.
        if (cents == null) continue;
        priced = true;
        snapshotBuffer.push({
          scryfallId: card.id,
          finish,
          date: snapshotDate,
          priceCents: cents,
          source: "scryfall",
          estimated: false,
        });
      }
      if (options.prices && !priced) result.printingsWithNoPrice += 1;

      maybeFlush();

      if (
        options.limit &&
        result.printingsUpserted + printingBuffer.length >= options.limit
      ) {
        break;
      }
    }

    maybeFlush(true);
  } finally {
    lines.close();
  }

  if (!options.dryRun) {
    const now = new Date();
    db.insert(syncMeta)
      .values({ key: SYNC_KEY, value: entry.updated_at, updatedAt: now })
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
