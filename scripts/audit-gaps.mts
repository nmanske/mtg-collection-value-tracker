/**
 * Reports missing days in the price timeline, and why each run is missing.
 *
 *   npm run audit:gaps -- [--root DIR] [--all]
 *
 *   --root DIR  archive root (default ./data/archive)
 *   --all       list every gap, not just the ones worth acting on
 */
import { drizzle } from "drizzle-orm/better-sqlite3";

import { DB_PATH, openDatabase } from "@/db/client";
import { syncMeta } from "@/db/schema";
import {
  buildGapReport,
  type GapReason,
  REASON_LABEL,
} from "@/lib/gaps";
import { discoverArchive, readBuildMeta } from "@/ingest/mtgjson-archive.mjs";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const sqlite = openDatabase(DB_PATH);
sqlite.pragma("busy_timeout = 120000");

try {
  const db = drizzle(sqlite);

  const dates = (
    sqlite
      .prepare("select distinct date from price_snapshots order by date")
      .all() as { date: string }[]
  ).map((row) => row.date);

  if (dates.length === 0) {
    console.log("No price history yet.");
    process.exit(0);
  }

  // One 4 KB header read per build, not a parse.
  const builds = await discoverArchive(flag("--root") ?? "./data/archive");
  const buildDates: string[] = [];
  for (const build of builds) {
    const meta = await readBuildMeta(build.pricesPath).catch(() => null);
    if (meta) buildDates.push(meta.date);
  }

  const ingestedThrough =
    db
      .select()
      .from(syncMeta)
      .all()
      .find((row) => row.key === "mtgjson_archive_max_date")?.value ?? null;

  const report = buildGapReport(dates, buildDates, ingestedThrough);

  console.log(
    `${report.dates.toLocaleString()} days of prices, ${report.first} .. ${report.last}`,
  );
  console.log(
    `${builds.length} archived builds, ${buildDates[0] ?? "-"} .. ${buildDates.at(-1) ?? "-"}` +
      (ingestedThrough ? `, ingested through ${ingestedThrough}` : ""),
  );
  console.log(
    `\n${report.gaps.length} gap(s), ${report.totalMissing.toLocaleString()} missing days\n`,
  );

  const order: GapReason[] = [
    "missed-run",
    "no-build",
    "pending",
    "not-published",
  ];
  for (const reason of order) {
    const gaps = report.gaps.filter((gap) => gap.reason === reason);
    if (gaps.length === 0) continue;
    console.log(
      `${report.missingByReason[reason].toLocaleString()} day(s) — ${REASON_LABEL[reason]}`,
    );
    // Only the actionable reasons are listed in full; the rest would be pages
    // of dates nobody can do anything about.
    const listable =
      args.includes("--all") || reason === "missed-run" || reason === "no-build";
    const shown = listable ? gaps : gaps.slice(0, 3);
    for (const gap of shown) {
      console.log(
        `    ${String(gap.missing).padStart(4)}d  ${gap.firstMissing} .. ${gap.lastMissing}`,
      );
    }
    if (shown.length < gaps.length) {
      console.log(`         ... and ${gaps.length - shown.length} more run(s)`);
    }
    console.log("");
  }

  const actionable =
    report.missingByReason["missed-run"] + report.missingByReason["no-build"];
  console.log(
    actionable === 0
      ? "Nothing actionable: every gap either fills itself or has no upstream data."
      : `${actionable.toLocaleString()} day(s) are not explained by upstream or by pending work.`,
  );
} catch (error) {
  console.error(`Gap audit failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  sqlite.close();
}
