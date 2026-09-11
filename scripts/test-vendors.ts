/**
 * Tests the multi-vendor and buylist queries.
 *
 *   npm run test:vendors
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { openDatabase } from "@/db/client";
import { countHoldings } from "@/db/queries/holdings";
import {
  collectionByVendor,
  hasVendorData,
  vendorQuotes,
  vendorSeries,
} from "@/db/queries/vendors";
import { and, eq } from "drizzle-orm";

import { holdings, priceSnapshots, printings, vendorPrices } from "@/db/schema";

const PATH = "./data/test-vendors.db";
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

assert.equal(hasVendorData(db), false);

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
      finishes: ["nonfoil"],
      updatedAt: new Date(),
    })
    .returning({ id: printings.id })
    .all()[0].id;

const ALPHA = printing("1", "Alpha");
const BETA = printing("2", "Beta");

db.insert(holdings)
  .values([
    {
      printingKey: ALPHA,
      quantity: 2,
      finish: "nonfoil",
      condition: "NM",
      dateAdded: "2026-01-01",
      source: "moxfield",
      createdAt: new Date(),
    },
    {
      printingKey: BETA,
      quantity: 1,
      finish: "nonfoil",
      condition: "NM",
      dateAdded: "2026-01-01",
      source: "moxfield",
      createdAt: new Date(),
    },
  ])
  .run();

// TCGplayer retail lives in price_snapshots — the canonical series the
// portfolio is valued from — and is deliberately not copied into
// vendor_prices. Every query below has to reunite the two tables, so seeding
// them separately is what actually exercises the union.
db.insert(priceSnapshots)
  .values([
    // Two days, so "latest" has to pick the later one.
    { printingKey: ALPHA, finish: "nonfoil", date: "2026-01-01", priceCents: 900, source: "mtgjson" },
    { printingKey: ALPHA, finish: "nonfoil", date: "2026-01-02", priceCents: 1_000, source: "mtgjson" },
    // Beta is quoted by TCGplayer only, so other vendors cover less than all.
    { printingKey: BETA, finish: "nonfoil", date: "2026-01-02", priceCents: 500, source: "mtgjson" },
  ])
  .run();

db.insert(vendorPrices)
  .values([
    { printingKey: ALPHA, finish: "nonfoil", vendor: "cardkingdom", side: "retail", date: "2026-01-02", priceCents: 1_200 },
    { printingKey: ALPHA, finish: "nonfoil", vendor: "cardkingdom", side: "buylist", date: "2026-01-02", priceCents: 600 },
    // TCGplayer's buylist ended in 2022 and is no longer a series the app
    // reports. A stray row must be ignored rather than surfaced as a quote --
    // the archive still contains them, so this is the realistic case.
    { printingKey: ALPHA, finish: "nonfoil", vendor: "tcgplayer", side: "buylist", date: "2026-01-02", priceCents: 700 },
  ])
  .run();

assert.equal(hasVendorData(db), true);

// --- per-card quotes ---
const quotes = vendorQuotes(db, ALPHA, "nonfoil");
// tcgplayer retail (from price_snapshots) plus Card Kingdom's two sides.
assert.equal(quotes.length, 3);

const tcg = quotes.find((q) => q.vendor === "tcgplayer" && q.side === "retail")!;
// The later day wins, not the first or the cheapest.
assert.equal(tcg.priceCents, 1_000);
assert.equal(tcg.date, "2026-01-02");

// Card Kingdom is the only buylist reported; the stray TCGplayer row is not.
const buylists = new Map(
  quotes.filter((q) => q.side === "buylist").map((q) => [q.vendor, q]),
);
assert.equal(buylists.size, 1);
assert.equal(buylists.get("cardkingdom")!.priceCents, 600);
assert.ok(
  !buylists.has("tcgplayer"),
  "a discontinued series must not be quoted, however recent its stored date",
);

// A finish with no vendor data returns nothing rather than another finish's.
assert.equal(vendorQuotes(db, ALPHA, "foil").length, 0);

// --- collection totals ---
const totals = collectionByVendor(db);

const byKey = new Map(totals.map((row) => [`${row.vendor}.${row.side}`, row]));

// 2 Alpha at 1,000 plus 1 Beta at 500.
const tcgTotal = byKey.get("tcgplayer.retail")!;
assert.equal(tcgTotal.totalCents, 2 * 1_000 + 500);
assert.equal(tcgTotal.covered, 2);
assert.equal(tcgTotal.missing, 0);

// Card Kingdom quotes only Alpha, so its total spans one holding of the two.
const ckTotal = byKey.get("cardkingdom.retail")!;
assert.equal(ckTotal.totalCents, 2 * 1_200);
assert.equal(ckTotal.covered, 1);
assert.equal(
  ckTotal.missing,
  1,
  "a vendor that quotes part of the collection must report the shortfall",
);

// The discontinued series contributes no total either, even though a row for
// it sits in the table.
assert.equal(byKey.has("tcgplayer.buylist"), false);

// Retail rows sort before buylist ones, so the ordering never reads a
// what-you-pay figure against a what-you-get one.
const sideOrder = totals.map((row) => row.side);
assert.deepEqual(
  sideOrder,
  [...sideOrder].sort((a, b) => (a === b ? 0 : a === "retail" ? -1 : 1)),
  "retail rows must group before buylist rows",
);

// --- the union must not double-count ---

// The regression this guards: vendor_prices is meant to hold only what
// price_snapshots does not, but the archive ingest wrote TCGplayer retail to
// both. Every held card was then counted twice and the collection's TCGplayer
// total read $27,484 against a real $15,187. Coverage above the holding count
// is the signature, so assert on it directly -- a total alone looks plausible
// and would not have failed.
db.insert(vendorPrices)
  .values([
    // Exactly the mistake: the canonical series, written here as well.
    { printingKey: ALPHA, finish: "nonfoil", vendor: "tcgplayer", side: "retail", date: "2026-01-02", priceCents: 999 },
  ])
  .run();

const doubled = collectionByVendor(db);
const tcgRetailRows = doubled.filter(
  (row) => row.vendor === "tcgplayer" && row.side === "retail",
);
assert.equal(
  tcgRetailRows.length,
  1,
  "a vendor and side must yield exactly one row, not one per source table",
);
for (const row of doubled) {
  assert.ok(
    row.covered <= countHoldings(db),
    `${row.vendor}.${row.side} covers ${row.covered} of ${countHoldings(db)} holdings -- a series counted twice`,
  );
}

db.delete(vendorPrices)
  .where(
    and(
      eq(vendorPrices.printingKey, ALPHA),
      eq(vendorPrices.vendor, "tcgplayer"),
      eq(vendorPrices.side, "retail"),
    ),
  )
  .run();

// --- series ---
const series = vendorSeries(db, ALPHA, "nonfoil", "tcgplayer", "retail");
assert.deepEqual(
  series.map((point) => point.date),
  ["2026-01-01", "2026-01-02"],
);
assert.equal(series[0].priceCents, 900);

// The same call shape reads the other table without the caller knowing.
assert.deepEqual(
  vendorSeries(db, ALPHA, "nonfoil", "cardkingdom", "buylist"),
  [{ date: "2026-01-02", priceCents: 600 }],
);
assert.equal(
  vendorSeries(db, BETA, "nonfoil", "cardkingdom", "retail").length,
  0,
);

sqlite.close();
cleanup();

console.log("Vendor tests passed.");
