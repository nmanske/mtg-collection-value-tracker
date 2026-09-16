/**
 * Long-horizon statistics for the collection, computed like-for-like.
 *
 * The naive way to answer "what was my best year" is to read the portfolio
 * chart at two dates and subtract. Both of this app's series make that wrong,
 * in opposite directions:
 *
 * - The **as-held** line rises because cards were bought. Most of a year's
 *   apparent gain is acquisitions, not the market.
 * - The **constant basket** line holds the cards fixed, but a card cannot be
 *   priced before it was printed. Measured on the real collection, 65% of
 *   today's holdings had a price in December 2020 against 100% today, so the
 *   line also rises simply because more of it exists. That is a 35-point drift
 *   masquerading as five years of growth.
 *
 * So each step compares only the holdings priced at *both* of its endpoints,
 * and the steps are chained. Composition changes then affect where one link
 * starts, never the size of a move — the standard treatment for an index whose
 * constituents change, and the only version of "best year" that means what a
 * reader assumes.
 *
 * The chain is anchored at the end rather than the start: the newest point is
 * the basket's real value today, and earlier points are what that same basket
 * was worth. A figure is then directly comparable to the dashboard instead of
 * being an index number that needs translating.
 *
 * Monthly resolution throughout. These are multi-year questions, a daily chain
 * over 1,953 dates would compound 1,953 roundings, and month ends are what a
 * reader recognises.
 */

/** One month-to-month step, over the holdings priced at both ends. */
export interface MonthLink {
  /** The later month, `YYYY-MM`. */
  month: string;
  /** The priced date used for this month, and for the previous one. */
  date: string;
  prevDate: string;
  /** The common basket's value at each end. */
  fromCents: number;
  toCents: number;
  /** Holdings priced at both ends, and those dropped for missing one. */
  compared: number;
  excluded: number;
}

export interface IndexPoint {
  month: string;
  date: string;
  /** The basket's value, in today's composition-adjusted terms. */
  valueCents: number;
  /** Holdings behind this point's link; 0 for the first, which has no link. */
  compared: number;
}

export interface PeriodChange {
  label: string;
  fromDate: string;
  toDate: string;
  fromCents: number;
  toCents: number;
  changeCents: number;
  /** Null when the starting value is zero and a ratio would be meaningless. */
  changeRatio: number | null;
  /**
   * True for a year still in progress.
   *
   * The current year is a nine-month return sitting in a table of twelve-month
   * ones, and it can win "best year" on that basis. It stays eligible — it is
   * genuinely the strongest period — but it must never be presented without
   * saying so.
   */
  partial: boolean;
}

export interface Drawdown {
  peakDate: string;
  peakCents: number;
  troughDate: string;
  troughCents: number;
  depthCents: number;
  depthRatio: number;
  /** Null while the collection has not regained the peak. */
  recoveredDate: string | null;
  /** Months from peak to trough, and from trough back to the peak. */
  monthsToTrough: number;
  monthsToRecover: number | null;
}

/** Whole months between two `YYYY-MM` labels. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function previousMonth(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return m === 1
    ? `${year - 1}-12`
    : `${year}-${String(m - 1).padStart(2, "0")}`;
}

/**
 * Turns the links into a value series, working backwards from a known anchor.
 *
 * Backwards because the anchor that is actually true is the newest one — the
 * basket's real value today. Chaining forwards from the oldest would make the
 * newest point a product of 70 ratios and leave it disagreeing with the
 * dashboard, which is the one number a reader will check it against.
 *
 * A link whose later end is worthless breaks the chain: dividing by it would
 * be a division by zero, and no earlier value can be recovered through it.
 * Everything before such a link is dropped rather than guessed.
 */
export function chainBackward(
  links: MonthLink[],
  anchor: { month: string; date: string; valueCents: number },
): IndexPoint[] {
  const points: IndexPoint[] = [
    {
      month: anchor.month,
      date: anchor.date,
      valueCents: anchor.valueCents,
      compared: links.length > 0 ? links[links.length - 1].compared : 0,
    },
  ];

  let value = anchor.valueCents;
  for (let i = links.length - 1; i >= 0; i -= 1) {
    const link = links[i];
    if (link.toCents <= 0) break;
    value = (value * link.fromCents) / link.toCents;
    points.unshift({
      month: previousMonth(link.month),
      date: link.prevDate,
      valueCents: Math.round(value),
      compared: link.compared,
    });
  }
  return points;
}

/** The last index point in each calendar year. */
function yearEnds(points: IndexPoint[]): Map<number, IndexPoint> {
  const ends = new Map<number, IndexPoint>();
  for (const point of points) ends.set(Number(point.month.slice(0, 4)), point);
  return ends;
}

function change(
  label: string,
  start: IndexPoint,
  end: IndexPoint,
  partial = false,
): PeriodChange {
  return {
    label,
    partial,
    fromDate: start.date,
    toDate: end.date,
    fromCents: start.valueCents,
    toCents: end.valueCents,
    changeCents: end.valueCents - start.valueCents,
    changeRatio:
      start.valueCents > 0 ? end.valueCents / start.valueCents - 1 : null,
  };
}

/**
 * Change across each calendar year.
 *
 * A year is measured from the previous year's last point, so the first year in
 * the data has nothing to measure from and is omitted rather than being
 * compared against its own start — which would silently report a partial year
 * as a full one.
 */
export function annualChanges(points: IndexPoint[]): PeriodChange[] {
  const ends = yearEnds(points);
  const years = [...ends.keys()].sort((a, b) => a - b);
  const changes: PeriodChange[] = [];

  for (const year of years.slice(1)) {
    const start = ends.get(year - 1);
    const end = ends.get(year);
    if (!start || !end) continue;
    // A year whose last point is not December has not finished.
    changes.push(
      change(String(year), start, end, !end.month.endsWith("-12")),
    );
  }
  return changes;
}

/** Change across each month. */
export function monthlyChanges(points: IndexPoint[]): PeriodChange[] {
  const changes: PeriodChange[] = [];
  for (let i = 1; i < points.length; i += 1) {
    changes.push(change(points[i].month, points[i - 1], points[i]));
  }
  return changes;
}

/**
 * The deepest peak-to-trough fall, and whether it has been recovered.
 *
 * Measured by ratio rather than by dollars. A 10% fall from a $15,000 basket
 * is a larger dollar figure than a 30% fall from a $4,000 one, and the second
 * is plainly the worse episode; ranking by dollars would always pick whichever
 * decline happened most recently.
 */
export function maxDrawdown(points: IndexPoint[]): Drawdown | null {
  if (points.length < 2) return null;

  let peak = points[0];
  let best: { peak: IndexPoint; trough: IndexPoint; ratio: number } | null =
    null;

  for (const point of points) {
    if (point.valueCents > peak.valueCents) peak = point;
    if (peak.valueCents <= 0) continue;
    const ratio = 1 - point.valueCents / peak.valueCents;
    if (ratio > 0 && (best === null || ratio > best.ratio)) {
      best = { peak, trough: point, ratio };
    }
  }
  if (!best) return null;

  const episode = best;
  // Recovery is the first point at or above the peak *after* the trough.
  const recovered =
    points.find(
      (point) =>
        point.month > episode.trough.month &&
        point.valueCents >= episode.peak.valueCents,
    ) ?? null;

  return {
    peakDate: episode.peak.date,
    peakCents: episode.peak.valueCents,
    troughDate: episode.trough.date,
    troughCents: episode.trough.valueCents,
    depthCents: episode.peak.valueCents - episode.trough.valueCents,
    depthRatio: episode.ratio,
    recoveredDate: recovered?.date ?? null,
    monthsToTrough: monthsBetween(episode.peak.month, episode.trough.month),
    monthsToRecover: recovered
      ? monthsBetween(episode.trough.month, recovered.month)
      : null,
  };
}

/** The highest point, and how far below it the collection sits now. */
export function highWaterMark(points: IndexPoint[]): {
  date: string;
  valueCents: number;
  monthsSince: number;
  belowRatio: number;
} | null {
  if (points.length === 0) return null;
  const latest = points[points.length - 1];
  let high = points[0];
  for (const point of points) {
    if (point.valueCents > high.valueCents) high = point;
  }
  return {
    date: high.date,
    valueCents: high.valueCents,
    monthsSince: monthsBetween(high.month, latest.month),
    belowRatio:
      high.valueCents > 0 ? 1 - latest.valueCents / high.valueCents : 0,
  };
}

/** Highest and lowest by ratio, ignoring periods with no usable ratio. */
export function extremes(changes: PeriodChange[]): {
  best: PeriodChange | null;
  worst: PeriodChange | null;
} {
  const usable = changes.filter((c) => c.changeRatio !== null);
  if (usable.length === 0) return { best: null, worst: null };
  let best = usable[0];
  let worst = usable[0];
  for (const c of usable) {
    if (c.changeRatio! > best.changeRatio!) best = c;
    if (c.changeRatio! < worst.changeRatio!) worst = c;
  }
  return { best, worst };
}
