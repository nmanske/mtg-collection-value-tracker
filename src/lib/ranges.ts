/**
 * Time ranges for the value and price-history charts.
 *
 * A range is only offered when the history actually spans it. Showing "5 years"
 * against three months of data would stretch a short series across a wide axis
 * and imply history that does not exist, so ranges unlock as data accumulates.
 *
 * The set grew when the MTGJSON archive backfill took history from 89 days to
 * nearly six years: 1M through 1Y plus "All" was the whole ladder when "All"
 * meant three months, and is far too coarse once "All" means 2,100 days.
 */

/**
 * How much history a range covers.
 *
 * `"ytd"` is not a fixed count — it runs from the 1st of January in the last
 * date's year, so the window it needs shrinks to nothing each New Year and
 * grows through the year. Everything else is a plain number of days, or `null`
 * for "whatever exists".
 */
export type RangeWindow = number | "ytd" | "held" | null;

export interface RangeOption {
  id: RangeId;
  label: string;
  window: RangeWindow;
  /** Spelled out for the tooltip on a range that cannot be shown yet. */
  description: string;
}

export type RangeId =
  | "held"
  | "1m"
  | "3m"
  | "6m"
  | "ytd"
  | "1y"
  | "2y"
  | "5y"
  | "all";

export const RANGES: RangeOption[] = [
  // The default. "All" starts in December 2020, where the collection was worth
  // nothing because none of it had been bought yet, so the chart opened with
  // three years of flat line before anything happened. This starts at the first
  // date anything was held, which is the first date the chart says anything.
  //
  // Its window is not a number of days — it depends on the data, so the caller
  // resolves it from the series rather than from a constant here.
  { id: "held", label: "Owned", window: "held", description: "since your first card" },
  { id: "1m", label: "1M", window: 30, description: "1 month" },
  { id: "3m", label: "3M", window: 90, description: "3 months" },
  { id: "6m", label: "6M", window: 180, description: "6 months" },
  { id: "ytd", label: "YTD", window: "ytd", description: "year to date" },
  { id: "1y", label: "1Y", window: 365, description: "1 year" },
  { id: "2y", label: "2Y", window: 730, description: "2 years" },
  { id: "5y", label: "5Y", window: 1_825, description: "5 years" },
  { id: "all", label: "All", window: null, description: "all history" },
];

export const DEFAULT_RANGE: RangeId = "held";

const MS_PER_DAY = 86_400_000;

function parseDate(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function isRangeId(value: string): value is RangeId {
  return RANGES.some((range) => range.id === value);
}

export function rangeById(id: RangeId): RangeOption {
  return RANGES.find((range) => range.id === id)!;
}

/** Inclusive span in days between two `YYYY-MM-DD` dates. */
export function spanInDays(first: string, last: string): number {
  const from = parseDate(first);
  const to = parseDate(last);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / MS_PER_DAY) + 1;
}

/**
 * Days of history a range needs, or null when any amount will do.
 *
 * Year-to-date is resolved against the last date rather than today: if the
 * daily job has not run, "this year" should mean up to the most recent price,
 * not a window running into the future.
 */
export function requiredDays(
  range: RangeOption,
  lastDate: string | null,
): number | null {
  // "All" and "Owned" are both bounded by the data rather than by a count of
  // days, so neither has a requirement to test.
  if (range.window === null || range.window === "held") return null;
  if (range.window !== "ytd") return range.window;
  if (!lastDate) return null;
  const end = parseDate(lastDate);
  if (Number.isNaN(end)) return null;
  const jan1 = Date.UTC(new Date(end).getUTCFullYear(), 0, 1);
  return Math.round((end - jan1) / MS_PER_DAY) + 1;
}

/**
 * Whether a range is worth offering, given how much history exists.
 *
 * `All` is always available — it means "whatever there is" and cannot outrun
 * the data. Every other range needs the history to cover it.
 */
export function isRangeAvailable(
  range: RangeOption,
  spanDays: number,
  lastDate: string | null = null,
): boolean {
  // Year-to-date cannot be sized without a date to count back from, and an
  // unsizable window must not fall through to "unbounded, always available" —
  // that is the rule for "All", which means something quite different.
  if (range.window === "ytd" && !lastDate) return false;

  const needed = requiredDays(range, lastDate);
  if (needed === null) return true;
  // A YTD window of one day is not worth offering on New Year's Day; requiring
  // at least two keeps a chart from being drawn through a single point.
  if (range.window === "ytd" && needed < 2) return false;
  return spanDays >= needed;
}

/**
 * The earliest date a range should show, or null for everything.
 *
 * Counted back from the last date with data rather than from today: if the
 * daily job has not run yet, "1 month" should still mean the most recent month
 * of prices rather than a window that is partly in the future.
 */
export function rangeStart(
  range: RangeOption,
  lastDate: string,
  /** First date anything was held, for the "Owned" range. */
  firstHeldDate: string | null = null,
): string | null {
  if (range.window === null) return null;
  // Data-dependent rather than a count of days. Falls through to "everything"
  // when nothing is held, which is the honest answer for an empty collection.
  if (range.window === "held") return firstHeldDate;
  const end = parseDate(lastDate);
  if (Number.isNaN(end)) return null;

  if (range.window === "ytd") {
    return `${new Date(end).getUTCFullYear()}-01-01`;
  }
  // Inclusive of both ends: a 30-day range covers 30 dates, not 31.
  return new Date(end - (range.window - 1) * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/** Resolves a query-string value to a range that the data can actually serve. */
export function resolveRange(
  requested: string | undefined,
  spanDays: number,
  lastDate: string | null = null,
): RangeOption {
  const wanted =
    requested && isRangeId(requested)
      ? rangeById(requested)
      : rangeById(DEFAULT_RANGE);

  // A link to a range the data no longer supports falls back rather than
  // rendering an empty chart.
  return isRangeAvailable(wanted, spanDays, lastDate)
    ? wanted
    : rangeById(DEFAULT_RANGE);
}
