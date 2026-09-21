import { and, eq, sql } from "drizzle-orm";
import { OWNER, type CollectionScope } from "@/db/scope";

import {
  addHolding,
  adoptHoldings,
  type DesiredHolding,
  previewReconcile,
  type ReconcileResult,
  reconcileHoldings,
} from "@/db/queries/holdings";
import type { Db } from "@/db/queries/printings";
import { type Condition, type Finish, holdings, printings } from "@/db/schema";

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
 * Values in Moxfield's boolean columns that mean true. Moxfield writes
 * `True`/`False`; the rest are accepted so an export edited in a spreadsheet
 * still reads correctly.
 */
const TRUTHY = new Set(["true", "yes", "1", "y", "t"]);
const FALSY = new Set(["false", "no", "0", "n", "f", ""]);

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
  /** Where acquisition dates came from. */
  dateSource: DateSource | "fixed";
  /** The fallback date, used when a row has no usable `Last Modified`. */
  dateAdded: string;
  /** Rows that fell back to the import date because their timestamp was unusable. */
  datesFellBack: number;
  /**
   * Rows at the export's earliest date, whose acquisition date is a floor.
   *
   * Moxfield stamps last-modified, not acquired, so a bulk load dates the whole
   * collection to one day. Reported so an import says how much of the history
   * it is inferring rather than reading.
   */
  inferredDates: number;
  /** Earliest and latest acquisition date actually assigned. */
  earliestDate: string | null;
  latestDate: string | null;
  dataRows: number;
  /** Rows that produced a holding. */
  importedRows: number;
  /** Rows merged into an existing holding rather than creating one. */
  mergedRows: number;
  mode: ImportMode;
  /** What reconciling the file against the stored collection did. */
  reconciled: ReconcileResult | null;
  /** Holdings claimed by --adopt, if it was used. */
  adopted: number;
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
  /** Proxy rows skipped, and the cards they represented. */
  proxyRowsSkipped: number;
  proxyCardsSkipped: number;
  /** Distinct raw `Proxy` values, so an unexpected spelling is visible. */
  proxyValuesSeen: { raw: string; treatedAsProxy: boolean; count: number }[];
  /**
   * Set codes with no paper printing in the local database, with how many rows
   * referenced them. Almost always MTGO-only sets, which carry a tix price but
   * no USD one and so cannot be valued here.
   */
  unknownSets: { setCode: string; rows: number }[];
  /** Structural CSV problems, e.g. a row with the wrong column count. */
  fileErrors: { line: number; message: string }[];
}

/**
 * Where each holding's acquisition date comes from.
 *
 * `modified` reads Moxfield's `Last Modified` column. That is strictly an
 * edit timestamp rather than an acquisition date — editing a card later moves
 * it forward, understating how long it has been held — but it is a far better
 * lower bound than the import date, and it is what makes the value-over-time
 * chart meaningful at all. Checked against a real 4,356-row export: 159
 * distinct days spanning nearly three years, no single day over 12.4%, and no
 * unparseable values. Stamping every row with the import date instead leaves
 * the chart flat at zero until the day of import.
 *
 * `import` stamps every row with the import date, which is the honest choice
 * when an export's timestamps are known to be meaningless — for instance after
 * a bulk re-edit that touched every row.
 */
export type DateSource = "modified" | "import";

/**
 * How the file relates to what is already stored.
 *
 * `replace` treats the export as a snapshot of the whole collection, which is
 * what it is: quantities are set from the file, and holdings the file no
 * longer mentions are removed. Only rows the importer owns are touched.
 *
 * `add` merges the file in without removing anything, for a partial list.
 * It is not the default because re-importing the same file under it doubles
 * every holding.
 */
export type ImportMode = "replace" | "add";

export interface ImportOptions {
  /** Parse and report without writing. */
  dryRun?: boolean;
  /** Defaults to `modified`. See {@link DateSource}. */
  dateSource?: DateSource;
  /** Defaults to `replace`. See {@link ImportMode}. */
  mode?: ImportMode;
  /**
   * Claim every existing holding of unknown provenance before reconciling.
   * A one-time migration step for collections imported before holdings
   * recorded their source.
   */
  adopt?: boolean;
  /**
   * Forces one acquisition date on every row, overriding `dateSource`.
   * Otherwise the import date is used as the fallback for rows whose
   * `Last Modified` is missing or unparseable.
   */
  dateAdded?: string;
  /**
   * Which collection to write into. Defaults to the host's own.
   *
   * A session scope changes the write from a reconciliation to a plain
   * insert: an uploaded collection is new by definition, so there is nothing
   * to compare against, nothing to adopt, and nothing that could be deleted.
   * The parsing above is identical, which is the reason this is an option
   * here rather than a second importer that would drift from this one.
   */
  scope?: CollectionScope;
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
  const scope = options.scope ?? OWNER;
  const now = new Date();
  const today = new Date().toISOString().slice(0, 10);
  const fallbackDate = options.dateAdded ?? today;
  const dateSource: DateSource | "fixed" = options.dateAdded
    ? "fixed"
    : (options.dateSource ?? "modified");

  /**
   * Moxfield writes `2025-10-30 05:05:42.953000`; only the date is kept, since
   * price snapshots are daily. A timestamp in the future is clamped to today,
   * because a holding dated ahead of now would contribute nothing to the chart
   * until that day arrived.
   */
  const acquisitionDate = (raw: string): string | null => {
    if (dateSource !== "modified") return null;
    const day = raw.trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) {
      return null;
    }
    return day > today ? today : day;
  };

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
    dateSource,
    dateAdded: fallbackDate,
    datesFellBack: 0,
    inferredDates: 0,
    earliestDate: null,
    latestDate: null,
    dataRows: table.rows.length,
    importedRows: 0,
    mergedRows: 0,
    mode: options.mode ?? "replace",
    reconciled: null,
    adopted: 0,
    importedCards: 0,
    resolvedByName: [],
    problems: [],
    conditionsSeen: [],
    finishesSeen: [],
    languagesSeen: [],
    proxyRowsSkipped: 0,
    proxyCardsSkipped: 0,
    proxyValuesSeen: [],
    unknownSets: [],
    fileErrors: table.errors,
  };

  const desired: DesiredHolding[] = [];
  const conditionCounts = new Map<string, number>();
  const finishCounts = new Map<string, number>();
  const languageCounts = new Map<string, number>();
  const unknownSetCounts = new Map<string, number>();
  const proxyCounts = new Map<string, number>();

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

      const rawProxy = at(row, "proxy").toLowerCase();
      proxyCounts.set(rawProxy, (proxyCounts.get(rawProxy) ?? 0) + 1);
      // Proxies are not the real card and carry none of its value, so they are
      // excluded from the collection outright rather than imported and priced.
      // An unrecognised value is treated as not-a-proxy and surfaced in the
      // report, so a spelling change upstream cannot silently drop real cards.
      if (TRUTHY.has(rawProxy)) {
        report.proxyRowsSkipped += 1;
        report.proxyCardsSkipped += Number.isInteger(count) && count > 0 ? count : 0;
        return;
      }

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

      const rowDate = acquisitionDate(at(row, "last modified"));
      if (dateSource === "modified" && rowDate === null) report.datesFellBack += 1;
      const dateAdded = rowDate ?? fallbackDate;

      if (!report.earliestDate || dateAdded < report.earliestDate) {
        report.earliestDate = dateAdded;
      }
      if (!report.latestDate || dateAdded > report.latestDate) {
        report.latestDate = dateAdded;
      }

      desired.push({
        printingKey: resolved.printing.id,
        quantity: count,
        finish,
        condition,
        dateAdded,
      });

      report.importedRows += 1;
      report.importedCards += count;
    });

    // Rows at the export's earliest date carry an inferred acquisition date.
    //
    // Inside `apply`, after the loop, because the earliest date is only known
    // once every row has been read — and because `desired` is empty until
    // `apply` runs, which is what made the first attempt at this silently flag
    // nothing at all.
    //
    // The rule is narrow on purpose: the floor is the one date the file proves
    // nothing about, since a last-modified stamp can only ever have moved
    // *forward*, so a row sitting on the minimum was acquired then or at any
    // earlier time. Later dates are at least an upper bound the file itself
    // distinguishes.
    if (dateSource === "modified" && report.earliestDate) {
      for (const holding of desired) {
        if (holding.dateAdded === report.earliestDate) {
          holding.dateAddedApprox = true;
          report.inferredDates += 1;
        }
      }
    }
  };

  const mode = options.mode ?? "replace";

  // One transaction for the whole file: a partial import that stops halfway
  // leaves a collection nobody can reason about, and reconciliation deletes
  // as well as inserts.
  if (dryRun) {
    apply();
    report.reconciled =
      mode === "replace"
        ? previewReconcile(db, desired, "moxfield", options.adopt ?? false)
        : null;
    if (options.adopt) {
      report.adopted = db
        .select({ id: holdings.id })
        .from(holdings)
        .where(eq(holdings.source, "manual"))
        .all().length;
    }
  } else {
    db.transaction(() => {
      apply();

      if (scope !== OWNER) {
        for (let i = 0; i < desired.length; i += 500) {
          db.insert(holdings)
            .values(
              desired.slice(i, i + 500).map((holding) => ({
                ...holding,
                source: "moxfield" as const,
                sessionId: scope,
                createdAt: now,
              })),
            )
            .run();
        }
        return;
      }

      if (options.adopt) report.adopted = adoptHoldings(db, "moxfield");
      if (mode === "replace") {
        report.reconciled = reconcileHoldings(db, desired, "moxfield");
      } else {
        // Append mode adds to what is stored and never removes anything.
        for (const holding of desired) {
          const { merged } = addHolding(db, {
            ...holding,
            source: "moxfield",
            createdAt: new Date(),
          });
          if (merged) report.mergedRows += 1;
        }
      }
    });
  }

  report.conditionsSeen = tally(
    conditionCounts,
    (raw) => CONDITION_BY_RAW[raw] ?? null,
  );
  report.finishesSeen = tally(finishCounts, (raw) => FINISH_BY_RAW[raw] ?? null);
  report.languagesSeen = [...languageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([raw, count]) => ({ raw, count }));
  report.proxyValuesSeen = [...proxyCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([raw, count]) => ({
      raw,
      treatedAsProxy: TRUTHY.has(raw),
      count,
    }));
  // A value that is neither clearly true nor clearly false would be imported
  // as a real card; make that loud rather than leaving it to be noticed.
  for (const entry of report.proxyValuesSeen) {
    if (!TRUTHY.has(entry.raw) && !FALSY.has(entry.raw)) {
      report.problems.push({
        line: 0,
        name: "",
        edition: "",
        collectorNumber: "",
        reason: `Unrecognised Proxy value "${entry.raw}" on ${entry.count} row${entry.count === 1 ? "" : "s"}; those rows were imported as real cards. Check them.`,
      });
    }
  }

  report.unknownSets = [...unknownSetCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([setCode, rows]) => ({ setCode, rows }));

  return report;
}
