/**
 * Shared chart helpers, so the portfolio chart and the single-card chart use
 * one axis implementation rather than drifting apart.
 */

/** `2026-09-09` -> `9/9`, for a dense time axis. */
export function shortDate(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${Number(month)}/${Number(day)}`;
}

/**
 * Whole dollars, thousands-comma'd.
 *
 * Deliberately not abbreviated to "$15k": a value that moves within a narrow
 * band renders adjacent ticks as duplicate labels — $15k, $15k, $14k, $14k —
 * and the axis stops carrying information.
 */
export function axisMoney(cents: number): string {
  const dollars = cents / 100;
  // Never round a tick label: a gridline at $132.50 labelled "$133" tells the
  // reader something false about where the line sits. Cheap cards need the
  // cents for the same reason — otherwise every tick reads "$0".
  return Number.isInteger(dollars)
    ? `$${dollars.toLocaleString("en-US")}`
    : `$${dollars.toFixed(2)}`;
}

/**
 * Rounds an axis range out to a "nice" step so ticks land on numbers a reader
 * recognises — 13,500 / 14,000 / 14,500 rather than 13,390 / 13,940 / 14,490.
 *
 * Steps come from the 1/2/2.5/5 x 10^n family, chosen to give roughly the
 * requested number of ticks. Everything is in cents; the step never goes below
 * one cent.
 */
export function niceScale(
  low: number,
  high: number,
  targetTicks = 5,
): { domain: [number, number]; ticks: number[] } {
  const span = Math.max(high - low, 1);
  const rough = span / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const factor =
    normalised <= 1
      ? 1
      : normalised <= 2
        ? 2
        : normalised <= 2.5
          ? 2.5
          : normalised <= 5
            ? 5
            : 10;
  let step = Math.max(Math.round(factor * magnitude), 1);
  // Above a dollar, snap the step to whole dollars. The 2.5 factor otherwise
  // produces $2.50 steps, and half-dollar gridlines read as noise on a price
  // axis even when their labels are honest.
  if (step > 100) step = Math.ceil(step / 100) * 100;

  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;

  const ticks: number[] = [];
  for (let value = start; value <= end; value += step) ticks.push(value);

  return { domain: [start, end], ticks };
}

/**
 * A padded domain for a series read for movement rather than magnitude.
 *
 * The axis deliberately does not start at zero: a zero baseline flattens a
 * real move into a straight line. The axis labels state the range instead.
 *
 * It does not go *below* zero either. Padding under a series that starts near
 * nothing — a collection on the day the first card was bought — used to round
 * down to a negative tick, so the chart opened with a band of empty space
 * under an axis labelled -$5,000. Money has a floor and the axis should say so.
 */
export function paddedScale(values: number[], targetTicks = 5) {
  const low = Math.min(...values);
  const high = Math.max(...values);
  // A flat series still needs a visible band around it.
  const pad = Math.max((high - low) * 0.15, Math.max(high * 0.02, 1));
  // Clamped only when the data itself is non-negative, so a series that really
  // does go negative is still drawn honestly.
  const paddedLow = low >= 0 ? Math.max(low - pad, 0) : low - pad;
  return niceScale(paddedLow, high + pad, targetTicks);
}
