import { and, eq, sql } from "drizzle-orm";

import { addHolding } from "@/db/queries/holdings";
import type { Db } from "@/db/queries/printings";
import { type Condition, type Finish, printings } from "@/db/schema";

import { columnIndex, parseCsvTable } from "./csv";

/**
 * Importer for Moxfield's collection CSV export.
 *
 * Header, as documented:
 *   Count,Tradelist Count,Name,Edition,Condition,Language,Foil,Tags,
 *   Last Modified,Collector Number,Alter,Proxy,Purchase Price
 *
 * The `Foil` and `Condition` value sets are the uncertain part: this maps
 * every spelling seen in the wild and *reports* the distinct raw values it
 * encountered, so a real export confirms or corrects the mapping rather than
 * having it fail silently.
 */

/** Columns the importer needs. Everything else in the export is ignored. */
const REQUIRED_COLUMNS = ["count", "name", "edition", "collector number"];

/**
 * Moxfield's condition vocabulary mapped onto ours.
 *
 * Moxfield's UI uses a Mint/Near Mint/Excellent/Good/Played/Poor scale while
 * exports from other tools use NM/LP/MP/HP/DMG, so both are accepted.
 *
 * `Excellent` and `Good` are the genuinely ambiguous ones — they sit between
 * the two scales — so the import report lists how many rows used each raw
 * value, making the mapping auditable instead of invisible.
 */
const CONDITION_BY_RAW: Record<string, Condition> = {
  // Ours, passed through.
  nm: "NM",
  lp: "LP",
  mp: "MP",
  hp: "HP",
  dmg: "DMG",
  // Moxfield / TCGplayer spellings.
  mint: "NM",
  m: "NM",
  "near mint": "NM",
  nearmint: "NM",
  excellent: "LP",
  ex: "LP",
  "lightly played": "LP",
  "slightly played": "LP",
  sp: "LP",
  good: "MP",
  gd: "MP",
  "moderately played": "MP",
  played: "MP",
  pl: "MP",
  "heavily played": "HP",
  poor: "HP",
  pr: "HP",
  damaged: "DMG",
  d: "DMG",
};

/**
 * Moxfield's `Foil` column. An empty value means a normal, non-foil card.
 *
 * Confirmed against a real 4,356-row export: Moxfield does distinguish
 * `etched` from `foil` here, so the three finishes map one-to-one onto ours.
 */
const FINISH_BY_RAW: Record<string, Finish> = {
  "": "nonfoil",
  normal: "nonfoil",
  nonfoil: "nonfoil",
  "non-foil": "nonfoil",
  false: "nonfoil",
  foil: "foil",
  true: "foil",
  etched: "etched",
  "foil etched": "etched",
};

export interface RowProblem {
  /** 1-based line in the file, counting the header. */
  line: number;
  name: string;
  edition: string;
  collectorNumber: string;
  reason: string;
}

export interface ImportReport {
  dryRun: boolean;
  /** Date stamped on every imported holding. */
  dateAdded: string;
  dataRows: number;
  /** Rows that produced a holding. */
  importedRows: number;
  /** Rows merged into an existing holding rather than creating one. */
  mergedRows: number;
  /** Sum of `Count` across imported rows. */
  importedCards: number;
  /** Rows resolved by name and set because the collector number did not match. */
  resolvedByName: RowProblem[];
  /** Rows that produced nothing, each with a reason. */
  problems: RowProblem[];
  /** Distinct raw `Condition` values and how they were mapped. */
  conditionsSeen: { raw: string; mappedTo: Condition | null; count: number }[];
  /** Distinct raw `Foil` values and how they were mapped. */
  finishesSeen: { raw: string; mappedTo: Finish | null; count: number }[];
  /** Distinct `Language` values. v1 prices English printings only. */
  languagesSeen: { raw: string; count: number }[];
  /**
   * Set codes with no paper printing in the local database, with how many rows
   * referenced them. Almost always MTGO-only sets, which carry a tix price but
   * no USD one and so cannot be valued here.
   */
  unknownSets: { setCode: string; rows: number }[];
  /** Structural CSV problems, e.g. a row with the wrong column count. */
  fileErrors: { line: number; message: string }[];
}

export interface ImportOptions {
  /** Parse and report without writing. */
  dryRun?: boolean;
  /**
   * Acquisition date stamped on every row. Moxfield's export has no
   * acquisition date — `Last Modified` is its own edit timestamp, not when the
   * card was acquired — so this defaults to the import date and can be edited
   * per holding afterwards.
   */
  dateAdded?: string;
}

function tally<T>(counts: Map<string, number>, map: (raw: string) => T | null) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([raw, count]) => ({ raw, mappedTo: map(raw), count }));
}

/**
 * Resolves one CSV row to a printing.
 *
 * Set code plus collector number is an exact address and is tried first. When
 * that misses — a renumbered promo, a typo, a set code Moxfield spells
 * differently — a name-and-set lookup is tried, but only when it matches
 * exactly one printing. That is deterministic rather than a guess, and every
 * such row is listed separately in the report so it can be reviewed.
 */
function resolvePrinting(
  db: Db,
  name: string,
  edition: string,
  collectorNumber: string,
) {
  const setCode = edition.trim().toLowerCase();
  const number = collectorNumber.trim();

  const exact = db
    .select({
      id: printings.id,
      name: printings.name,
      finishes: printings.finishes,
    })
    .from(printings)
    .where(
      and(eq(printings.setCode, setCode), eq(printings.collectorNumber, number)),
    )
    .get();

  if (exact) return { printing: exact, byName: false };

  // Split and double-faced cards are exported by Moxfield under the front
  // face alone, while Scryfall stores "Front // Back".
  const cardName = name.trim();
  const candidates = db
    .select({
      id: printings.id,
      name: printings.name,
      finishes: printings.finishes,
    })
    .from(printings)
    .where(
      and(
        eq(printings.setCode, setCode),
        sql`(lower(${printings.name}) = lower(${cardName})
             or lower(${printings.name}) like lower(${cardName + " // %"}))`,
      ),
    )
    .all();

  if (candidates.length === 1) return { printing: candidates[0], byName: true };
  return { printing: null, byName: false, ambiguous: candidates.length > 1 };
}

export function importMoxfieldCsv(
  db: Db,
  text: string,
  options: ImportOptions = {},
): ImportReport {
  const dryRun = options.dryRun ?? false;
  const dateAdded = options.dateAdded ?? new Date().toISOString().slice(0, 10);

  const table = parseCsvTable(text);
  const columns = columnIndex(table.header);

  const missing = REQUIRED_COLUMNS.filter((name) => !columns.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Not a Moxfield collection export: missing column${missing.length === 1 ? "" : "s"} ${missing
        .map((name) => `"${name}"`)
        .join(", ")}. Found: ${table.header.join(", ") || "(no header)"}`,
    );
  }

  const at = (row: string[], column: string) => {
    const position = columns.get(column);
    return position === undefined ? "" : (row[position] ?? "").trim();
  };

  const report: ImportReport = {
    dryRun,
    dateAdded,
    dataRows: table.rows.length,
    importedRows: 0,
    mergedRows: 0,
    importedCards: 0,
    resolvedByName: [],
    problems: [],
    conditionsSeen: [],
    finishesSeen: [],
    languagesSeen: [],
    unknownSets: [],
    fileErrors: table.errors,
  };

  const conditionCounts = new Map<string, number>();
  const finishCounts = new Map<string, number>();
  const languageCounts = new Map<string, number>();
  const unknownSetCounts = new Map<string, number>();

  // Every set that has at least one paper printing, read once rather than
  // queried per failing row. Sets absent here are digital-only: the Scryfall
  // ingest keeps only printings whose `games` include paper, because an
  // MTGO-only card has a tix price and no USD one.
  const knownSets = new Set(
    db
      .selectDistinct({ setCode: printings.setCode })
      .from(printings)
      .all()
      .map((row) => row.setCode),
  );

  const apply = () => {
    table.rows.forEach((row, offset) => {
      // +2: one for the header, one to make it 1-based.
      const line = offset + 2;
      const name = at(row, "name");
      const edition = at(row, "edition");
      const collectorNumber = at(row, "collector number");
      const where = { line, name, edition, collectorNumber };

      const rawCondition = at(row, "condition").toLowerCase();
      const rawFinish = at(row, "foil").toLowerCase();
      const rawLanguage = at(row, "language");

      conditionCounts.set(rawCondition, (conditionCounts.get(rawCondition) ?? 0) + 1);
      finishCounts.set(rawFinish, (finishCounts.get(rawFinish) ?? 0) + 1);
      if (rawLanguage) {
        languageCounts.set(rawLanguage, (languageCounts.get(rawLanguage) ?? 0) + 1);
      }

      const count = Number(at(row, "count"));
      if (!Number.isInteger(count) || count < 1) {
        report.problems.push({
          ...where,
          reason: `Count is "${at(row, "count")}", expected a positive whole number.`,
        });
        return;
      }

      const finish = FINISH_BY_RAW[rawFinish];
      if (!finish) {
        report.problems.push({
          ...where,
          reason: `Unrecognised Foil value "${at(row, "foil")}".`,
        });
        return;
      }

      // An unrecognised condition defaults to NM but is still surfaced in the
      // report, since condition does not affect pricing in v1 and losing the
      // whole row over it would be worse than a visible default.
      const condition = CONDITION_BY_RAW[rawCondition] ?? "NM";

      const setCode = edition.trim().toLowerCase();
      const resolved = resolvePrinting(db, name, edition, collectorNumber);
      if (!resolved.printing) {
        let reason: string;
        if (resolved.ambiguous) {
          reason = `Several printings in ${edition.toUpperCase()} are named "${name}"; collector number ${collectorNumber} matched none of them.`;
        } else if (!knownSets.has(setCode)) {
          // Distinguish "we do not stock this set" from "this row is wrong" —
          // they call for completely different action from the user.
          unknownSetCounts.set(setCode, (unknownSetCounts.get(setCode) ?? 0) + 1);
          reason = `No paper printings are known for set ${edition.toUpperCase()}, so "${name}" cannot be valued. Digital-only sets are excluded: they price in tix, not USD.`;
        } else {
          reason = `No printing found for ${edition.toUpperCase()} ${collectorNumber} ("${name}").`;
        }
        report.problems.push({ ...where, reason });
        return;
      }

      if (!resolved.printing.finishes.includes(finish)) {
        report.problems.push({
          ...where,
          reason: `${resolved.printing.name} (${edition.toUpperCase()} ${collectorNumber}) was not printed in ${finish}.`,
        });
        return;
      }

      if (resolved.byName) {
        report.resolvedByName.push({
          ...where,
          reason: `Collector number ${collectorNumber} not found in ${edition.toUpperCase()}; matched "${resolved.printing.name}" by name.`,
        });
      }

      if (!dryRun) {
        const { merged } = addHolding(db, {
          printingKey: resolved.printing.id,
          quantity: count,
          finish,
          condition,
          dateAdded,
          createdAt: new Date(),
        });
        if (merged) report.mergedRows += 1;
      }

      report.importedRows += 1;
      report.importedCards += count;
    });
  };

  // One transaction for the whole file: a partial import that stops halfway
  // leaves a collection nobody can reason about.
  if (dryRun) apply();
  else db.transaction(apply);

  report.conditionsSeen = tally(
    conditionCounts,
    (raw) => CONDITION_BY_RAW[raw] ?? null,
  );
  report.finishesSeen = tally(finishCounts, (raw) => FINISH_BY_RAW[raw] ?? null);
  report.languagesSeen = [...languageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([raw, count]) => ({ raw, count }));
  report.unknownSets = [...unknownSetCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([setCode, rows]) => ({ setCode, rows }));

  return report;
}
