/**
 * Tests the collection statistics.
 *
 *   npm run test:stats
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { openDatabase } from "@/db/client";
import { collectionStats } from "@/db/queries/stats";
import { holdings, priceSnapshots, printings, vendorPrices } from "@/db/schema";

const PATH = "./data/test-stats.db";
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${PATH}${suffix}`, { force: true });
  }
};
cleanup();
mkdirSync("./data", { recursive: true });

const sqlite = openDatabase(PATH);
const db = drizzle(sqlite);
migrate(db, { migrationsFolder: "./drizzle" });

let counter = 0;
function card(name: string, setCode: string, oracleId = `o${counter}`) {
  counter += 1;
  return db
    .insert(printings)
    .values({
      scryfallId: `s${counter}`,
      oracleId,
      name,
      setCode,
      setName: setCode.toUpperCase(),
      collectorNumber: String(counter),
      finishes: ["nonfoil"],
      updatedAt: new Date(),
    })
    .returning({ id: printings.id })
    .all()[0].id;
}

const hold = (
  printingKey: number,
  quantity: number,
  dateAdded = "2026-01-01",
) =>
  db
    .insert(holdings)
    .values({
      printingKey,
      quantity,
      finish: "nonfoil",
      condition: "NM",
      dateAdded,
      source: "moxfield",
      createdAt: new Date(),
    })
    .run();

const price = (printingKey: number, date: string, cents: number) =>
  db
    .insert(priceSnapshots)
    .values({
      printingKey,
      finish: "nonfoil",
      date,
      priceCents: cents,
      source: "mtgjson",
    })
    .run();

// A cheap card that doubles: a big percentage on a trivial amount of money.
const penny = card("Penny", "aaa");
hold(penny, 1);
price(penny, "2026-01-01", 4);
price(penny, "2026-01-05", 12);

// A real riser, held in quantity so its collection impact is large.
const riser = card("Riser", "bbb");
hold(riser, 4, "2026-02-01");
price(riser, "2026-01-01", 500);
price(riser, "2026-01-05", 900);

// A faller whose history starts late, as a newly released set's does.
const faller = card("Faller", "ccc");
hold(faller, 1);
price(faller, "2026-01-03", 2_000);
price(faller, "2026-01-05", 200);

// The expensive one, with a Card Kingdom spread.
const chase = card("Chase", "ddd");
hold(chase, 1);
price(chase, "2026-01-01", 9_000);
price(chase, "2026-01-05", 10_000);
db.insert(vendorPrices)
  .values([
    { printingKey: chase, finish: "nonfoil", vendor: "cardkingdom", side: "retail", date: "2026-01-05", priceCents: 12_000, currency: "USD" },
    { printingKey: chase, finish: "nonfoil", vendor: "cardkingdom", side: "buylist", date: "2026-01-05", priceCents: 6_000, currency: "USD" },
    // Below the spread floor, so it must not appear in either spread list.
    { printingKey: riser, finish: "nonfoil", vendor: "cardkingdom", side: "retail", date: "2026-01-05", priceCents: 900, currency: "USD" },
    { printingKey: riser, finish: "nonfoil", vendor: "cardkingdom", side: "buylist", date: "2026-01-05", priceCents: 100, currency: "USD" },
  ])
  .run();

// Two printings of one card, to prove copies group by oracle id.
const solA = card("Sol Ring", "eee", "sol");
const solB = card("Sol Ring", "fff", "sol");
hold(solA, 3);
hold(solB, 2);
price(solA, "2026-01-05", 200);
price(solB, "2026-01-05", 150);

const stats = collectionStats(db);

// --- totals ---
// 12 + 4x900 + 200 + 10000 + 3x200 + 2x150 = 14,712
assert.equal(stats.totalValueCents, 12 + 3_600 + 200 + 10_000 + 600 + 300);
assert.equal(stats.totalCards, 1 + 4 + 1 + 1 + 3 + 2);
assert.equal(stats.totalHoldings, 6);
assert.equal(stats.distinctSets, 6);

// --- movers ---
// The penny card doubled but is below the floor, so it is not a "riser".
assert.ok(
  !stats.gainers.some((mover) => mover.name === "Penny"),
  "a card under the floor must not appear as a mover, however large the %",
);
assert.equal(stats.gainers[0].name, "Riser");
assert.equal(stats.gainers[0].fromCents, 500);
assert.equal(stats.gainers[0].toCents, 900);
assert.equal(stats.gainers[0].changeRatio, 0.8);

assert.equal(stats.losers[0].name, "Faller");
// Movement runs from the card's own first tracked day, not a global start.
assert.equal(stats.losers[0].fromDate, "2026-01-03");
assert.equal(stats.losers[0].changeRatio, -0.9);

// Impact is change times quantity: the riser moved less per card than the
// faller but is held four times over.
assert.equal(stats.biggestGains[0].name, "Riser");
assert.equal(stats.biggestGains[0].impactCents, 400 * 4);
assert.equal(stats.biggestLosses[0].name, "Faller");
assert.equal(stats.biggestLosses[0].impactCents, -1_800);
// The lists are one-sided: a gain never appears among the losses.
assert.ok(stats.biggestGains.every((mover) => mover.impactCents > 0));
assert.ok(stats.biggestLosses.every((mover) => mover.impactCents < 0));

// --- shape ---
assert.equal(stats.mostValuable[0].name, "Chase");
assert.equal(stats.mostValuable[0].priceCents, 10_000);
assert.equal(stats.cheapest?.name, "Penny");

// Copies group across printings: 3 + 2 Sol Rings are one entry of 5.
const sol = stats.mostCopies.find((row) => row.name === "Sol Ring");
assert.equal(sol?.quantity, 5);

// Chase alone is more than half the value, so half sits in one holding.
assert.equal(stats.holdingsForHalfValue, 1);
assert.equal(stats.underOneDollar, 1); // the penny card

// --- spreads ---
// Only the card above the floor qualifies, even though both have a spread.
assert.equal(stats.bestSpreads.length, 1);
assert.equal(stats.bestSpreads[0].name, "Chase");
assert.equal(stats.bestSpreads[0].ratio, 0.5);
assert.ok(
  !stats.bestSpreads.some((row) => row.name === "Riser"),
  "a cheap card must not reach the spread lists — the shop's floor price dominates the ratio",
);

// The sell-everything total covers every card Card Kingdom quotes, including
// the cheap one the spread lists exclude: the floor filters which spreads are
// worth reading, not which cards can be sold. Both sides span the same
// holdings, so the ratio compares like with like.
assert.equal(stats.buylistTotalCents, 6_000 + 100 * 4);
assert.equal(stats.buylistRetailCents, 12_000 + 900 * 4);
assert.equal(stats.buylistCoverage, 2 / 6);

// --- composition ---
assert.equal(stats.topSets[0].setCode, "ddd");
assert.equal(stats.topSets[0].valueCents, 10_000);
assert.equal(stats.acquisitions.length, 2);
assert.deepEqual(
  stats.acquisitions.map((month) => month.month),
  ["2026-01", "2026-02"],
);
assert.equal(stats.firstAcquired, "2026-01-01");
assert.equal(stats.lastAcquired, "2026-02-01");

sqlite.close();
cleanup();

console.log("Stats tests passed.");
