/**
 * Time ranges for the value chart.
 *
 * A range is only offered when the price history actually spans it. Showing
 * "1 year" against three months of data would stretch a short series across a
 * wide axis and imply history that does not exist, so the shorter ranges are
 * enabled as the data grows into them.
 */

export interface RangeOption {
  id: RangeId;
  label: string;
  /** Days the range covers. `null` means everything available. */
  days: number | null;
}

export type RangeId = "1m" | "3m" | "6m" | "1y" | "all";

export const RANGES: RangeOption[] = [
  { id: "1m", label: "1M", days: 30 },
  { id: "3m", label: "3M", days: 90 },
  { id: "6m", label: "6M", days: 180 },
  { id: "1y", label: "1Y", days: 365 },
  { id: "all", label: "All", days: null },
];

export const DEFAULT_RANGE: RangeId = "all";

export function isRangeId(value: string): value is RangeId {
  return RANGES.some((range) => range.id === value);
}

/** Inclusive span in days between two `YYYY-MM-DD` dates. */
export function spanInDays(first: string, last: string): number {
  const from = Date.parse(`${first}T00:00:00Z`);
  const to = Date.parse(`${last}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000) + 1;
}

/**
 * Whether a range is worth offering, given how much history exists.
 *
 * `All` is always available — it means "whatever there is" and cannot outrun
 * the data. Every other range needs the history to cover it.
 */
export function isRangeAvailable(range: RangeOption, spanDays: number): boolean {
  if (range.days === null) return true;
  return spanDays >= range.days;
}

/**
 * The earliest date a range should show, or null for everything.
 *
 * Counted back from the last date with data rather than from today: if the
 * daily job has not run yet, "1 month" should still mean the most recent month
 * of prices rather than a window that is partly in the future.
 */
export function rangeStart(range: RangeOption, lastDate: string): string | null {
  if (range.days === null) return null;
  const end = Date.parse(`${lastDate}T00:00:00Z`);
  if (Number.isNaN(end)) return null;
  // Inclusive of both ends: a 30-day range covers 30 dates, not 31.
  const start = end - (range.days - 1) * 86_400_000;
  return new Date(start).toISOString().slice(0, 10);
}

/** Resolves a query-string value to a range that the data can actually serve. */
export function resolveRange(
  requested: string | undefined,
  spanDays: number,
): RangeOption {
  const wanted =
    requested && isRangeId(requested)
      ? RANGES.find((range) => range.id === requested)!
      : RANGES.find((range) => range.id === DEFAULT_RANGE)!;

  // A link to a range the data no longer supports falls back rather than
  // rendering an empty chart.
  return isRangeAvailable(wanted, spanDays)
    ? wanted
    : RANGES.find((range) => range.id === DEFAULT_RANGE)!;
}
