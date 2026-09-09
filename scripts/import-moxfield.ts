/**
 * Imports a Moxfield collection CSV export.
 *
 *   npm run import:moxfield -- <file.csv> [--dry-run] [--date YYYY-MM-DD]
 *
 *   --dry-run       parse and report without writing anything
 *   --add           merge the file in without removing anything. The default
 *                   treats the export as a snapshot of the whole collection
 *                   and removes holdings it no longer mentions
 *   --adopt         one-time: claim existing holdings of unknown provenance
 *                   before reconciling, for a collection imported before
 *                   holdings recorded their source
 *   --import-dates  stamp every row with today instead of reading the
 *                   Last Modified column
 *   --date          force one acquisition date on every row
 *
 * Start with --dry-run: it prints the same report, including how each raw
 * Condition and Foil value was mapped and every row that did not resolve.
 */
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { DB_PATH, openDatabase } from "@/db/client";
import { importMoxfieldCsv, type ImportReport } from "@/import/moxfield";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const dryRun = args.includes("--dry-run");
const dateSource = args.includes("--import-dates") ? "import" : "modified";
const mode = args.includes("--add") ? "add" : "replace";
const adopt = args.includes("--adopt");

const dateFlagIndex = args.indexOf("--date");
const dateAdded =
  dateFlagIndex === -1 ? undefined : args[dateFlagIndex + 1];

if (!file) {
  console.error(
    "Usage: npm run import:moxfield -- <file.csv> [--dry-run] [--date YYYY-MM-DD]",
  );
  process.exit(1);
}

if (dateAdded && !/^\d{4}-\d{2}-\d{2}$/.test(dateAdded)) {
  console.error("--date must be YYYY-MM-DD");
  process.exit(1);
}

function printReport(report: ImportReport) {
  console.log("");
  console.table({
    run: report.dryRun ? "dry run (nothing written)" : "imported",
    "acquisition dates":
      report.dateSource === "modified"
        ? "from Last Modified"
        : report.dateSource === "fixed"
          ? `fixed at ${report.dateAdded}`
          : `import date (${report.dateAdded})`,
    "  date range": `${report.earliestDate ?? "-"} .. ${report.latestDate ?? "-"}`,
    "  fell back to import date": report.datesFellBack,
    "data rows": report.dataRows,
    "rows imported": report.importedRows,
    "  of which merged": report.mergedRows,
    "cards imported": report.importedCards,
    "proxy rows skipped": report.proxyRowsSkipped,
    "  proxy cards skipped": report.proxyCardsSkipped,
    mode:
      report.mode === "replace"
        ? "replace (file is the whole collection)"
        : "add (nothing removed)",
    "rows with problems": report.problems.length,
    "resolved by name": report.resolvedByName.length,
  });

  if (report.adopted > 0) {
    console.log(
      `\nClaimed ${report.adopted.toLocaleString()} existing holdings as import-owned (--adopt).`,
    );
  }

  if (report.reconciled) {
    const r = report.reconciled;
    console.log(
      report.dryRun
        ? "\nWhat this import would change:"
        : "\nChanges to your collection:",
    );
    console.log(`  ${String(r.added).padStart(6)}  holdings added`);
    console.log(`  ${String(r.updated).padStart(6)}  quantities changed`);
    console.log(`  ${String(r.unchanged).padStart(6)}  unchanged`);
    console.log(
      `  ${String(r.removed).padStart(6)}  removed (${r.cardsRemoved.toLocaleString()} cards not in this export)`,
    );
  }

  // The mapping tables are the point of the dry run: they turn the two
  // assumptions in this importer into something checkable.
  console.log("\nCondition values found:");
  for (const entry of report.conditionsSeen) {
    const shown = entry.raw === "" ? "(empty)" : entry.raw;
    console.log(
      `  ${String(entry.count).padStart(6)}  ${shown.padEnd(20)} -> ${
        entry.mappedTo ?? "UNRECOGNISED, defaulted to NM"
      }`,
    );
  }

  console.log("\nFoil values found:");
  for (const entry of report.finishesSeen) {
    const shown = entry.raw === "" ? "(empty)" : entry.raw;
    console.log(
      `  ${String(entry.count).padStart(6)}  ${shown.padEnd(20)} -> ${
        entry.mappedTo ?? "UNRECOGNISED, row skipped"
      }`,
    );
  }

  console.log("\nProxy values found:");
  for (const entry of report.proxyValuesSeen) {
    const shown = entry.raw === "" ? "(empty)" : entry.raw;
    console.log(
      `  ${String(entry.count).padStart(6)}  ${shown.padEnd(20)} -> ${
        entry.treatedAsProxy ? "PROXY, skipped" : "real card"
      }`,
    );
  }

  if (report.languagesSeen.length > 0) {
    console.log("\nLanguages found (v1 prices the English printing):");
    for (const entry of report.languagesSeen) {
      console.log(`  ${String(entry.count).padStart(6)}  ${entry.raw}`);
    }
  }

  if (report.unknownSets.length > 0) {
    const rows = report.unknownSets.reduce((sum, set) => sum + set.rows, 0);
    console.log(
      `\nSets with no paper printings (${rows} row${rows === 1 ? "" : "s"}) — these price in tix, not USD, so v1 cannot value them:`,
    );
    for (const set of report.unknownSets) {
      console.log(
        `  ${String(set.rows).padStart(6)}  ${set.setCode.toUpperCase()}`,
      );
    }
  }

  if (report.fileErrors.length > 0) {
    console.log(`\nMalformed lines (${report.fileErrors.length}):`);
    for (const error of report.fileErrors.slice(0, 20)) {
      console.log(`  line ${error.line}: ${error.message}`);
    }
  }

  if (report.resolvedByName.length > 0) {
    console.log(
      `\nResolved by name, collector number did not match (${report.resolvedByName.length}) — worth reviewing:`,
    );
    for (const row of report.resolvedByName.slice(0, 25)) {
      console.log(`  line ${row.line}: ${row.reason}`);
    }
    if (report.resolvedByName.length > 25) {
      console.log(`  ... and ${report.resolvedByName.length - 25} more`);
    }
  }

  if (report.problems.length > 0) {
    console.log(`\nNot imported (${report.problems.length}):`);
    for (const row of report.problems.slice(0, 40)) {
      console.log(`  line ${row.line}: ${row.reason}`);
    }
    if (report.problems.length > 40) {
      console.log(`  ... and ${report.problems.length - 40} more`);
    }
  }

  console.log("");
}

const sqlite = openDatabase(DB_PATH);

try {
  const text = readFileSync(file, "utf8");
  const report = importMoxfieldCsv(drizzle(sqlite), text, {
    dryRun,
    dateAdded,
    dateSource,
    mode,
    adopt,
  });
  printReport(report);

  if (report.dryRun) {
    console.log("Dry run — nothing was written. Re-run without --dry-run to import.");
  }
} catch (error) {
  console.error(`Import failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  sqlite.close();
}
