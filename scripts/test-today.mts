/**
 * Tests the daily price ingest against a fixture.
 *
 *   npm run test:today
 *
 * The paths covered here are the ones the live run never exercised: an unmapped
 * uuid, a build already recorded, `--force`, the currency guard, and the empty
 * `buylist: {}` objects MTGJSON emits. A silent failure in this job costs a day
 * of prices that MTGJSON's rolling window makes unrecoverable after ~90 days,
 * so "it worked when I ran it" was not good enough.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { openDatabase } from "@/db/client";
import { mtgjsonIds, priceSnapshots, printings, vendorPrices } from "@/db/schema";
import { hasIdentifierMap, ingestMtgjsonToday } from "@/ingest/mtgjson-today.mjs";

const PATH = "./data/test-today.db";
const FIXTURE = "./data/test-today-fixture.json.gz";
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${PATH}${suffix}`, { force: true });
  rmSync(FIXTURE, { force: true });
};
cleanup();
mkdirSync("./data", { recursive: true });

const sqlite = openDatabase(PATH);
const db = drizzle(sqlite);
migrate(db, { migrationsFolder: "./drizzle" });

const printing = (scryfallId: string, name: string) =>
  db
    .insert(printings)
    .values({
      scryfallId,
      oracleId: `o-${scryfallId}`,
      name,
      setCode: "tst",
      setName: "Test",
      collectorNumber: scryfallId,
      finishes: ["nonfoil", "foil"],
      updatedAt: new Date(),
    })
    .returning({ id: printings.id })
    .all()[0].id;

const ALPHA = printing("sf-alpha", "Alpha");
const BETA = printing("sf-beta", "Beta");

// The uuid map is what joins MTGJSON to our printings; without it nothing lands.
assert.equal(hasIdentifierMap(db), false);
db.insert(mtgjsonIds)
  .values([
    { uuid: "uuid-alpha", scryfallId: "sf-alpha" },
    { uuid: "uuid-beta", scryfallId: "sf-beta" },
  ])
  .run();
assert.equal(hasIdentifierMap(db), true);

/** The real file's shape, including the parts that have caused bugs. */
const writeFixture = (version: string, date: string) => {
  writeFileSync(
    FIXTURE,
    gzipSync(
      Buffer.from(
        JSON.stringify({
          meta: { date, version },
          data: {
            "uuid-alpha": {
              paper: {
                tcgplayer: {
                  currency: "USD",
                  // MTGJSON emits an empty object rather than omitting the key.
                  buylist: {},
                  retail: { normal: { [date]: 12.34 }, foil: { [date]: 56.78 } },
                },
                cardkingdom: {
                  currency: "USD",
                  buylist: { normal: { [date]: 5 } },
                  retail: { normal: { [date]: 9.99 } },
                },
                // Not a kept vendor: must be ignored, not stored.
                cardmarket: {
                  currency: "EUR",
                  buylist: {},
                  retail: { normal: { [date]: 4.2 } },
                },
              },
              // Priced in event tickets, and not a dollar.
              mtgo: {
                cardhoarder: { currency: "USD", retail: { normal: { [date]: 0.03 } } },
              },
            },
            // Maps to nothing we track: counted, not crashed on.
            "uuid-unknown": {
              paper: {
                tcgplayer: { currency: "USD", retail: { normal: { [date]: 1 } } },
              },
            },
          },
        }),
      ),
    ),
  );
};

writeFixture("5.3.0+20260101", "2026-01-01");

// --- first run ---

const first = await ingestMtgjsonToday(db, sqlite, { fixturePath: FIXTURE });
assert.equal(first.skipped, false);
assert.equal(first.version, "5.3.0+20260101");
assert.equal(first.date, "2026-01-01");
assert.equal(first.uuidsSeen, 2);
assert.equal(first.uuidsUnmapped, 1, "an unknown uuid is counted, not fatal");

// TCGplayer retail lands in price_snapshots, one row per finish.
const snapshots = db.select().from(priceSnapshots).all();
assert.equal(snapshots.length, 2);
assert.deepEqual(
  snapshots.map((row) => [row.finish, row.priceCents]).sort(),
  [
    ["foil", 5_678],
    ["nonfoil", 1_234],
  ].sort(),
);
assert.ok(snapshots.every((row) => row.source === "mtgjson"));
assert.ok(snapshots.every((row) => row.printingKey === ALPHA));

// Card Kingdom's two sides land in vendor_prices; TCGplayer retail does not,
// because duplicating it there is what double-counted the collection before.
const vendors = db.select().from(vendorPrices).all();
assert.equal(vendors.length, 2);
assert.ok(vendors.every((row) => row.vendor === "cardkingdom"));
assert.deepEqual(
  vendors.map((row) => row.side).sort(),
  ["buylist", "retail"],
);
// Cardmarket's euro price and the MTGO ticket price are both absent.
assert.ok(!vendors.some((row) => row.priceCents === 420));
assert.ok(!snapshots.some((row) => row.priceCents === 3));

// Beta is in the map but absent from the file, so it is simply not priced.
assert.ok(!snapshots.some((row) => row.printingKey === BETA));

// --- idempotence ---

const second = await ingestMtgjsonToday(db, sqlite, { fixturePath: FIXTURE });
assert.equal(second.skipped, true, "the same build is recorded once");
assert.equal(db.select().from(priceSnapshots).all().length, 2);

// --force re-reads, and the insert still cannot duplicate a recorded day.
const forced = await ingestMtgjsonToday(db, sqlite, {
  fixturePath: FIXTURE,
  force: true,
});
assert.equal(forced.skipped, false);
assert.equal(forced.snapshotsInserted, 0, "a day already stored is not rewritten");
assert.equal(db.select().from(priceSnapshots).all().length, 2);

// --- a new build ---

writeFixture("5.3.0+20260102", "2026-01-02");
const next = await ingestMtgjsonToday(db, sqlite, { fixturePath: FIXTURE });
assert.equal(next.skipped, false);
assert.equal(next.snapshotsInserted, 2, "a new date is recorded");
assert.equal(db.select().from(priceSnapshots).all().length, 4);

// --- dry run ---

writeFixture("5.3.0+20260103", "2026-01-03");
const dry = await ingestMtgjsonToday(db, sqlite, {
  fixturePath: FIXTURE,
  dryRun: true,
});
assert.equal(dry.skipped, false);
assert.equal(
  db.select().from(priceSnapshots).all().length,
  4,
  "a dry run writes nothing",
);
// And must not record the build, or the real run would skip it.
const after = await ingestMtgjsonToday(db, sqlite, { fixturePath: FIXTURE });
assert.equal(after.skipped, false, "a dry run must not mark the build as done");
assert.equal(db.select().from(priceSnapshots).all().length, 6);

sqlite.close();
cleanup();

console.log("Daily ingest tests passed.");
