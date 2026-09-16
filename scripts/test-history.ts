/**
 * Tests the like-for-like portfolio index.
 *
 * The methodology is the whole point of this module, so most of these assert
 * that a composition change does *not* move the index — the failure mode the
 * raw series has and the one a reader cannot see.
 *
 *   npm run test:history
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";

import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { openDatabase } from "@/db/client";
import { holdings, priceSnapshots, printings } from "@/db/schema";
import { portfolioSeries } from "@/db/queries/valuation";
import { rebuildPortfolioCache } from "@/db/queries/portfolio-cache";
import { portfolioHistory } from "@/db/queries/history";

import {
  type IndexPoint,
  type MonthLink,
  annualChanges,
  chainBackward,
  extremes,
  highWaterMark,
  maxDrawdown,
  monthlyChanges,
  monthsBetween,
} from "@/lib/portfolio-history";

const link = (
  month: string,
  fromCents: number,
  toCents: number,
  compared = 10,
  excluded = 0,
): MonthLink => ({
  month,
  date: `${month}-28`,
  prevDate: `${prevMonth(month)}-28`,
  fromCents,
  toCents,
  compared,
  excluded,
});

function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

const point = (month: string, valueCents: number): IndexPoint => ({
  month,
  date: `${month}-28`,
  valueCents,
  compared: 10,
});

// --- spans ---

assert.equal(monthsBetween("2024-01", "2024-03"), 2);
assert.equal(monthsBetween("2023-11", "2024-02"), 3);
assert.equal(monthsBetween("2024-05", "2024-05"), 0);

// --- chaining ---

// Two 10% rises from an anchor of 121 must put the start at 100.
const chained = chainBackward(
  [link("2024-02", 100, 110), link("2024-03", 110, 121)],
  { month: "2024-03", date: "2024-03-28", valueCents: 121 },
);
assert.equal(chained.length, 3);
assert.deepEqual(
  chained.map((p) => p.month),
  ["2024-01", "2024-02", "2024-03"],
);
assert.deepEqual(
  chained.map((p) => p.valueCents),
  [100, 110, 121],
);

// The anchor is preserved exactly. It is the one value a reader will check
// against the dashboard, so it must not be the product of chained ratios.
assert.equal(chained[chained.length - 1].valueCents, 121);

// THE POINT OF THE WHOLE MODULE: a link whose basket is larger in absolute
// terms, but which moved by the same ratio, must produce the same index move.
// This is the case the raw constant-basket series gets wrong — it would read
// the extra cards as growth.
const grown = chainBackward(
  [link("2024-02", 100, 110), link("2024-03", 5_000, 5_500, 80)],
  { month: "2024-03", date: "2024-03-28", valueCents: 121 },
);
assert.deepEqual(
  grown.map((p) => p.valueCents),
  [100, 110, 121],
  "a link measured over a bigger basket must not change the index",
);

// A worthless later end would mean dividing by zero. The chain stops rather
// than inventing what came before it.
const broken = chainBackward(
  [link("2024-02", 100, 0), link("2024-03", 0, 50)],
  { month: "2024-03", date: "2024-03-28", valueCents: 50 },
);
assert.deepEqual(
  broken.map((p) => p.month),
  ["2024-02", "2024-03"],
);

// --- calendar years ---

const points = [
  point("2022-12", 1_000),
  point("2023-06", 1_500),
  point("2023-12", 2_000),
  point("2024-12", 1_600),
  point("2025-03", 1_800),
];

const years = annualChanges(points);
// 2022 has nothing before it to measure from and is omitted rather than
// reported as a partial year.
assert.deepEqual(
  years.map((y) => y.label),
  ["2023", "2024", "2025"],
);
assert.equal(years[0].fromCents, 1_000);
assert.equal(years[0].toCents, 2_000);
assert.equal(years[0].changeRatio, 1);
// A year is measured from the previous year's END, not from its own first
// point — using 2023-06 here would report 2023 as +33% instead of +100%.
assert.equal(years[0].fromDate, "2022-12-28");
assert.equal(years[1].changeCents, -400);

// The current year is a partial return and must be flagged, or it wins "best
// year" on nine months against everyone else's twelve without saying so.
assert.equal(years[0].partial, false, "2023 ends in December");
assert.equal(years[2].partial, true, "2025 ends in March");

const yearExtremes = extremes(years);
assert.equal(yearExtremes.best?.label, "2023");
assert.equal(yearExtremes.worst?.label, "2024");

// A zero starting value yields no ratio rather than Infinity, and is skipped
// when ranking.
const fromZero = annualChanges([point("2023-12", 0), point("2024-12", 500)]);
assert.equal(fromZero[0].changeRatio, null);
assert.equal(extremes(fromZero).best, null);

// --- months ---

assert.equal(monthlyChanges(points).length, points.length - 1);
assert.equal(monthlyChanges(points)[0].label, "2023-06");

// --- drawdown ---

const dd = maxDrawdown([
  point("2024-01", 1_000),
  point("2024-02", 1_200),
  point("2024-03", 900),
  point("2024-04", 1_100),
  point("2024-05", 1_300),
]);
assert.ok(dd);
assert.equal(dd.peakDate, "2024-02-28");
assert.equal(dd.troughDate, "2024-03-28");
assert.equal(dd.depthCents, 300);
assert.equal(Math.round(dd.depthRatio * 100), 25);
assert.equal(dd.monthsToTrough, 1);
// Recovery is the first point back at the PEAK, not the first rise off the
// trough — 2024-04 is higher than the trough but still below 1,200.
assert.equal(dd.recoveredDate, "2024-05-28");
assert.equal(dd.monthsToRecover, 2);

// Ranked by ratio, not dollars. The 50% fall from 1,000 is the worse episode
// even though the 20% fall from 10,000 is a bigger number.
const byRatio = maxDrawdown([
  point("2024-01", 1_000),
  point("2024-02", 500),
  point("2024-03", 10_000),
  point("2024-04", 8_000),
]);
assert.equal(byRatio?.troughDate, "2024-02-28");
assert.equal(Math.round(byRatio!.depthRatio * 100), 50);

// Still underwater: no recovery date, and no month count implying one.
const underwater = maxDrawdown([
  point("2024-01", 1_000),
  point("2024-02", 600),
  point("2024-03", 700),
]);
assert.equal(underwater?.recoveredDate, null);
assert.equal(underwater?.monthsToRecover, null);

// A line that only ever rises has no drawdown to report.
assert.equal(
  maxDrawdown([point("2024-01", 100), point("2024-02", 200)]),
  null,
);
assert.equal(maxDrawdown([point("2024-01", 100)]), null);

// --- high-water mark ---

const high = highWaterMark([
  point("2024-01", 1_000),
  point("2024-02", 1_500),
  point("2024-03", 1_200),
]);
assert.equal(high?.valueCents, 1_500);
assert.equal(high?.monthsSince, 1);
assert.equal(Math.round(high!.belowRatio * 100), 20);

// At a new high, the distance below it is zero rather than negative.
const atHigh = highWaterMark([point("2024-01", 100), point("2024-02", 200)]);
assert.equal(atHigh?.belowRatio, 0);
assert.equal(atHigh?.monthsSince, 0);

// --- links built from a real database ---

// The pure functions above assume the links are right. This checks the rule
// that actually produces them: a holding priced on only one end of a step is
// excluded from BOTH ends, so a card arriving in the data cannot read as a
// gain. That is the bug the whole module exists to avoid, and it lives in the
// query rather than in the maths.

const PATH = "./data/test-history.db";
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

let seq = 0;
function addCard(prices: [string, number][]): number {
  seq += 1;
  const id = db
    .insert(printings)
    .values({
      scryfallId: `s${seq}`,
      oracleId: `o${seq}`,
      name: `Card ${seq}`,
      setCode: "tst",
      setName: "Test",
      collectorNumber: String(seq),
      finishes: ["nonfoil"],
      updatedAt: new Date(),
    })
    .returning({ id: printings.id })
    .all()[0].id;

  db.insert(holdings)
    .values({
      printingKey: id,
      finish: "nonfoil",
      quantity: 1,
      condition: "NM",
      dateAdded: "2026-01-01",
      createdAt: new Date(),
    })
    .run();

  if (prices.length > 0) {
    db.insert(priceSnapshots)
      .values(
        prices.map(([date, priceCents]) => ({
          printingKey: id,
          finish: "nonfoil" as const,
          date,
          priceCents,
          source: "mtgjson" as const,
        })),
      )
      .run();
  }
  return id;
}

// Priced across all three months, and doubles in February.
addCard([
  ["2026-01-31", 100],
  ["2026-02-28", 200],
  ["2026-03-31", 200],
]);
// Only appears in March — a newly printed card. It must not make February or
// March look like growth.
addCard([["2026-03-31", 10_000]]);

const series = portfolioSeries(db, { constantBasket: true, monthLinks: true });
assert.ok(series.links);
assert.deepEqual(
  series.links.map((l) => l.month),
  ["2026-02", "2026-03"],
);

const feb = series.links[0];
assert.equal(feb.fromCents, 100);
assert.equal(feb.toCents, 200);
assert.equal(feb.compared, 1);
// The March-only card is excluded from February, where it has no price at
// either end.
assert.equal(feb.excluded, 1);

const mar = series.links[1];
// THE KEY ASSERTION. The $100 card is flat in March, so the step is flat —
// even though the raw basket leaps from $200 to $10,200 as the second card
// appears. Without the both-ends rule this link would read +5000%.
assert.equal(mar.fromCents, 200);
assert.equal(mar.toCents, 200);
assert.equal(mar.compared, 1);
assert.equal(mar.excluded, 1);

// And the same through the cache, which is how the page reads it.
const built = rebuildPortfolioCache(db);
assert.equal(built.months, 4, "two links, for each of two vendors");

const history = portfolioHistory(db);
assert.ok(history);
// Anchored on the real basket value: $200 + $10,000.
assert.equal(
  history.points[history.points.length - 1].valueCents,
  10_200,
);
// Working back, March was flat and February doubled, so January's basket is
// half of March's — NOT the $100 the raw series would show.
assert.deepEqual(
  history.points.map((p) => p.valueCents),
  [5_100, 10_200, 10_200],
);

sqlite.close();
cleanup();

console.log("History tests passed.");
