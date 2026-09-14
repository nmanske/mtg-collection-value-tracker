/**
 * Everything that has to happen after a long archive backfill, in order.
 *
 *   npm run finalize                    # the full sequence
 *   npm run finalize -- --skip-import   # leave the collection alone
 *   npm run finalize -- --dry-run       # say what would run, change nothing
 *
 * This exists because the sequence has real ordering constraints that are easy
 * to get wrong from memory, and getting them wrong is quiet rather than loud:
 *
 * - the Moxfield import must run *before* the cache is rebuilt, because it can
 *   change which holdings carry an inferred acquisition date, and that moves
 *   every point in the series;
 * - the cache must be rebuilt *before* the smoke test, or the test measures a
 *   cold cache recomputing and reports the app as slow;
 * - VACUUM must come last, because everything above writes.
 *
 * Steps that need a file or a decision are skipped with an explanation rather
 * than guessed at. Nothing here is destructive: the import is reconciling
 * rather than replacing, and VACUUM INTO writes a new file instead of
 * rewriting the live one.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { DB_PATH, openDatabase } from "@/db/client";
import { cacheIsFresh, rebuildPortfolioCache } from "@/db/queries/portfolio-cache";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipImport = args.includes("--skip-import");
const csv = args.find((arg) => arg.endsWith(".csv"));

const rule = (title: string) => {
  console.log(`\n${"─".repeat(64)}\n${title}\n`);
};

function run(command: string, commandArgs: string[]): boolean {
  if (dryRun) {
    console.log(`  would run: ${command} ${commandArgs.join(" ")}`);
    return true;
  }
  try {
    execFileSync(command, commandArgs, { stdio: "inherit", shell: true });
    return true;
  } catch {
    return false;
  }
}

const failures: string[] = [];

// --- 1. what the archive actually delivered -------------------------------

rule("1/5  Gaps in the price timeline");
if (!run("npm", ["run", "audit:gaps"])) failures.push("audit:gaps");

// --- 2. the collection ----------------------------------------------------

rule("2/5  Collection import");
if (skipImport) {
  console.log("  skipped (--skip-import)");
} else if (!csv) {
  // Not guessed at: importing the wrong file reconciles the collection against
  // it, which removes holdings the file does not mention.
  console.log(
    "  skipped — pass a Moxfield CSV to re-import, e.g.\n" +
      "    npm run finalize -- collection.csv\n" +
      "  This is what sets the inferred-acquisition-date flags, so ?filter=inferred\n" +
      "  stays empty until it runs.",
  );
} else if (!existsSync(csv)) {
  console.log(`  skipped — no such file: ${csv}`);
  failures.push("import (file missing)");
} else {
  if (!run("npm", ["run", "import:moxfield", "--", csv])) {
    failures.push("import:moxfield");
  }
}

// --- 3. the cache ---------------------------------------------------------

rule("3/5  Portfolio cache");
if (dryRun) {
  console.log("  would rebuild all four views");
} else {
  const sqlite = openDatabase(DB_PATH);
  sqlite.pragma("busy_timeout = 300000");
  try {
    const db = drizzle(sqlite);
    console.log(cacheIsFresh(db) ? "  cache is current" : "  cache is stale");
    const result = rebuildPortfolioCache(db, (message) => console.log(message));
    console.log(
      `  ${result.views} views, ${result.points.toLocaleString()} points, ${result.seconds.toFixed(1)}s`,
    );
  } catch (error) {
    console.log(`  FAILED: ${(error as Error).message}`);
    failures.push("cache rebuild");
  } finally {
    sqlite.close();
  }
}

// --- 4. does the app actually render? -------------------------------------

rule("4/5  HTTP smoke test");
const port = process.env.PORT ?? "3000";
let serving = false;
try {
  await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(5_000) });
  serving = true;
} catch {
  serving = false;
}

if (!serving) {
  console.log(
    `  skipped — nothing serving http://localhost:${port}.\n` +
      "  Start the app and run `npm run smoke:http -- <port>`; this is the step\n" +
      "  that catches a page that responds but renders nothing.",
  );
} else if (!run("npm", ["run", "smoke:http", "--", port])) {
  failures.push("smoke:http");
}

// --- 5. compact, and produce the copy to deploy ---------------------------

rule("5/5  Compact");
const target = DB_PATH.replace(/\.db$/, "-compact.db");
if (existsSync(target)) {
  console.log(`  skipped — ${target} already exists; move or delete it first`);
} else if (dryRun) {
  console.log(`  would VACUUM INTO ${target}`);
} else {
  // VACUUM INTO rather than VACUUM: it writes a consistent, compacted copy
  // without touching the live file, which is also exactly what you want to
  // move to a server. Copying a live SQLite file is how databases get
  // corrupted.
  const sqlite = openDatabase(DB_PATH);
  sqlite.pragma("busy_timeout = 600000");
  try {
    const before = (await stat(DB_PATH)).size;
    console.log(`  ${(before / 1e9).toFixed(2)} GB -> compacting...`);
    sqlite.prepare(`vacuum into ?`).run(target);
    const after = (await stat(target)).size;
    console.log(
      `  ${target}: ${(after / 1e9).toFixed(2)} GB ` +
        `(${(100 - (after / before) * 100).toFixed(0)}% smaller)`,
    );
    console.log("  Verify it, then it is safe to replace the original.");
  } catch (error) {
    console.log(`  FAILED: ${(error as Error).message}`);
    failures.push("vacuum");
  } finally {
    sqlite.close();
  }
}

rule("Done");
if (failures.length > 0) {
  console.log(`${failures.length} step(s) failed: ${failures.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("All steps completed.");
}
