import { and, eq, sql } from "drizzle-orm";

import { FINISH_CODES } from "@/db/codec";
import type { Db } from "@/db/queries/printings";
import { priceSnapshots, printings, type Finish } from "@/db/schema";

/**
 * The plain-text decklist format every deckbuilder exports.
 *
 *   1 Sol Ring (C18) 120
 *   4x Lightning Bolt
 *   2 Arcane Signet (LTC) 321 *F*
 *
 * Parsing is deliberately forgiving. This is a box people paste into, and
 * what they paste is whatever their site's "export" button produced: section
 * headers, sideboard markers, comment lines, smart quotes, a stray blank line
 * at the end. Anything that is not a card line is skipped rather than refused,
 * because refusing the whole list over one header is the behaviour that makes
 * a paste box useless.
 */

export interface DecklistEntry {
  /** 1-based line in the input, for reporting what could not be matched. */
  line: number;
  quantity: number;
  name: string;
  /** Set code, if the line carried one. */
  setCode: string | null;
  collectorNumber: string | null;
  finish: Finish;
  /**
   * The exact printing, when the source knew it.
   *
   * Archidekt returns Scryfall ids, which beats matching on set and number and
   * removes the guesswork a bare name needs entirely. Null for anything typed
   * or pasted by hand.
   */
  scryfallId?: string | null;
}

/** Lines that are structure rather than cards. */
const SECTION_HEADINGS = new Set([
  "deck",
  "sideboard",
  "commander",
  "companion",
  "maybeboard",
  "considering",
  "tokens",
  "about",
]);

/**
 * One card line.
 *
 * Quantity is optional because plenty of lists are bare names; when it is
 * missing the line counts as one card, which is what a reader means.
 */
const LINE = new RegExp(
  [
    "^\\s*",
    "(?:(\\d+)\\s*[xX]?\\s+)?", // 1, 4x, 12
    "(.+?)", // name, non-greedy so the trailing parts win
    "(?:\\s+\\(([A-Za-z0-9]{2,6})\\)", // (C18)
    "(?:\\s+([A-Za-z0-9★-]+))?)?", // 120, 280*, SNC-102
    "(?:\\s*\\*(F|E)\\*)?", // *F*, *E*
    "\\s*$",
  ].join(""),
);

/** Trailing annotations some sites add that are not part of the name. */
const TRAILING_NOISE = /\s*[[(](?:foil|etched|nonfoil|non-foil)[\])]\s*$/i;

export function parseDecklist(text: string): DecklistEntry[] {
  const entries: DecklistEntry[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    // Typographic quotes and dashes arrive from anything that has been near a
    // word processor, and "Sol Ring" with a curly apostrophe matches nothing.
    const cleaned = raw
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .trim();

    if (!cleaned) return;
    if (cleaned.startsWith("//") || cleaned.startsWith("#")) return;
    // "SB: 2 Negate" — the sideboard marker some formats prefix.
    const body = cleaned.replace(/^SB:\s*/i, "");
    if (SECTION_HEADINGS.has(body.toLowerCase().replace(/[:(].*$/, "").trim())) {
      return;
    }

    const match = LINE.exec(body);
    if (!match) return;

    const [, quantity, rawName, setCode, collectorNumber, finishMark] = match;
    let name = rawName.trim();
    let finish: Finish =
      finishMark === "F" ? "foil" : finishMark === "E" ? "etched" : "nonfoil";

    if (TRAILING_NOISE.test(name)) {
      const noise = TRAILING_NOISE.exec(name)![0].toLowerCase();
      if (noise.includes("etched")) finish = "etched";
      else if (noise.includes("non")) finish = "nonfoil";
      else finish = "foil";
      name = name.replace(TRAILING_NOISE, "").trim();
    }

    // A line that is only a number, or only punctuation, is not a card.
    if (!/[a-z]/i.test(name)) return;

    entries.push({
      line,
      quantity: Math.min(Number(quantity ?? 1) || 1, 9_999),
      name,
      setCode: setCode ? setCode.toLowerCase() : null,
      collectorNumber: collectorNumber ?? null,
      finish,
      scryfallId: null,
    });
  });

  return entries;
}

export interface ResolvedEntry extends DecklistEntry {
  printingKey: number;
  /** The finish actually used, which may differ if the printing has no foil. */
  resolvedFinish: Finish;
}

export interface ResolveReport {
  resolved: ResolvedEntry[];
  unmatched: { line: number; name: string; reason: string }[];
}

/**
 * Turns parsed lines into printings.
 *
 * A line naming a set and number addresses one printing exactly. A bare name
 * does not, and something has to choose: a card like Sol Ring has forty
 * printings spanning three orders of magnitude in price. The cheapest priced
 * printing is chosen, because a decklist without set information is a list of
 * cards to acquire, and what it is worth is what it would cost — the most
 * expensive interpretation would be a number nobody asked for.
 *
 * Stated in the interface too. A guess the reader cannot see is worse than a
 * guess they can.
 */
export function resolveDecklist(
  db: Db,
  entries: DecklistEntry[],
): ResolveReport {
  const report: ResolveReport = { resolved: [], unmatched: [] };
  if (entries.length === 0) return report;

  for (const entry of entries) {
    // Best first: an id names one printing and cannot be ambiguous.
    const byId = entry.scryfallId
      ? db
          .select({ id: printings.id, finishes: printings.finishes })
          .from(printings)
          .where(eq(printings.scryfallId, entry.scryfallId))
          .get()
      : undefined;

    if (byId) {
      report.resolved.push({
        ...entry,
        printingKey: byId.id,
        resolvedFinish: usable(entry.finish, byId.finishes),
      });
      continue;
    }

    const exact =
      entry.setCode && entry.collectorNumber
        ? db
            .select({
              id: printings.id,
              finishes: printings.finishes,
              name: printings.name,
            })
            .from(printings)
            .where(
              and(
                eq(printings.setCode, entry.setCode),
                eq(printings.collectorNumber, entry.collectorNumber),
              ),
            )
            .get()
        : undefined;

    if (exact) {
      report.resolved.push({
        ...entry,
        printingKey: exact.id,
        resolvedFinish: usable(entry.finish, exact.finishes),
      });
      continue;
    }

    const cheapest = cheapestPrinting(db, entry.name);
    if (!cheapest) {
      report.unmatched.push({
        line: entry.line,
        name: entry.name,
        reason:
          entry.setCode && entry.collectorNumber
            ? `No printing ${entry.setCode.toUpperCase()} ${entry.collectorNumber}, and no card named "${entry.name}".`
            : `No card named "${entry.name}".`,
      });
      continue;
    }

    report.resolved.push({
      ...entry,
      printingKey: cheapest.id,
      resolvedFinish: usable(entry.finish, cheapest.finishes),
    });
  }

  return report;
}

/** A printing cannot be valued in a finish it was never printed in. */
function usable(wanted: Finish, available: Finish[]): Finish {
  if (available.includes(wanted)) return wanted;
  return available[0] ?? "nonfoil";
}

/**
 * The cheapest printing of a name that currently has a price.
 *
 * One query per name rather than a batch. Measured at 1-3ms against 108,886
 * printings — the name index carries it, and a pasted list is tens of lines,
 * not thousands. A batch would be faster in bulk and harder to read for a
 * saving nobody would notice.
 */
function cheapestPrinting(
  db: Db,
  name: string,
): { id: number; finishes: Finish[] } | null {
  const row = db
    .select({
      id: printings.id,
      finishes: printings.finishes,
      priceCents: sql<number | null>`(
        select ps.price_cents from ${priceSnapshots} ps
        where ps.printing_key = ${printings.id}
          and ps.finish = ${FINISH_CODES.nonfoil}
        order by ps.date desc limit 1
      )`,
    })
    .from(printings)
    .where(sql`lower(${printings.name}) = lower(${name})`)
    .orderBy(
      // Unpriced printings last: they would otherwise win every tie at null
      // and value the whole line at nothing.
      sql`case when (
        select ps.price_cents from ${priceSnapshots} ps
        where ps.printing_key = ${printings.id}
          and ps.finish = ${FINISH_CODES.nonfoil}
        order by ps.date desc limit 1
      ) is null then 1 else 0 end`,
      sql`(
        select ps.price_cents from ${priceSnapshots} ps
        where ps.printing_key = ${printings.id}
          and ps.finish = ${FINISH_CODES.nonfoil}
        order by ps.date desc limit 1
      ) asc`,
    )
    .limit(1)
    .get();

  return row ? { id: row.id, finishes: row.finishes } : null;
}
