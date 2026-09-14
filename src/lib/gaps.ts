/**
 * Finding and explaining missing days in the price timeline.
 *
 * A list of missing dates on its own is not actionable, because the reasons
 * differ completely and only one of them is worth doing anything about:
 *
 * - the archive backfill has not reached those builds yet, and they will fill
 *   themselves;
 * - MTGJSON published no prices that day, so nothing can fill them;
 * - no archived build covers them, because that build is gone from upstream;
 * - the daily job did not run, which is the only case that is both fixable and
 *   a sign something is wrong.
 *
 * Classifying them needs one fact per archived build — its date — because a
 * build's window ends on its build date and reaches back roughly 90 days. That
 * is enough to say whether some build could have supplied a given day.
 */

/** How far back a build's price window reaches from its own build date. */
export const BUILD_WINDOW_DAYS = 90;

export type GapReason =
  /** An archived build covers these dates but has not been ingested yet. */
  | "pending"
  /** A build covering these dates was ingested, so MTGJSON had no prices. */
  | "not-published"
  /** No archived build's window reaches these dates. */
  | "no-build"
  /** After the newest archived build: only the daily job could have them. */
  | "missed-run";

export interface Gap {
  /** Last date with data before the gap. */
  after: string;
  /** First date with data after it. */
  before: string;
  missing: number;
  firstMissing: string;
  lastMissing: string;
  reason: GapReason;
}

const MS_PER_DAY = 86_400_000;

const toMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Whole days between two `YYYY-MM-DD` dates. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toMs(to) - toMs(from)) / MS_PER_DAY);
}

/**
 * Runs of missing days in a sorted list of dates.
 *
 * Returned as runs rather than individual dates because that is how they are
 * caused — a build not yet read, an upstream outage — and a list of 1,469 bare
 * dates says nothing a reader can act on.
 */
export function findGaps(
  dates: readonly string[],
): Omit<Gap, "reason">[] {
  const gaps: Omit<Gap, "reason">[] = [];

  for (let i = 1; i < dates.length; i++) {
    const missing = daysBetween(dates[i - 1], dates[i]) - 1;
    if (missing <= 0) continue;
    gaps.push({
      after: dates[i - 1],
      before: dates[i],
      missing,
      firstMissing: toDate(toMs(dates[i - 1]) + MS_PER_DAY),
      lastMissing: toDate(toMs(dates[i]) - MS_PER_DAY),
    });
  }

  return gaps;
}

/**
 * Why a run of days is missing.
 *
 * Judged on its first missing day. A gap spanning a boundary — part covered by
 * an un-ingested build, part not — is rare and reporting the earlier cause is
 * the more useful half, since that is where the reader would start.
 */
export function classifyGap(
  gap: Omit<Gap, "reason">,
  buildDates: readonly string[],
  ingestedThrough: string | null,
): GapReason {
  const day = gap.firstMissing;
  const newestBuild = buildDates[buildDates.length - 1];

  if (newestBuild && day > newestBuild) return "missed-run";

  // A build covers a day when the day falls inside its backward window.
  const covering = buildDates.filter(
    (build) =>
      build >= day && daysBetween(day, build) < BUILD_WINDOW_DAYS,
  );
  if (covering.length === 0) return "no-build";

  // Ingested in build order, so anything at or below the watermark was read.
  if (ingestedThrough && covering.some((build) => build > ingestedThrough)) {
    return "pending";
  }
  return "not-published";
}

export interface GapReport {
  dates: number;
  first: string | null;
  last: string | null;
  gaps: Gap[];
  missingByReason: Record<GapReason, number>;
  totalMissing: number;
}

export function buildGapReport(
  dates: readonly string[],
  buildDates: readonly string[],
  ingestedThrough: string | null,
): GapReport {
  const sortedBuilds = [...buildDates].sort();
  const gaps = findGaps(dates).map((gap) => ({
    ...gap,
    reason: classifyGap(gap, sortedBuilds, ingestedThrough),
  }));

  const missingByReason: Record<GapReason, number> = {
    pending: 0,
    "not-published": 0,
    "no-build": 0,
    "missed-run": 0,
  };
  for (const gap of gaps) missingByReason[gap.reason] += gap.missing;

  return {
    dates: dates.length,
    first: dates[0] ?? null,
    last: dates[dates.length - 1] ?? null,
    gaps,
    missingByReason,
    totalMissing: gaps.reduce((sum, gap) => sum + gap.missing, 0),
  };
}

export const REASON_LABEL: Record<GapReason, string> = {
  pending: "backfill has not reached these builds yet",
  "not-published": "MTGJSON published no prices these days",
  "no-build": "no archived build covers these days",
  "missed-run": "the daily job did not run",
};
