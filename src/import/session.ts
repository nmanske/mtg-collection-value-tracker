import { randomUUID } from "node:crypto";

import { cachedPortfolioSeries } from "@/db/queries/portfolio-cache";
import type { Db } from "@/db/queries/printings";
import { createSession } from "@/db/queries/sessions";
import { holdings, type SessionSource } from "@/db/schema";

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

/** A ceiling on one upload, so a single file cannot fill the disk. */
export const MAX_SESSION_ROWS = 20_000;

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
export function warmSession(db: Db, sessionId: string, basketOnly = false): void {
  if (!basketOnly) cachedPortfolioSeries(db, { scope: sessionId });
  cachedPortfolioSeries(db, { scope: sessionId, constantBasket: true });
}
