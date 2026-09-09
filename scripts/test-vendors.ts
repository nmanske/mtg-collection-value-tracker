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
import { holdings, printings, vendorPrices } from "@/db/schema";

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

db.insert(vendorPrices)
  .values([
    // Two days, so "latest" has to pick the later one.
    { printingKey: ALPHA, finish: "nonfoil", vendor: "tcgplayer", side: "retail", date: "2026-01-01", priceCents: 900, currency: "USD" },
    { printingKey: ALPHA, finish: "nonfoil", vendor: "tcgplayer", side: "retail", date: "2026-01-02", priceCents: 1_000, currency: "USD" },
    { printingKey: ALPHA, finish: "nonfoil", vendor: "cardkingdom", side: "retail", date: "2026-01-02", priceCents: 1_200, currency: "USD" },
    { printingKey: ALPHA, finish: "nonfoil", vendor: "cardkingdom", side: "buylist", date: "2026-01-02", priceCents: 600, currency: "USD" },
    // Cardmarket quotes euros — this must never join a dollar total.
    { printingKey: ALPHA, finish: "nonfoil", vendor: "cardmarket", side: "retail", date: "2026-01-02", priceCents: 800, currency: "EUR" },
    // Beta is quoted by TCGplayer only, so other vendors cover less than all.
    { printingKey: BETA, finish: "nonfoil", vendor: "tcgplayer", side: "retail", date: "2026-01-02", priceCents: 500, currency: "USD" },
  ])
  .run();

assert.equal(hasVendorData(db), true);

// --- per-card quotes ---
const quotes = vendorQuotes(db, ALPHA, "nonfoil");
assert.equal(quotes.length, 4);

const tcg = quotes.find((q) => q.vendor === "tcgplayer" && q.side === "retail")!;
// The later day wins, not the first or the cheapest.
assert.equal(tcg.priceCents, 1_000);
assert.equal(tcg.date, "2026-01-02");
assert.equal(tcg.currency, "USD");

const euro = quotes.find((q) => q.vendor === "cardmarket")!;
assert.equal(euro.currency, "EUR", "cardmarket must carry its own currency");

const buylist = quotes.find((q) => q.side === "buylist")!;
assert.equal(buylist.vendor, "cardkingdom");
assert.equal(buylist.priceCents, 600);

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

// The euro total is its own figure, never folded into a dollar one.
const cmTotal = byKey.get("cardmarket.retail")!;
assert.equal(cmTotal.currency, "EUR");
assert.equal(cmTotal.totalCents, 2 * 800);

const usdRetail = totals.filter(
  (row) => row.currency === "USD" && row.side === "retail",
);
assert.ok(
  !usdRetail.some((row) => row.totalCents === cmTotal.totalCents),
  "the EUR total must not appear among the USD ones",
);

// Currencies are grouped so the ordering never implies a cross-currency rank.
const currencyOrder = totals.map((row) => row.currency);
assert.deepEqual(
  currencyOrder,
  [...currencyOrder].sort((a, b) => (a === b ? 0 : a === "USD" ? -1 : 1)),
  "USD rows must group before EUR rows",
);

// --- series ---
const series = vendorSeries(db, ALPHA, "nonfoil", "tcgplayer", "retail");
assert.deepEqual(
  series.map((point) => point.date),
  ["2026-01-01", "2026-01-02"],
);
assert.equal(series[0].priceCents, 900);
assert.equal(
  vendorSeries(db, ALPHA, "nonfoil", "manapool", "retail").length,
  0,
);

sqlite.close();
cleanup();

console.log("Vendor tests passed.");
