import { randomUUID } from "node:crypto";

import { cachedPortfolioSeries } from "@/db/queries/portfolio-cache";
import type { ValuationProgress } from "@/db/queries/valuation";
import type { Db } from "@/db/queries/printings";
import { createSession } from "@/db/queries/sessions";
import { holdings, type SessionSource } from "@/db/schema";

import { MAX_SESSION_ROWS } from "@/lib/limits";

import { resolveDecklist, type DecklistEntry } from "./decklist";
import { importMoxfieldCsv } from "./moxfield";

/**
 * Building a one-off collection from whatever somebody handed us.
 *
 * Three ways in — a Moxfield CSV, a pasted decklist, a link — and one way out:
 * rows in `holdings` under a fresh session id. Everything downstream (the
 * dashboard, the statistics, the export) then works exactly as it does for a
 * self-hosted collection, because it is the same table and the same queries
 * with a different scope.
 */

export class ImportRejected extends Error {}

export interface SessionImport {
  sessionId: string;
  label: string;
  source: SessionSource;
  matched: number;
  unmatched: number;
  /** Lines that named nothing we could price, for the reader to see. */
  problems: { line: number; name: string; reason: string }[];
  /**
   * Whether acquisition dates came from the file.
   *
   * A Moxfield export carries a last-modified date per row, which is what the
   * as-held chart is drawn from. A decklist carries nothing of the kind, so
   * there is no honest as-held line to draw for one and the dashboard shows
   * the fixed-basket view instead: what this list would have been worth over
   * time, which is the only question a list without dates can answer.
   */
  datesKnown: boolean;
}

/** A Moxfield collection export, uploaded as a file. */
export function importCsvSession(
  db: Db,
  text: string,
  label: string,
): SessionImport {
  const sessionId = randomUUID();

  let report;
  try {
    report = importMoxfieldCsv(db, text, { scope: sessionId });
  } catch (error) {
    // The parser's own messages name the column that was missing, which is
    // the single most useful thing anyone can be told at this point. Rewrapped
    // rather than left to propagate, because the action only shows the text of
    // errors it recognises as written for a reader.
    throw new ImportRejected((error as Error).message);
  }

  if (report.importedRows === 0) {
    throw new ImportRejected(
      report.problems.length > 0
        ? `None of the ${report.dataRows} rows in that file could be matched to a card. Is it a Moxfield collection export?`
        : "That file has no card rows in it.",
    );
  }
  if (report.importedRows > MAX_SESSION_ROWS) {
    throw new ImportRejected(
      `That file has ${report.importedRows.toLocaleString()} holdings, and the limit is ${MAX_SESSION_ROWS.toLocaleString()}.`,
    );
  }

  createSession(db, {
    id: sessionId,
    label,
    source: "csv",
    matched: report.importedRows,
    unmatched: report.problems.length,
    // Nothing is priced yet. A child process does that; see session-warm.
    warmState: "pending",
  });

  return {
    sessionId,
    label,
    source: "csv",
    matched: report.importedRows,
    unmatched: report.problems.length,
    problems: report.problems.map((problem) => ({
      line: problem.line,
      name: problem.name,
      reason: problem.reason,
    })),
    datesKnown: true,
  };
}

/** A pasted or fetched decklist. */
export function importDecklistSession(
  db: Db,
  entries: DecklistEntry[],
  label: string,
  source: Exclude<SessionSource, "csv">,
): SessionImport {
  if (entries.length === 0) {
    throw new ImportRejected("There are no cards in that list.");
  }
  if (entries.length > MAX_SESSION_ROWS) {
    throw new ImportRejected(
      `That list has ${entries.length.toLocaleString()} lines, and the limit is ${MAX_SESSION_ROWS.toLocaleString()}.`,
    );
  }

  const { resolved, unmatched } = resolveDecklist(db, entries);
  if (resolved.length === 0) {
    throw new ImportRejected(
      "None of those lines matched a card. A line looks like `1 Sol Ring (C18) 120`, or just `Sol Ring`.",
    );
  }

  const sessionId = randomUUID();
  const now = new Date();
  // Today, and flagged as inferred. A list says nothing about when anything
  // was acquired, and a date invented to make a chart look fuller would be a
  // claim the input cannot support.
  const dateAdded = now.toISOString().slice(0, 10);

  db.transaction(() => {
    createSession(db, {
      id: sessionId,
      label,
      source,
      matched: resolved.length,
      unmatched: unmatched.length,
      warmState: "pending",
    });

    for (let i = 0; i < resolved.length; i += 500) {
      db.insert(holdings)
        .values(
          resolved.slice(i, i + 500).map((entry) => ({
            printingKey: entry.printingKey,
            quantity: entry.quantity,
            finish: entry.resolvedFinish,
            condition: "NM" as const,
            dateAdded,
            dateAddedApprox: true,
            source: "manual" as const,
            sessionId,
            createdAt: now,
          })),
        )
        .run();
    }
  });

  return {
    sessionId,
    label,
    source,
    matched: resolved.length,
    unmatched: unmatched.length,
    problems: unmatched,
    datesKnown: false,
  };
}

/**
 * Computes the views the dashboard will ask for, before it asks.
 *
 * Called from the worker process, never from a request: it is seconds of
 * synchronous work and better-sqlite3 blocks the event loop for all of them.
 * See `scripts/warm-session.mts`.
 *
 * Only the views that page draws. The Card Kingdom ones are computed if and
 * when somebody switches to them, which most visitors never will.
 */
export function warmSession(
  db: Db,
  sessionId: string,
  basketOnly = false,
  onProgress?: (update: WarmProgress) => void,
): void {
  // One view for a list, two for a collection with real dates. Each is
  // weighted equally, which is close enough: they do the same work over the
  // same prices and differ only in whether acquisition dates gate a holding.
  const views = basketOnly ? 1 : 2;
  let done = 0;

  const forward = (update: ValuationProgress) => {
    if (!onProgress) return;
    onProgress({
      percent: Math.min(
        99,
        Math.round(((done + viewFraction(update)) / views) * 100),
      ),
      step: describe(update),
    });
  };

  if (!basketOnly) {
    cachedPortfolioSeries(db, { scope: sessionId, onProgress: forward });
    done += 1;
  }
  cachedPortfolioSeries(db, {
    scope: sessionId,
    constantBasket: true,
    onProgress: forward,
  });
}

export interface WarmProgress {
  /** 0-99. A hundred is written when the session is marked ready. */
  percent: number;
  step: string;
}

/**
 * How far through one view a phase is.
 *
 * The weights come from measuring, not from taste: reading the prices off
 * disk is about 75% of the time on a real collection, filling gaps is under
 * 1%, and valuing date by date is about 4%. The rest is setup before the
 * first callback, which is why reading starts at 0.15 rather than 0 — a bar
 * that sat at nothing for the first fifth of the wait would read as broken.
 */
function viewFraction({ phase, fraction }: ValuationProgress): number {
  if (phase === "reading") return 0.15 + fraction * 0.7;
  if (phase === "filling") return 0.85 + fraction * 0.05;
  return 0.9 + fraction * 0.1;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * What to tell the reader.
 *
 * The month is only available while valuing, which is the last few percent:
 * the long phase reads prices in storage order, by printing rather than by
 * date, because ordering that read by date turns 228ms into 114 seconds. So
 * the honest label for the long phase is what it is actually doing.
 */
function describe({ phase, date }: ValuationProgress): string {
  if (phase === "reading") return "Reading five years of prices";
  if (phase === "filling") return "Filling gaps in the history";
  if (!date) return "Valuing your collection";
  const [year, month] = date.split("-");
  return `Valuing ${MONTHS[Number(month) - 1]} ${year}`;
}
