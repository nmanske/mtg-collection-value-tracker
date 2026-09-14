/**
 * Tests CSV serialisation and the export datasets.
 *
 *   npm run test:export
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { openDatabase } from "@/db/client";
import { holdings, printings, priceSnapshots, vendorPrices } from "@/db/schema";
import {
  csvCell,
  csvRow,
  exportFilename,
  moneyCell,
  UTF8_BOM,
} from "@/export/csv";
import { EXPORTS, EXPORT_ORDER, isExportId } from "@/export/datasets";
import { parseCsvTable } from "@/import/csv";

// ------------------------------------------------------------ serialisation ---

assert.equal(csvCell("Forest"), "Forest");
assert.equal(csvCell(null), "");
assert.equal(csvCell(undefined), "");
assert.equal(csvCell(42), "42");

// The reason this exists: card names contain commas.
assert.equal(
  csvCell("Jace, the Mind Sculptor"),
  '"Jace, the Mind Sculptor"',
);
// Quotes are doubled, per RFC 4180.
assert.equal(csvCell('Ach! Hans, "Run!"'), '"Ach! Hans, ""Run!"""');
// A newline inside a field keeps the field, not the row, intact.
assert.equal(csvCell("line one\nline two"), '"line one\nline two"');

// A leading =, +, - or @ makes a spreadsheet evaluate the cell as a formula.
// Neutralised so an exported note cannot execute on open.
assert.equal(csvCell("=1+1"), "'=1+1");
assert.equal(csvCell("+A1"), "'+A1");
assert.equal(csvCell("-1/-1"), "'-1/-1");
assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
// A minus that is part of a number still needs the guard; the value survives.
assert.equal(csvCell("-5.00"), "'-5.00");
// Ordinary text is untouched.
assert.equal(csvCell("Fire // Ice"), "Fire // Ice");

assert.equal(csvRow(["a", "b"]), "a,b\r\n");
assert.equal(csvRow([1, null, "x,y"]), '1,,"x,y"\r\n');

assert.equal(moneyCell(123_450), "1234.50");
assert.equal(moneyCell(5), "0.05");
assert.equal(moneyCell(0), "0.00");
assert.equal(moneyCell(null), "");
assert.equal(moneyCell(undefined), "");
assert.equal(moneyCell(-250), "-2.50");

assert.match(exportFilename("collection", new Date("2026-09-09T12:00:00Z")), /^collection-2026-09-09\.csv$/);

assert.equal(isExportId("collection"), true);
assert.equal(isExportId("nonsense"), false);

// ---------------------------------------------------------------- fixtures ---

const PATH = "./data/test-export.db";
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

const [comma] = db
  .insert(printings)
  .values({
    scryfallId: "s1",
    oracleId: "o1",
    // Deliberately awkward: a comma, to prove quoting survives the round trip.
    name: "Jace, the Mind Sculptor",
    setCode: "wwk",
    setName: "Worldwake",
    collectorNumber: "31",
    finishes: ["nonfoil"],
    updatedAt: new Date(),
  })
  .returning({ id: printings.id })
  .all();

db.insert(holdings)
  .values({
    printingKey: comma.id,
    quantity: 3,
    finish: "nonfoil",
    condition: "NM",
    dateAdded: "2026-01-01",
    source: "moxfield",
    createdAt: new Date(),
  })
  .run();

db.insert(priceSnapshots)
  .values([
    { printingKey: comma.id, finish: "nonfoil", date: "2026-01-01", priceCents: 1_000, source: "mtgjson" },
    { printingKey: comma.id, finish: "nonfoil", date: "2026-01-02", priceCents: 1_200, source: "scryfall" },
  ])
  .run();

db.insert(vendorPrices)
  .values([
    { printingKey: comma.id, finish: "nonfoil", vendor: "cardkingdom", side: "retail", date: "2026-01-02", priceCents: 1_500 },
    { printingKey: comma.id, finish: "nonfoil", vendor: "cardkingdom", side: "buylist", date: "2026-01-02", priceCents: 700 },
  ])
  .run();

const render = (id: (typeof EXPORT_ORDER)[number]) =>
  [...EXPORTS[id].stream(db)].join("");

// ------------------------------------------------------------- collection ---

const collectionCsv = render("collection");
assert.ok(collectionCsv.startsWith(UTF8_BOM), "must start with a BOM for Excel");
assert.equal(EXPORTS.collection.rows(db), 1);

const collection = parseCsvTable(collectionCsv);
assert.equal(collection.rows.length, 1);
assert.equal(collection.errors.length, 0, "the export must re-parse cleanly");

const byName = Object.fromEntries(
  collection.header.map((name, i) => [name, collection.rows[0][i]]),
);
// The comma in the name survives serialise and re-parse.
assert.equal(byName.name, "Jace, the Mind Sculptor");
assert.equal(byName.quantity, "3");
// The latest tracked price, not the first.
assert.equal(byName.unit_price_usd, "12.00");
assert.equal(byName.value_usd, "36.00");
assert.equal(byName.price_source, "scryfall");
// Vendors are columns, every one of them labelled USD.
assert.equal(byName.cardkingdom_retail_usd, "15.00");
// Each price carries the date it came from, so a stale quote does not export
// looking identical to a current one.
assert.equal(byName.cardkingdom_retail_date, "2026-01-02");
assert.equal(byName.cardkingdom_buylist_usd, "7.00");
// TCGplayer retail is read from price_snapshots rather than vendor_prices, so
// its column proves the export spans both tables.
assert.equal(byName.tcgplayer_retail_usd, "12.00");
// A vendor and side with no data is blank, never zero.
assert.equal(byName.tcgplayer_buylist_usd, "");
assert.equal(byName.tcgplayer_buylist_date, "", "no price means no date");

// Whether an acquisition date is a floor rather than a fact travels with the
// export: without it, 539 inferred holdings read as 539 cards bought that day.
assert.equal(byName.date_added_inferred, "no");

sqlite
  .prepare("update holdings set date_added_approx = 1")
  .run();
const reparsed = parseCsvTable(render("collection"));
const inferredRow = Object.fromEntries(
  reparsed.header.map((name, i) => [name, reparsed.rows[0][i]]),
);
assert.equal(inferredRow.date_added_inferred, "yes");
sqlite.prepare("update holdings set date_added_approx = 0").run();

// A manual override replaces the tracked price and says so.
db.update(holdings).set({ priceOverrideCents: 5_000 }).run();
const overridden = parseCsvTable(render("collection"));
const overriddenRow = Object.fromEntries(
  overridden.header.map((name, i) => [name, overridden.rows[0][i]]),
);
assert.equal(overriddenRow.unit_price_usd, "50.00");
assert.equal(overriddenRow.price_source, "manual");
assert.equal(overriddenRow.manual_override_usd, "50.00");
db.update(holdings).set({ priceOverrideCents: null }).run();

// ----------------------------------------------------------- value history ---

const history = parseCsvTable(render("value-history"));
assert.equal(history.rows.length, 2, "one row per date with price data");
assert.deepEqual(history.header.slice(0, 3), [
  "date",
  "value_as_held_usd",
  "value_fixed_basket_usd",
]);
assert.equal(history.rows[0][0], "2026-01-01");
assert.equal(history.rows[0][1], "30.00");
assert.equal(history.rows[1][1], "36.00");
assert.equal(EXPORTS["value-history"].rows(db), 2);

// The per-card daily price series was removed: providers' terms forbid
// repackaging their data as a standalone feed, and an export emitting one row
// per card per day is exactly that. Assert it stays gone rather than trusting
// that nobody adds it back.
assert.deepEqual(EXPORT_ORDER, ["collection", "value-history"]);
assert.equal(isExportId("price-history"), false);
assert.ok(
  !Object.keys(EXPORTS).includes("price-history"),
  "the raw price-series export must not come back",
);

// Both remaining exports describe the collection, so neither can grow with the
// price tables: one row per holding and one row per date.
assert.ok(EXPORTS.collection.rows(db) <= 10);
assert.ok(EXPORTS["value-history"].rows(db) <= 10);

sqlite.close();
cleanup();

console.log("Export tests passed.");
