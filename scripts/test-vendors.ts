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
import { countHoldings, listHoldings } from "@/db/queries/holdings";
import { FINISH_CODES } from "@/db/codec";
import {
  collectionByVendor,
  hasVendorData,
  latestQuotesFor,
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

// --- stale quotes ---

// A shop that stops listing a card keeps its last price forever. Counting it
// in a total presents a price nobody would honour as today's, so it is
// excluded -- but the card page still shows it, because "last quoted three
// years ago" beats showing nothing for a single card.
const GAMMA = printing("3", "Gamma");
db.insert(holdings)
  .values({
    printingKey: GAMMA,
    quantity: 5,
    finish: "nonfoil",
    condition: "NM",
    dateAdded: "2026-01-01",
    source: "moxfield",
    createdAt: new Date(),
  })
  .run();
db.insert(priceSnapshots)
  .values({ printingKey: GAMMA, finish: "nonfoil", date: "2026-01-02", priceCents: 100, source: "mtgjson" })
  .run();
db.insert(vendorPrices)
  .values([
    // Well past the cutoff relative to Card Kingdom's newest date (2026-01-02).
    { printingKey: GAMMA, finish: "nonfoil", vendor: "cardkingdom", side: "retail", date: "2023-05-01", priceCents: 9_900 },
  ])
  .run();

const withStale = new Map(
  collectionByVendor(db).map((row) => [`${row.vendor}.${row.side}`, row]),
);
const ckRetailNow = withStale.get("cardkingdom.retail")!;
assert.equal(ckRetailNow.stale, 1, "the delisted card is counted as stale");
assert.equal(
  ckRetailNow.totalCents,
  2 * 1_200,
  "a stale price must not reach the total, however large",
);
assert.ok(
  !String(ckRetailNow.totalCents).includes("9900"),
  "sanity: the $99 stale price is nowhere in the sum",
);
// Stale holdings are missing from the total, so coverage must say so rather
// than counting them as served.
assert.equal(ckRetailNow.covered, 1);
assert.equal(ckRetailNow.missing, countHoldings(db) - ckRetailNow.covered);

// The series that is fully current reports no stale rows at all.
assert.equal(withStale.get("tcgplayer.retail")!.stale, 0);

// On a card page the same quote is shown, flagged rather than hidden.
const gammaQuotes = vendorQuotes(db, GAMMA, "nonfoil");
const gammaCk = gammaQuotes.find((q) => q.vendor === "cardkingdom")!;
assert.equal(gammaCk.priceCents, 9_900);
assert.equal(gammaCk.stale, true, "an old quote is marked, not dropped");
// And a current one is not flagged.
assert.equal(
  vendorQuotes(db, ALPHA, "nonfoil").find((q) => q.vendor === "cardkingdom")!
    .stale,
  false,
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

// --- batch quotes, for lists of printings ---
const batch = latestQuotesFor(
  db,
  [
    { printingKey: ALPHA, finish: "nonfoil" },
    { printingKey: BETA, finish: "nonfoil" },
  ],
  "cardkingdom",
);
assert.deepEqual(batch.get(`${ALPHA}.${FINISH_CODES.nonfoil}`), {
  retailCents: 1_200,
  buylistCents: 600,
});
// Beta is TCGplayer-only, so Card Kingdom has nothing to say about it — and
// says nothing, rather than reporting a zero.
assert.equal(batch.get(`${BETA}.${FINISH_CODES.nonfoil}`), undefined);
assert.equal(latestQuotesFor(db, [], "cardkingdom").size, 0);

// The TCGplayer buylist row seeded above is not a series the app reports, and
// must not reappear here through the union.
const tcgBatch = latestQuotesFor(
  db,
  [{ printingKey: ALPHA, finish: "nonfoil" }],
  "tcgplayer",
);
assert.deepEqual(tcgBatch.get(`${ALPHA}.${FINISH_CODES.nonfoil}`), {
  retailCents: 1_000,
  buylistCents: null,
});

// --- the collection table follows the vendor ---
const tcgRows = listHoldings(db, { vendor: "tcgplayer" }).rows;
const alphaTcg = tcgRows.find((row) => row.printingKey === ALPHA)!;
assert.equal(alphaTcg.unitPriceCents, 1_000);
// Not asked for, so not read: null here means "not requested", not "unquoted".
assert.equal(alphaTcg.buylistCents, null);

const ckRows = listHoldings(db, {
  vendor: "cardkingdom",
  buylist: true,
}).rows;
const alphaCk = ckRows.find((row) => row.printingKey === ALPHA)!;
assert.equal(alphaCk.unitPriceCents, 1_200, "unit follows the selected vendor");
assert.equal(alphaCk.buylistCents, 600);
// Card Kingdom does not quote Beta at all, on either side.
const betaCk = ckRows.find((row) => row.printingKey === BETA)!;
assert.equal(betaCk.unitPriceCents, null);
assert.equal(betaCk.buylistCents, null);

// Sorting reads the same price expression, so it follows the vendor too.
const byUnit = (vendor: "tcgplayer" | "cardkingdom") =>
  listHoldings(db, { vendor, sort: "unit", dir: "desc" }).rows.map(
    (row) => row.printingKey,
  );
// Alpha (1,000) beats Beta (500) at TCGplayer and Gamma (100) trails both.
assert.deepEqual(byUnit("tcgplayer"), [ALPHA, BETA, GAMMA]);
// At Card Kingdom, Gamma's delisted 9,900 leads and Beta has no quote at all,
// so it sorts last rather than first. A row shows a stale price where a total
// excludes it: the table is the card page's answer, not the portfolio's.
assert.deepEqual(byUnit("cardkingdom"), [GAMMA, ALPHA, BETA]);

sqlite.close();
cleanup();

console.log("Vendor tests passed.");
