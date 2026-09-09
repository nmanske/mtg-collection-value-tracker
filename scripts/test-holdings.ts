/**
 * Tests the add-holding input parser and the collection queries against a
 * scratch database. The query modules take their database as an argument
 * precisely so this can run outside a Next.js request.
 *
 *   npm run test:holdings
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { openDatabase } from "@/db/client";
import {
  addHolding,
  countHoldings,
  listHoldings,
  removeHolding,
} from "@/db/queries/holdings";
import { getPrinting, searchPrintings } from "@/db/queries/printings";
import { holdings, priceSnapshots, printings } from "@/db/schema";
import {
  MAX_QUANTITY,
  type PrintingConstraint,
  parseHoldingInput,
  todayIso,
} from "@/lib/holding-input";

const TODAY = "2026-09-09";

// ---------------------------------------------------------------- parser ---

const SOL_RING: PrintingConstraint = {
  name: "Sol Ring",
  setCode: "c21",
  finishes: ["nonfoil", "foil"],
};
const LOTUS: PrintingConstraint = {
  name: "Black Lotus",
  setCode: "lea",
  finishes: ["nonfoil"],
};

const valid = {
  printingKey: "1",
  quantity: "2",
  finish: "nonfoil",
  condition: "NM",
  dateAdded: "2026-01-15",
};

const accepted = parseHoldingInput(valid, SOL_RING, TODAY);
assert.equal(accepted.ok, true);
assert.deepEqual(accepted.ok && accepted.value, {
  printingKey: 1,
  quantity: 2,
  finish: "nonfoil",
  condition: "NM",
  dateAdded: "2026-01-15",
});

/** Asserts the input is rejected, and hands back the message for matching. */
function rejection(
  overrides: Partial<typeof valid>,
  printing: PrintingConstraint | null = SOL_RING,
): string {
  const result = parseHoldingInput({ ...valid, ...overrides }, printing, TODAY);
  assert.equal(
    result.ok,
    false,
    `expected rejection for ${JSON.stringify(overrides)}`,
  );
  return result.ok === false ? result.message : "";
}

// A printing that is not in the database is rejected.
assert.match(rejection({}, null), /not in the database/);
assert.match(rejection({ printingKey: "0" }), /Invalid card/);
assert.match(rejection({ printingKey: "abc" }), /Invalid card/);
assert.match(rejection({ printingKey: "1.5" }), /Invalid card/);

// A finish the printing was never made in would be permanently unpriced.
assert.match(rejection({ finish: "foil" }, LOTUS), /was not printed in foil/);
assert.match(rejection({ finish: "holographic" }), /Invalid finish/);
assert.match(rejection({ finish: "" }), /Invalid finish/);
assert.match(rejection({ condition: "MINT" }), /Invalid condition/);

assert.match(rejection({ quantity: "0" }), /between 1 and/);
assert.match(rejection({ quantity: "-3" }), /between 1 and/);
assert.match(rejection({ quantity: "1.5" }), /between 1 and/);
assert.match(rejection({ quantity: String(MAX_QUANTITY + 1) }), /between 1 and/);
assert.equal(
  parseHoldingInput(
    { ...valid, quantity: String(MAX_QUANTITY) },
    SOL_RING,
    TODAY,
  ).ok,
  true,
);

assert.match(rejection({ dateAdded: "15/01/2026" }), /YYYY-MM-DD/);
assert.match(rejection({ dateAdded: "2026-13-45" }), /YYYY-MM-DD/);
// A future date would leave the holding contributing nothing until it arrived.
assert.match(rejection({ dateAdded: "2026-09-10" }), /cannot be in the future/);
assert.equal(
  parseHoldingInput({ ...valid, dateAdded: TODAY }, SOL_RING, TODAY).ok,
  true,
);

// An empty date defaults to today rather than failing.
const defaulted = parseHoldingInput(
  { ...valid, dateAdded: "" },
  SOL_RING,
  TODAY,
);
assert.equal(defaulted.ok && defaulted.value.dateAdded, TODAY);

// Dates are UTC, matching how snapshots are filed.
assert.equal(todayIso(new Date("2026-09-09T23:58:00Z")), "2026-09-09");

// ------------------------------------------------------------- collection ---

const PATH = "./data/test-holdings.db";
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

const [priced] = db
  .insert(printings)
  .values({
    scryfallId: "aaaa1111-0000-0000-0000-000000000001",
    oracleId: "oracle-1",
    name: "Sol Ring",
    setCode: "c21",
    setName: "Commander 2021",
    collectorNumber: "263",
    finishes: ["nonfoil", "foil"],
    updatedAt: new Date(),
  })
  .returning({ id: printings.id })
  .all();

const [unpriced] = db
  .insert(printings)
  .values({
    scryfallId: "bbbb2222-0000-0000-0000-000000000002",
    oracleId: "oracle-2",
    name: "Black Lotus",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "232",
    finishes: ["nonfoil"],
    updatedAt: new Date(),
  })
  .returning({ id: printings.id })
  .all();

db.insert(priceSnapshots)
  .values([
    // Two days for the same series, so "latest" has to pick the later one.
    { printingKey: priced.id, finish: "nonfoil", date: "2026-09-08", priceCents: 150, source: "mtgjson" },
    { printingKey: priced.id, finish: "nonfoil", date: "2026-09-09", priceCents: 189, source: "scryfall" },
    { printingKey: priced.id, finish: "foil", date: "2026-09-09", priceCents: 640, source: "scryfall" },
  ])
  .run();

// --- search ---
const found = searchPrintings(db, "sol ring");
assert.equal(found.length, 1);
assert.equal(found[0].id, priced.id);
// Latest price per finish, not the first or the cheapest.
assert.equal(found[0].prices.find((p) => p.finish === "nonfoil")?.priceCents, 189);
assert.equal(found[0].prices.find((p) => p.finish === "foil")?.priceCents, 640);

// The unpriced printing is findable but carries no prices.
assert.equal(searchPrintings(db, "black lotus")[0].prices.length, 0);

// Substring matching, and the too-short guard.
assert.equal(searchPrintings(db, "ring").length, 1);
assert.equal(searchPrintings(db, "s").length, 0);
assert.equal(searchPrintings(db, "  ").length, 0);

// set + collector number addresses one exact printing.
assert.equal(searchPrintings(db, "c21 263")[0].id, priced.id);
assert.equal(searchPrintings(db, "c21/263")[0].id, priced.id);
// A set/number that matches nothing falls through to a name search.
assert.equal(searchPrintings(db, "zzz 999").length, 0);

assert.equal(getPrinting(db, priced.id)?.name, "Sol Ring");
assert.equal(getPrinting(db, 99_999), null);

// --- adding ---
const first = addHolding(db, {
  printingKey: priced.id,
  quantity: 2,
  finish: "nonfoil",
  condition: "NM",
  dateAdded: "2026-09-01",
  createdAt: new Date(),
});
assert.equal(first.merged, false);

// Identical printing, finish, condition and date merges quantities.
const second = addHolding(db, {
  printingKey: priced.id,
  quantity: 3,
  finish: "nonfoil",
  condition: "NM",
  dateAdded: "2026-09-01",
  createdAt: new Date(),
});
assert.equal(second.merged, true);
assert.equal(second.id, first.id);
assert.equal(countHoldings(db), 1);

// A different acquisition date stays separate: date_added decides when a card
// starts contributing to the chart, so merging would backdate value.
assert.equal(
  addHolding(db, {
    printingKey: priced.id,
    quantity: 1,
    finish: "nonfoil",
    condition: "NM",
    dateAdded: "2026-09-05",
    createdAt: new Date(),
  }).merged,
  false,
);

// A different finish is separate, and prices independently.
addHolding(db, {
  printingKey: priced.id,
  quantity: 1,
  finish: "foil",
  condition: "NM",
  dateAdded: "2026-09-05",
  createdAt: new Date(),
});

addHolding(db, {
  printingKey: unpriced.id,
  quantity: 1,
  finish: "nonfoil",
  condition: "LP",
  dateAdded: "2026-09-05",
  createdAt: new Date(),
});

// --- valuation ---
const summary = listHoldings(db);
assert.equal(summary.rows.length, 4);
assert.equal(summary.totalCards, 5 + 1 + 1 + 1);

// The unpriced holding is reported, not counted as zero.
assert.equal(summary.unpricedCount, 1);
assert.equal(summary.totalValueCents, 5 * 189 + 1 * 189 + 1 * 640);

const lotusRow = summary.rows.find((row) => row.name === "Black Lotus")!;
assert.equal(lotusRow.unitPriceCents, null);
assert.equal(lotusRow.priceDate, null);

const foilRow = summary.rows.find((row) => row.finish === "foil")!;
assert.equal(foilRow.unitPriceCents, 640);
assert.equal(foilRow.priceDate, "2026-09-09");

// A manual override wins over any snapshot and restores the holding to the
// total — which is the point of having one.
db.update(holdings)
  .set({ priceOverrideCents: 2_500_000 })
  .where(eq(holdings.id, lotusRow.id))
  .run();

const overridden = listHoldings(db);
assert.equal(overridden.unpricedCount, 0);
assert.equal(
  overridden.totalValueCents,
  5 * 189 + 1 * 189 + 1 * 640 + 2_500_000,
);
const overriddenLotus = overridden.rows.find(
  (row) => row.name === "Black Lotus",
)!;
assert.equal(overriddenLotus.overridden, true);
assert.equal(overriddenLotus.unitPriceCents, 2_500_000);

// --- removal ---
assert.equal(removeHolding(db, first.id), true);
assert.equal(removeHolding(db, first.id), false);
assert.equal(countHoldings(db), 3);

sqlite.close();
cleanup();

console.log("Holdings tests passed.");
