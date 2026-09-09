/**
 * Round-trips one row through every table and asserts the constraints the rest
 * of the app relies on. Run against a scratch database:
 *   npm run db:smoke
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { openDatabase } from "@/db/client";
import {
  holdings,
  priceSnapshots,
  printings,
  syncMeta,
  unpricedPrintings,
} from "@/db/schema";

const PATH = "./data/smoke.db";
rmSync(PATH, { force: true });
rmSync(`${PATH}-wal`, { force: true });
rmSync(`${PATH}-shm`, { force: true });
mkdirSync("./data", { recursive: true });

const sqlite = openDatabase(PATH);
const db = drizzle(sqlite);
migrate(db, { migrationsFolder: "./drizzle" });

const SCRYFALL_ID = "0000a54c-a511-4925-92dc-01b937f9ef21";
const now = new Date();

db.insert(printings)
  .values({
    scryfallId: SCRYFALL_ID,
    oracleId: "56719f6a-1a6c-4c0a-8d21-18f7d7350b68",
    name: "Black Lotus",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "232",
    imageUri: "https://example.invalid/lotus.jpg",
    finishes: ["nonfoil"],
    updatedAt: now,
  })
  .run();

// JSON round-trips as a real array, not a string.
const printing = db.select().from(printings).get()!;
assert.deepEqual(printing.finishes, ["nonfoil"]);
assert.equal(printing.name, "Black Lotus");

db.insert(holdings)
  .values({
    printingId: SCRYFALL_ID,
    quantity: 2,
    finish: "nonfoil",
    condition: "NM",
    dateAdded: "2026-01-15",
    createdAt: now,
  })
  .run();

const holding = db.select().from(holdings).get()!;
assert.equal(holding.quantity, 2);
assert.equal(holding.priceOverrideCents, null);

db.insert(priceSnapshots)
  .values({
    printingId: SCRYFALL_ID,
    finish: "nonfoil",
    date: "2026-01-15",
    priceCents: 1_234_500,
    source: "scryfall",
    estimated: false,
  })
  .run();

// The boolean column round-trips as a boolean, not 0/1.
const snapshot = db.select().from(priceSnapshots).get()!;
assert.equal(snapshot.estimated, false);
assert.equal(snapshot.priceCents, 1_234_500);

// Idempotent ingest: re-inserting the same (printing, finish, date) is
// rejected, and onConflictDoUpdate overwrites in place rather than duplicating.
assert.throws(
  () =>
    db
      .insert(priceSnapshots)
      .values({
        printingId: SCRYFALL_ID,
        finish: "nonfoil",
        date: "2026-01-15",
        priceCents: 999,
        source: "mtgjson",
      })
      .run(),
  /UNIQUE constraint failed/,
);

db.insert(priceSnapshots)
  .values({
    printingId: SCRYFALL_ID,
    finish: "nonfoil",
    date: "2026-01-15",
    priceCents: 1_300_000,
    source: "scryfall",
  })
  .onConflictDoUpdate({
    target: [priceSnapshots.printingId, priceSnapshots.finish, priceSnapshots.date],
    set: { priceCents: 1_300_000 },
  })
  .run();

assert.equal(db.select().from(priceSnapshots).all().length, 1);
assert.equal(db.select().from(priceSnapshots).get()!.priceCents, 1_300_000);

// Same printing and date but a different finish is a distinct price.
db.insert(priceSnapshots)
  .values({
    printingId: SCRYFALL_ID,
    finish: "foil",
    date: "2026-01-15",
    priceCents: 5_000_000,
    source: "scryfall",
  })
  .run();
assert.equal(db.select().from(priceSnapshots).all().length, 2);

// Foreign keys are actually enforced (they are off by default in SQLite).
assert.throws(
  () =>
    db
      .insert(holdings)
      .values({
        printingId: "does-not-exist",
        quantity: 1,
        finish: "nonfoil",
        condition: "NM",
        dateAdded: "2026-01-15",
        createdAt: now,
      })
      .run(),
  /FOREIGN KEY constraint failed/,
);

db.insert(unpricedPrintings)
  .values({
    printingId: SCRYFALL_ID,
    finish: "etched",
    reason: "no usd_etched price from any source",
    lastCheckedAt: now,
  })
  .run();

db.insert(syncMeta)
  .values({ key: "scryfall_bulk_updated_at", value: now.toISOString(), updatedAt: now })
  .run();

const meta = db
  .select()
  .from(syncMeta)
  .where(eq(syncMeta.key, "scryfall_bulk_updated_at"))
  .get()!;
assert.equal(meta.value, now.toISOString());

// A targeted price lookup — the shape the valuation query will use.
const price = db
  .select()
  .from(priceSnapshots)
  .where(
    and(
      eq(priceSnapshots.printingId, SCRYFALL_ID),
      eq(priceSnapshots.finish, "nonfoil"),
      eq(priceSnapshots.date, "2026-01-15"),
    ),
  )
  .get()!;
assert.equal(price.priceCents, 1_300_000);

sqlite.close();
rmSync(PATH, { force: true });
rmSync(`${PATH}-wal`, { force: true });
rmSync(`${PATH}-shm`, { force: true });

console.log("Schema smoke test passed.");
