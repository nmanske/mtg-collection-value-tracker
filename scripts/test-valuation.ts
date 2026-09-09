/**
 * Tests portfolio valuation over time against a hand-checkable fixture.
 *
 *   npm run test:valuation
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { openDatabase } from "@/db/client";
import {
  portfolioSeries,
  portfolioSummary,
  portfolioValueAt,
  priceDates,
} from "@/db/queries/valuation";
import { holdings, priceSnapshots, printings } from "@/db/schema";

const PATH = "./data/test-valuation.db";
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

const printing = (scryfallId: string, name: string) =>
  db
    .insert(printings)
    .values({
      scryfallId,
      oracleId: `oracle-${scryfallId}`,
      name,
      setCode: "tst",
      setName: "Test",
      collectorNumber: scryfallId,
      finishes: ["nonfoil", "foil"],
      updatedAt: new Date(),
    })
    .returning({ id: printings.id })
    .all()[0].id;

const ALPHA = printing("1", "Alpha Card");
const BETA = printing("2", "Beta Card");
const GHOST = printing("3", "Never Priced");

// ALPHA is priced on 01, 02 and 05 — deliberately missing 03 and 04, which is
// the gap that a naive date-join would value at zero.
db.insert(priceSnapshots)
  .values([
    { printingKey: ALPHA, finish: "nonfoil", date: "2026-01-01", priceCents: 100, source: "mtgjson" },
    { printingKey: ALPHA, finish: "nonfoil", date: "2026-01-02", priceCents: 200, source: "mtgjson" },
    { printingKey: ALPHA, finish: "nonfoil", date: "2026-01-05", priceCents: 500, source: "scryfall" },
    // BETA's history starts late: nothing exists before the 3rd.
    { printingKey: BETA, finish: "nonfoil", date: "2026-01-03", priceCents: 1_000, source: "mtgjson" },
    { printingKey: BETA, finish: "nonfoil", date: "2026-01-04", priceCents: 1_100, source: "mtgjson" },
    { printingKey: BETA, finish: "nonfoil", date: "2026-01-05", priceCents: 1_200, source: "scryfall" },
    // A foil series for the same printing must not be mixed with the non-foil.
    { printingKey: ALPHA, finish: "foil", date: "2026-01-05", priceCents: 9_999, source: "scryfall" },
  ])
  .run();

// The date axis comes from the price table, not from a calendar.
assert.deepEqual(priceDates(db), [
  "2026-01-01",
  "2026-01-02",
  "2026-01-03",
  "2026-01-04",
  "2026-01-05",
]);

// An empty collection is worth nothing on every date, rather than producing an
// empty chart.
const empty = portfolioSeries(db);
assert.equal(empty.points.length, 5);
assert.ok(empty.points.every((point) => point.valueCents === 0));

// --- holdings ---
const addHolding = (
  printingKey: number,
  quantity: number,
  dateAdded: string,
  finish: "nonfoil" | "foil" = "nonfoil",
  priceOverrideCents: number | null = null,
) =>
  db
    .insert(holdings)
    .values({
      printingKey,
      quantity,
      finish,
      condition: "NM",
      dateAdded,
      priceOverrideCents,
      createdAt: new Date(),
    })
    .returning({ id: holdings.id })
    .all()[0].id;

// 2 Alpha held from the very start.
addHolding(ALPHA, 2, "2026-01-01");

const alphaOnly = portfolioSeries(db).points;
assert.deepEqual(
  alphaOnly.map((point) => point.valueCents),
  [
    200, // 2 x 100
    400, // 2 x 200
    400, // no snapshot on the 3rd: the price carries forward, not to zero
    400, // still carried
    1_000, // 2 x 500
  ],
);
assert.ok(alphaOnly.every((point) => point.holdingsHeld === 1));
assert.ok(alphaOnly.every((point) => point.unpricedHoldings === 0));

// A holding acquired mid-window contributes nothing before its date.
addHolding(BETA, 1, "2026-01-04");

const withBeta = portfolioSeries(db).points;
assert.deepEqual(
  withBeta.map((point) => point.valueCents),
  [200, 400, 400, 400 + 1_100, 1_000 + 1_200],
);
assert.deepEqual(
  withBeta.map((point) => point.holdingsHeld),
  [1, 1, 1, 2, 2],
);

// A holding older than its printing's price history contributes nothing until
// that history starts — the v1 truncate rule — and is reported as unpriced
// rather than silently counted as zero.
const oldBeta = addHolding(BETA, 10, "2026-01-01");
const truncated = portfolioSeries(db).points;
assert.deepEqual(
  truncated.map((point) => point.unpricedHoldings),
  [1, 1, 0, 0, 0],
);
assert.deepEqual(
  truncated.map((point) => point.holdingsHeld),
  [2, 2, 2, 3, 3],
);
assert.equal(truncated[0].valueCents, 200); // the 10 Beta add nothing yet
assert.equal(truncated[2].valueCents, 400 + 10 * 1_000);
db.delete(holdings).where(eq(holdings.id, oldBeta)).run();

// Finishes are valued from their own series, never each other's.
const foil = addHolding(ALPHA, 1, "2026-01-01", "foil");
const withFoil = portfolioSeries(db).points;
// The foil series only starts on the 5th, so it adds nothing before then.
assert.equal(withFoil[0].valueCents, 200);
assert.equal(withFoil[4].valueCents, 1_000 + 1_200 + 9_999);
db.delete(holdings).where(eq(holdings.id, foil)).run();

// A printing with no price data at all never contributes, and is counted.
const ghost = addHolding(GHOST, 5, "2026-01-01");
const withGhost = portfolioSeries(db).points;
assert.deepEqual(
  withGhost.map((point) => point.valueCents),
  [200, 400, 400, 400 + 1_100, 1_000 + 1_200],
);
assert.ok(withGhost.every((point) => point.unpricedHoldings === 1));

// A manual override prices it for the whole life of the holding, including
// dates before any snapshot exists.
db.update(holdings)
  .set({ priceOverrideCents: 7 })
  .where(eq(holdings.id, ghost))
  .run();
const overridden = portfolioSeries(db).points;
assert.deepEqual(
  overridden.map((point) => point.valueCents),
  [200 + 35, 400 + 35, 400 + 35, 400 + 1_100 + 35, 1_000 + 1_200 + 35],
);
assert.ok(overridden.every((point) => point.unpricedHoldings === 0));
db.delete(holdings).where(eq(holdings.id, ghost)).run();

// --- point lookups and ranges ---
assert.equal(portfolioValueAt(db, "2026-01-03")?.valueCents, 400);
assert.equal(portfolioValueAt(db, "2026-01-05")?.valueCents, 2_200);

// A range still carries prices forward from before its start: asking for the
// 3rd onwards must not forget Alpha's price from the 2nd.
const ranged = portfolioSeries(db, { from: "2026-01-03" });
assert.deepEqual(
  ranged.points.map((point) => point.date),
  ["2026-01-03", "2026-01-04", "2026-01-05"],
);
assert.equal(ranged.points[0].valueCents, 400);

// --- acquisition marks ---

// The chart marks the days cards arrived, because a rising line has two
// unrelated causes and one of them is invisible otherwise.
const marked = portfolioSeries(db).points;
assert.deepEqual(
  marked.map((point) => point.acquiredHoldings),
  // Alpha on the 1st, Beta on the 4th; nothing on the other days.
  [1, 0, 0, 1, 0],
);
assert.deepEqual(
  marked.map((point) => point.acquiredCards),
  // Quantities, not holdings: 2 Alpha and 1 Beta.
  [2, 0, 0, 1, 0],
);

// Every date carries the field, so a zero is a real zero rather than absent —
// which is what lets the chart draw no mark instead of a floor-height one.
assert.ok(
  marked.every((point) => typeof point.acquiredHoldings === "number"),
);

// --- constant basket ---

// The basket ignores acquisition dates: today's holdings are valued across the
// whole window, so the movement is prices alone rather than prices plus buying.
const basket = portfolioSeries(db, { constantBasket: true }).points;
const asHeld = portfolioSeries(db).points;

// Beta was acquired on the 4th, so as-held counts it only from then...
assert.equal(asHeld[0].valueCents, 200);
assert.deepEqual(
  asHeld.map((point) => point.holdingsHeld),
  [1, 1, 1, 2, 2],
);

// ...while the basket counts it on every date it has a price for.
assert.deepEqual(
  basket.map((point) => point.holdingsHeld),
  [2, 2, 2, 2, 2],
);

// Beta has no price before the 3rd, so it still contributes nothing then —
// the basket ignores acquisition dates, not missing prices.
assert.equal(basket[0].valueCents, 200);
assert.equal(basket[0].unpricedHoldings, 1);
// From the 3rd, Beta's price counts even though it was "acquired" on the 4th.
assert.equal(basket[2].valueCents, 400 + 1_000);
assert.equal(asHeld[2].valueCents, 400);

// Both series must agree on the final date: everything held today is in both.
assert.equal(
  basket.at(-1)!.valueCents,
  asHeld.at(-1)!.valueCents,
  "the two series must converge on the last date",
);

// --- summary ---
const summary = portfolioSummary(db);
assert.equal(summary.currentCents, 2_200);
assert.equal(summary.currentDate, "2026-01-05");
// One day back is the 4th: 1,500.
assert.equal(summary.day.fromCents, 1_500);
assert.equal(summary.day.changeCents, 700);
// All-time runs back to the first point, 200.
assert.equal(summary.allTime.fromCents, 200);
assert.equal(summary.allTime.changeCents, 2_000);
assert.equal(summary.allTime.changeRatio, 10);
// A window longer than the history reports nothing rather than a wrong number.
assert.equal(summary.week.fromCents, null);
assert.equal(summary.month.changeCents, null);

// The prices-only figure is the basket's all-time change, which is smaller
// than the headline whenever cards were acquired during the window.
assert.equal(summary.basketPoints.length, 5);
assert.equal(summary.marketOnly.fromCents, basket[0].valueCents);
assert.equal(
  summary.marketOnly.changeCents,
  basket.at(-1)!.valueCents - basket[0].valueCents,
);
// The general invariant, rather than a strict inequality that happens to hold
// only when the not-yet-acquired cards are priced at the start: the basket
// contains everything the as-held series contains, plus cards bought later, so
// it can never be worth less on any date.
summary.basketPoints.forEach((point, index) => {
  assert.ok(
    point.valueCents >= summary.points[index].valueCents,
    `basket must not be below as-held on ${point.date}`,
  );
});

sqlite.close();
cleanup();

console.log("Valuation tests passed.");
