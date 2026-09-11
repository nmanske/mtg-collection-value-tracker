/**
 * Audits an archive for builds that failed to download.
 *
 *   npm run audit:archive -- [root]
 *
 * A missing build is usually harmless: each one carries a ~90-day window while
 * builds are only ~8 days apart, so neighbours cover for it. What matters is
 * whether consecutive *readable* builds are ever more than a window apart,
 * which is the only way a date can fall through. This reports that rather than
 * the count of missing directories.
 */
import { discoverArchive, readBuildMeta } from "@/ingest/mtgjson-archive.mjs";

const builds = await discoverArchive(process.argv[2] ?? "./data/archive");
const metas: { label: string; date: string }[] = [];
for (const b of builds) {
  try {
    metas.push({ label: b.label, date: (await readBuildMeta(b.pricesPath)).date });
  } catch (error) {
    console.log(`  UNREADABLE ${b.label}: ${(error as Error).message}`);
  }
}
metas.sort((a, b) => a.date.localeCompare(b.date));
console.log(`${metas.length} readable builds, ${metas[0].date} .. ${metas.at(-1)!.date}`);

const DAY = 86_400_000;
const WINDOW = 90; // days each build looks back
let gaps = 0;
for (let i = 1; i < metas.length; i++) {
  const delta =
    (Date.parse(`${metas[i].date}T00:00:00Z`) -
      Date.parse(`${metas[i - 1].date}T00:00:00Z`)) / DAY;
  if (delta > WINDOW) {
    gaps += 1;
    console.log(
      `  GAP ${delta} days between ${metas[i - 1].label} (${metas[i - 1].date}) and ${metas[i].label} (${metas[i].date}) -> ${delta - WINDOW} uncovered days`,
    );
  } else if (delta > 60) {
    console.log(
      `  tight ${delta} days: ${metas[i - 1].label} (${metas[i - 1].date}) -> ${metas[i].label} (${metas[i].date}), ${WINDOW - delta} days of margin`,
    );
  }
}
console.log(gaps === 0 ? "\nNo uncovered dates." : `\n${gaps} gap(s) in coverage.`);
