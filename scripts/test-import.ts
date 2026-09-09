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
import { eq } from "drizzle-orm";
import { holdings, printings } from "@/db/schema";
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
  proxy = "False",
) =>
  `${count},0,"${name}",${edition},${condition},${language},${foil},,2026-01-01,${number},False,${proxy},`;

/** A row with a controllable Last Modified timestamp. */
const lmRow = (
  count: string,
  name: string,
  edition: string,
  number: string,
  lastModified: string,
) =>
  `${count},0,"${name}",${edition},Near Mint,English,,,${lastModified},${number},False,False,`;

/** A row flagged as a proxy in Moxfield's export. */
const proxyRow = (
  count: string,
  name: string,
  edition: string,
  number: string,
  flag = "True",
) =>
  `${count},0,"${name}",${edition},Near Mint,English,,,2026-01-01,${number},False,${flag},`;

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

// An import replaces the collection rather than adding to it, so a file
// listing one card leaves exactly that card. The reconciliation section below
// covers this properly; this asserts the default is replace, not append.
const narrower = importMoxfieldCsv(
  db,
  [HEADER, row("3", "Forest", "blb", "Near Mint", "", "280")].join("\n"),
  { dateAdded: "2026-09-09" },
);
assert.equal(narrower.reconciled?.removed, 3);
assert.equal(listHoldings(db).rows.length, 1);
assert.equal(listHoldings(db).totalCards, 3);

// ------------------------------------------------------------------- dates ---

// Start from an empty collection; the section above left holdings behind.
db.delete(holdings).run();

// Acquisition dates come from Last Modified by default. Without this the whole
// collection shares one date and the value chart is flat until the import day.
const datedCsv = [
  HEADER,
  lmRow("1", "Forest", "blb", "280", "2024-12-17 04:22:33.483000"),
  lmRow("1", "Jace, the Mind Sculptor", "wwk", "31", "2025-10-30 05:05:42.953000"),
  lmRow("1", "Fire // Ice", "apc", "128", "2026-01-28 02:18:06.483000"),
].join("\n");

const dated = importMoxfieldCsv(db, datedCsv, { dryRun: true });
assert.equal(dated.dateSource, "modified");
assert.equal(dated.datesFellBack, 0);
assert.equal(dated.earliestDate, "2024-12-17");
assert.equal(dated.latestDate, "2026-01-28");

// The time component is dropped: price snapshots are daily.
const written = importMoxfieldCsv(db, datedCsv, {});
assert.equal(written.importedRows, 3);
const holdingDates = listHoldings(db)
  .rows.map((holding) => holding.dateAdded)
  .sort();
assert.deepEqual(holdingDates, ["2024-12-17", "2025-10-30", "2026-01-28"]);
db.delete(holdings).run();

// --import-dates falls back to stamping every row with the import date.
const stamped = importMoxfieldCsv(db, datedCsv, {
  dryRun: true,
  dateSource: "import",
  dateAdded: "2026-09-09",
});
assert.equal(stamped.earliestDate, "2026-09-09");
assert.equal(stamped.latestDate, "2026-09-09");

// An explicit date overrides the column entirely.
const forced = importMoxfieldCsv(db, datedCsv, {
  dryRun: true,
  dateAdded: "2026-01-01",
});
assert.equal(forced.dateSource, "fixed");
assert.equal(forced.earliestDate, "2026-01-01");
assert.equal(forced.latestDate, "2026-01-01");

// A missing or unparseable timestamp falls back rather than failing the row,
// and the fallback is counted so it is visible.
const messy = importMoxfieldCsv(
  db,
  [
    HEADER,
    lmRow("1", "Forest", "blb", "280", ""),
    lmRow("1", "Jace, the Mind Sculptor", "wwk", "31", "not a date"),
  ].join("\n"),
  { dryRun: true, dateAdded: "2026-09-09" },
);
assert.equal(messy.importedRows, 2);

const fellBack = importMoxfieldCsv(
  db,
  [HEADER, lmRow("1", "Forest", "blb", "280", "garbage")].join("\n"),
  { dryRun: true },
);
assert.equal(fellBack.datesFellBack, 1);
assert.equal(fellBack.importedRows, 1);

// A future timestamp is clamped to today: a holding dated ahead of now would
// contribute nothing to the chart until that day arrived.
const future = importMoxfieldCsv(
  db,
  [HEADER, lmRow("1", "Forest", "blb", "280", "2099-01-01 00:00:00.000000")].join("\n"),
  { dryRun: true },
);
const todayIso = new Date().toISOString().slice(0, 10);
assert.equal(future.latestDate, todayIso);

// Two copies of the same card acquired on different days stay separate rows,
// so each starts contributing to the chart on its own date.
const twoDates = importMoxfieldCsv(
  db,
  [
    HEADER,
    lmRow("1", "Forest", "blb", "280", "2024-01-01 00:00:00.000000"),
    lmRow("1", "Forest", "blb", "280", "2025-01-01 00:00:00.000000"),
  ].join("\n"),
  {},
);
assert.equal(twoDates.mergedRows, 0);
assert.equal(listHoldings(db).rows.length, 2);
db.delete(holdings).run();

// ------------------------------------------------------------------ proxies ---

// Proxies are not the real card and carry none of its value, so they must not
// reach the collection. A real export was 631 of 4,356 rows.
const withProxies = importMoxfieldCsv(
  db,
  [
    HEADER,
    row("1", "Forest", "blb", "Near Mint", "", "280"),
    proxyRow("2", "Forest", "blb", "280"),
    proxyRow("1", "Jace, the Mind Sculptor", "wwk", "31"),
  ].join("\n"),
  { dryRun: true },
);
assert.equal(withProxies.importedRows, 1);
assert.equal(withProxies.importedCards, 1);
assert.equal(withProxies.proxyRowsSkipped, 2);
assert.equal(withProxies.proxyCardsSkipped, 3);
// A skipped proxy is not an error — it does not belong in the problem list.
assert.equal(withProxies.problems.length, 0);

// Lower case and other spellings of true are still proxies.
for (const flag of ["true", "TRUE", "yes", "1"]) {
  const report = importMoxfieldCsv(
    db,
    [HEADER, proxyRow("1", "Forest", "blb", "280", flag)].join("\n"),
    { dryRun: true },
  );
  assert.equal(report.proxyRowsSkipped, 1, `"${flag}" should count as a proxy`);
}

// False, and an empty cell, are real cards.
for (const flag of ["False", "false", "0", ""]) {
  const report = importMoxfieldCsv(
    db,
    [HEADER, proxyRow("1", "Forest", "blb", "280", flag)].join("\n"),
    { dryRun: true },
  );
  assert.equal(report.proxyRowsSkipped, 0, `"${flag}" should be a real card`);
  assert.equal(report.importedRows, 1);
}

// An unrecognised value imports the row but says so loudly, rather than
// silently dropping real cards if Moxfield changes the spelling.
const oddProxy = importMoxfieldCsv(
  db,
  [HEADER, proxyRow("1", "Forest", "blb", "280", "maybe")].join("\n"),
  { dryRun: true },
);
assert.equal(oddProxy.importedRows, 1);
assert.equal(oddProxy.proxyRowsSkipped, 0);
assert.match(oddProxy.problems[0].reason, /Unrecognised Proxy value "maybe"/);

// ----------------------------------------------------------- reconciliation ---

// The bug this whole mechanism exists for: an export is a snapshot of a whole
// collection, not a batch to append. Re-importing the same file used to double
// every holding.
db.delete(holdings).run();

const snapshot = [
  HEADER,
  lmRow("4", "Forest", "blb", "280", "2026-01-01 10:00:00.000"),
  lmRow("2", "Jace, the Mind Sculptor", "wwk", "31", "2026-02-02 10:00:00.000"),
].join("\n");

const first = importMoxfieldCsv(db, snapshot, {});
assert.equal(first.mode, "replace");
assert.equal(listHoldings(db).totalCards, 6);
assert.equal(first.reconciled?.added, 2);

// Importing the identical file again changes nothing at all.
const again = importMoxfieldCsv(db, snapshot, {});
assert.equal(listHoldings(db).totalCards, 6, "re-import must not double the collection");
assert.equal(again.reconciled?.added, 0);
assert.equal(again.reconciled?.updated, 0);
assert.equal(again.reconciled?.unchanged, 2);
assert.equal(again.reconciled?.removed, 0);

// A quantity change in the export is applied, not added to.
const fewer = importMoxfieldCsv(
  db,
  [
    HEADER,
    lmRow("1", "Forest", "blb", "280", "2026-01-01 10:00:00.000"),
    lmRow("2", "Jace, the Mind Sculptor", "wwk", "31", "2026-02-02 10:00:00.000"),
  ].join("\n"),
  {},
);
assert.equal(fewer.reconciled?.updated, 1);
assert.equal(listHoldings(db).totalCards, 3);

// A card dropped from the export is removed here too.
const dropped = importMoxfieldCsv(
  db,
  [HEADER, lmRow("1", "Forest", "blb", "280", "2026-01-01 10:00:00.000")].join("\n"),
  {},
);
assert.equal(dropped.reconciled?.removed, 1);
assert.equal(dropped.reconciled?.cardsRemoved, 2);
assert.equal(listHoldings(db).rows.length, 1);

// Hand-added cards are not the importer's to delete.
const manual = db
  .insert(holdings)
  .values({
    printingKey: db.select({ id: printings.id }).from(printings).all()[1].id,
    quantity: 3,
    finish: "nonfoil",
    condition: "NM",
    dateAdded: "2026-05-05",
    source: "manual",
    createdAt: new Date(),
  })
  .returning({ id: holdings.id })
  .all()[0];

importMoxfieldCsv(
  db,
  [HEADER, lmRow("1", "Forest", "blb", "280", "2026-01-01 10:00:00.000")].join("\n"),
  {},
);
assert.equal(
  db.select().from(holdings).where(eq(holdings.id, manual.id)).all().length,
  1,
  "a manual holding must survive an import that does not mention it",
);

// A price override on a surviving holding is kept: reconciliation updates the
// row in place rather than deleting and recreating it.
const survivor = listHoldings(db).rows.find((row) => row.name === "Forest")!;
db.update(holdings)
  .set({ priceOverrideCents: 4_242 })
  .where(eq(holdings.id, survivor.id))
  .run();

importMoxfieldCsv(
  db,
  [HEADER, lmRow("7", "Forest", "blb", "280", "2026-01-01 10:00:00.000")].join("\n"),
  {},
);
const kept = db.select().from(holdings).where(eq(holdings.id, survivor.id)).get()!;
assert.equal(kept.priceOverrideCents, 4_242, "an override must survive a quantity change");
assert.equal(kept.quantity, 7);

// Two rows of the same card within one file are still one holding of their sum.
db.delete(holdings).run();
const summed = importMoxfieldCsv(
  db,
  [
    HEADER,
    lmRow("2", "Forest", "blb", "280", "2026-01-01 10:00:00.000"),
    lmRow("3", "Forest", "blb", "280", "2026-01-01 10:00:00.000"),
  ].join("\n"),
  {},
);
assert.equal(summed.reconciled?.added, 1);
assert.equal(listHoldings(db).totalCards, 5);
assert.equal(listHoldings(db).rows.length, 1);

// --add keeps the old accumulate behaviour for a partial list.
const appended = importMoxfieldCsv(
  db,
  [HEADER, lmRow("2", "Forest", "blb", "280", "2026-01-01 10:00:00.000")].join("\n"),
  { mode: "add" },
);
assert.equal(appended.mode, "add");
assert.equal(listHoldings(db).totalCards, 7, "--add accumulates");

// A dry run reports the removals it would make, without making them.
db.delete(holdings).run();
importMoxfieldCsv(db, snapshot, {});
const preview = importMoxfieldCsv(
  db,
  [HEADER, lmRow("4", "Forest", "blb", "280", "2026-01-01 10:00:00.000")].join("\n"),
  { dryRun: true },
);
assert.equal(preview.reconciled?.removed, 1);
assert.equal(preview.reconciled?.unchanged, 1);
assert.equal(listHoldings(db).totalCards, 6, "a dry run must not write");

// --adopt claims rows of unknown provenance, so a collection imported before
// holdings recorded a source is not duplicated by the next import.
db.delete(holdings).run();
db.insert(holdings)
  .values({
    printingKey: db.select({ id: printings.id }).from(printings).all()[0].id,
    quantity: 4,
    finish: "nonfoil",
    condition: "NM",
    dateAdded: "2026-01-01",
    source: "manual",
    createdAt: new Date(),
  })
  .run();

const adopted = importMoxfieldCsv(
  db,
  [HEADER, lmRow("4", "Forest", "blb", "280", "2026-01-01 10:00:00.000")].join("\n"),
  { adopt: true },
);
assert.equal(adopted.adopted, 1);
assert.equal(listHoldings(db).totalCards, 4, "--adopt must not duplicate the collection");
assert.equal(listHoldings(db).rows.length, 1);

db.delete(holdings).run();

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
