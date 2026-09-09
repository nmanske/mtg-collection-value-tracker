/**
 * Tests the CSV reader and the Moxfield importer against a scratch database.
 *
 *   npm run test:import
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { openDatabase } from "@/db/client";
import { listHoldings } from "@/db/queries/holdings";
import { printings } from "@/db/schema";
import { parseCsv, parseCsvTable } from "@/import/csv";
import { importMoxfieldCsv } from "@/import/moxfield";

// -------------------------------------------------------------- csv reader ---

assert.deepEqual(parseCsv("a,b\n1,2"), [
  ["a", "b"],
  ["1", "2"],
]);

// A comma inside a quoted field — "Jace, the Mind Sculptor" is the reason this
// parser exists rather than a split(",").
assert.deepEqual(parseCsv('1,"Jace, the Mind Sculptor",wwk'), [
  ["1", "Jace, the Mind Sculptor", "wwk"],
]);

// Doubled quotes are one literal quote.
assert.deepEqual(parseCsv('1,"Ach! Hans, ""Run!""",unh'), [
  ["1", 'Ach! Hans, "Run!"', "unh"],
]);

// A newline inside a quoted field does not end the row.
assert.deepEqual(parseCsv('1,"line one\nline two",x'), [
  ["1", "line one\nline two", "x"],
]);

// CRLF, as Moxfield exports on Windows.
assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [
  ["a", "b"],
  ["1", "2"],
]);

// A UTF-8 BOM must not become part of the first header name.
assert.deepEqual(parseCsv("﻿Count,Name\n1,Forest"), [
  ["Count", "Name"],
  ["1", "Forest"],
]);

// A trailing newline does not create a phantom empty row.
assert.equal(parseCsv("a,b\n1,2\n").length, 2);

// An empty quoted field is still a field.
assert.deepEqual(parseCsv('1,"",x'), [["1", "", "x"]]);

// Split cards keep their separator.
assert.deepEqual(parseCsv("1,Fire // Ice,apc"), [["1", "Fire // Ice", "apc"]]);

// Ragged rows are reported, not silently mis-aligned.
const ragged = parseCsvTable("a,b,c\n1,2,3\n4,5\n6,7,8");
assert.equal(ragged.rows.length, 2);
assert.equal(ragged.errors.length, 1);
assert.equal(ragged.errors[0].line, 3);

// ---------------------------------------------------------------- fixtures ---

const PATH = "./data/test-import.db";
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

db.insert(printings)
  .values([
    {
      scryfallId: "p1",
      oracleId: "o1",
      name: "Forest",
      setCode: "blb",
      setName: "Bloomburrow",
      collectorNumber: "280",
      finishes: ["nonfoil", "foil"],
      updatedAt: new Date(),
    },
    {
      scryfallId: "p2",
      oracleId: "o2",
      name: "Jace, the Mind Sculptor",
      setCode: "wwk",
      setName: "Worldwake",
      collectorNumber: "31",
      finishes: ["nonfoil"],
      updatedAt: new Date(),
    },
    {
      scryfallId: "p3",
      oracleId: "o3",
      name: "Fire // Ice",
      setCode: "apc",
      setName: "Apocalypse",
      collectorNumber: "128",
      finishes: ["nonfoil"],
      updatedAt: new Date(),
    },
  ])
  .run();

const HEADER =
  "Count,Tradelist Count,Name,Edition,Condition,Language,Foil,Tags,Last Modified,Collector Number,Alter,Proxy,Purchase Price";

const row = (
  count: string,
  name: string,
  edition: string,
  condition: string,
  foil: string,
  number: string,
  language = "English",
) =>
  `${count},0,"${name}",${edition},${condition},${language},${foil},,2026-01-01,${number},False,False,`;

// ------------------------------------------------------------ happy import ---

const csv = [
  HEADER,
  row("4", "Forest", "blb", "Near Mint", "", "280"),
  row("1", "Forest", "blb", "Excellent", "foil", "280"),
  row("2", "Jace, the Mind Sculptor", "wwk", "Good", "", "31"),
  row("1", "Fire // Ice", "apc", "Played", "", "128"),
].join("\r\n");

const dry = importMoxfieldCsv(db, csv, { dryRun: true, dateAdded: "2026-09-09" });
assert.equal(dry.dataRows, 4);
assert.equal(dry.importedRows, 4);
assert.equal(dry.importedCards, 8);
assert.equal(dry.problems.length, 0);
// A dry run writes nothing.
assert.equal(listHoldings(db).rows.length, 0);

// The mapping report is what makes the two uncertain columns auditable.
const conditions = Object.fromEntries(
  dry.conditionsSeen.map((entry) => [entry.raw, entry.mappedTo]),
);
assert.equal(conditions["near mint"], "NM");
assert.equal(conditions["excellent"], "LP");
assert.equal(conditions["good"], "MP");
assert.equal(conditions["played"], "MP");

const finishes = Object.fromEntries(
  dry.finishesSeen.map((entry) => [entry.raw, entry.mappedTo]),
);
// An empty Foil column is a normal card, not a missing value.
assert.equal(finishes[""], "nonfoil");
assert.equal(finishes["foil"], "foil");

const real = importMoxfieldCsv(db, csv, { dateAdded: "2026-09-09" });
assert.equal(real.importedRows, 4);
const after = listHoldings(db);
assert.equal(after.rows.length, 4);
assert.equal(after.totalCards, 8);
// Every row gets the import date, since Moxfield's export has no acquisition
// date and Last Modified is its own edit timestamp.
assert.ok(after.rows.every((holding) => holding.dateAdded === "2026-09-09"));

// Duplicate rows in the same file merge rather than creating two holdings.
const dupe = importMoxfieldCsv(
  db,
  [HEADER, row("3", "Forest", "blb", "Near Mint", "", "280")].join("\n"),
  { dateAdded: "2026-09-09" },
);
assert.equal(dupe.mergedRows, 1);
assert.equal(listHoldings(db).rows.length, 4);
assert.equal(listHoldings(db).totalCards, 11);

// ------------------------------------------------------------- unhappy rows ---

const problems = importMoxfieldCsv(
  db,
  [
    HEADER,
    row("1", "Forest", "zzz", "Near Mint", "", "999"), // unknown set
    row("0", "Forest", "blb", "Near Mint", "", "280"), // non-positive count
    row("x", "Forest", "blb", "Near Mint", "", "280"), // non-numeric count
    row("1", "Jace, the Mind Sculptor", "wwk", "Near Mint", "foil", "31"), // no foil printing
    row("1", "Forest", "blb", "Near Mint", "shiny", "280"), // unknown Foil value
    row("1", "Nonesuch", "blb", "Near Mint", "", "9999"), // name unknown in that set
  ].join("\n"),
  { dryRun: true },
);

assert.equal(problems.importedRows, 0);
assert.equal(problems.problems.length, 6);
assert.match(problems.problems[0].reason, /No paper printings are known for set ZZZ/);
assert.match(problems.problems[1].reason, /Count is "0"/);
assert.match(problems.problems[2].reason, /Count is "x"/);
assert.match(problems.problems[3].reason, /was not printed in foil/);
assert.match(problems.problems[4].reason, /Unrecognised Foil value "shiny"/);
assert.match(problems.problems[5].reason, /No printing found for BLB 9999/);
// A set we do stock reports a per-row miss; a set we do not stock reports the
// set. Confirmed against a real export, where 23 rows were MTGO-only sets
// (VMA, TPR) rather than bad data.
assert.deepEqual(problems.unknownSets, [{ setCode: "zzz", rows: 1 }]);
// Every problem carries the line number so it can be found in the file.
assert.deepEqual(
  problems.problems.map((problem) => problem.line),
  [2, 3, 4, 5, 6, 7],
);

// A bad collector number does NOT silently resolve when the set holds several
// printings of that name — the usual case for basic lands. It is reported as
// ambiguous rather than guessed at.
db.insert(printings)
  .values({
    scryfallId: "p4",
    oracleId: "o1",
    name: "Forest",
    setCode: "blb",
    setName: "Bloomburrow",
    collectorNumber: "281",
    finishes: ["nonfoil"],
    updatedAt: new Date(),
  })
  .run();

const ambiguous = importMoxfieldCsv(
  db,
  [HEADER, row("1", "Forest", "blb", "Near Mint", "", "9999")].join("\n"),
  { dryRun: true },
);
assert.equal(ambiguous.importedRows, 0);
assert.match(ambiguous.problems[0].reason, /Several printings in BLB are named "Forest"/);

// An unrecognised condition defaults to NM rather than losing the row, but is
// still reported.
const oddCondition = importMoxfieldCsv(
  db,
  [HEADER, row("1", "Forest", "blb", "Pristine", "", "280")].join("\n"),
  { dryRun: true },
);
assert.equal(oddCondition.importedRows, 1);
assert.equal(
  oddCondition.conditionsSeen.find((entry) => entry.raw === "pristine")?.mappedTo,
  null,
);

// A wrong collector number still resolves when the name is unambiguous in that
// set — deterministic, and reported separately for review.
const byName = importMoxfieldCsv(
  db,
  [HEADER, row("1", "Jace, the Mind Sculptor", "wwk", "Near Mint", "", "31a")].join("\n"),
  { dryRun: true },
);
assert.equal(byName.importedRows, 1);
assert.equal(byName.resolvedByName.length, 1);
assert.match(byName.resolvedByName[0].reason, /matched "Jace, the Mind Sculptor" by name/);

// Moxfield exports double-faced cards under the front face alone.
const frontFace = importMoxfieldCsv(
  db,
  [HEADER, row("1", "Fire", "apc", "Near Mint", "", "128z")].join("\n"),
  { dryRun: true },
);
assert.equal(frontFace.importedRows, 1);
assert.equal(frontFace.resolvedByName.length, 1);

// A file that is not a Moxfield export fails loudly rather than importing junk.
assert.throws(
  () => importMoxfieldCsv(db, "Name,Qty\nForest,4", { dryRun: true }),
  /Not a Moxfield collection export/,
);

// Column order and casing must not matter.
const reordered = importMoxfieldCsv(
  db,
  ["collector number,NAME,Count,Edition,Foil,Condition", "280,Forest,2,blb,,Near Mint"].join("\n"),
  { dryRun: true },
);
assert.equal(reordered.importedRows, 1);
assert.equal(reordered.importedCards, 2);

sqlite.close();
cleanup();

console.log("Import tests passed.");
