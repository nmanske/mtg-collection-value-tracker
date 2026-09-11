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
import {
  collectionByVendor,
  hasVendorData,
  vendorQuotes,
  vendorSeries,
} from "@/db/queries/vendors";
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
    // TCGplayer's buylist exists only in archived MTGJSON builds. It belongs
    // in vendor_prices even though its retail counterpart does not.
    { printingKey: ALPHA, finish: "nonfoil", vendor: "tcgplayer", side: "buylist", date: "2026-01-02", priceCents: 700 },
  ])
  .run();

assert.equal(hasVendorData(db), true);

// --- per-card quotes ---
const quotes = vendorQuotes(db, ALPHA, "nonfoil");
// tcgplayer retail + tcgplayer buylist + cardkingdom retail + cardkingdom
// buylist, gathered from both tables.
assert.equal(quotes.length, 4);

const tcg = quotes.find((q) => q.vendor === "tcgplayer" && q.side === "retail")!;
// The later day wins, not the first or the cheapest.
assert.equal(tcg.priceCents, 1_000);
assert.equal(tcg.date, "2026-01-02");

// Both vendors' buylists surface, including TCGplayer's archive-only one.
const buylists = new Map(
  quotes.filter((q) => q.side === "buylist").map((q) => [q.vendor, q]),
);
assert.equal(buylists.size, 2);
assert.equal(buylists.get("cardkingdom")!.priceCents, 600);
assert.equal(buylists.get("tcgplayer")!.priceCents, 700);

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

// TCGplayer's buylist total comes from vendor_prices while its retail total
// comes from price_snapshots: the split is invisible to the caller.
const tcgBuylist = byKey.get("tcgplayer.buylist")!;
assert.equal(tcgBuylist.totalCents, 2 * 700);
assert.equal(tcgBuylist.covered, 1);

// Retail rows sort before buylist ones, so the ordering never reads a
// what-you-pay figure against a what-you-get one.
const sideOrder = totals.map((row) => row.side);
assert.deepEqual(
  sideOrder,
  [...sideOrder].sort((a, b) => (a === b ? 0 : a === "retail" ? -1 : 1)),
  "retail rows must group before buylist rows",
);

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
