/**
 * Downsampling for long chart series.
 *
 * The archive backfill takes the value chart from 89 points to roughly 2,100.
 * A line drawn from more points than the display has pixels is not more
 * accurate, it is noisier: adjacent points land on the same column, and what
 * the reader sees is the thickness of the stroke rather than the shape of the
 * data.
 *
 * The obvious fix — keep every Nth point — is wrong for prices, because a spike
 * that falls between two kept points disappears entirely. A chart that silently
 * loses the day a card doubled is worse than a crowded one.
 *
 * This uses Largest-Triangle-Three-Buckets, which divides the series into
 * buckets and keeps the point in each that forms the largest triangle with its
 * neighbours. That is a proxy for "most changes the shape of the line", so
 * peaks and troughs survive while flat stretches collapse. First and last
 * points are always kept, so the axis never shifts as the threshold changes.
 */

export interface DownsampleOptions<T> {
  /** The value plotted on the y-axis, used to measure a point's significance. */
  value: (point: T) => number;
  /**
   * Folds the points a bucket dropped into the one it kept.
   *
   * Needed for anything counted rather than measured. The value chart draws a
   * bar per acquisition day; without this the bars would vanish along with the
   * points carrying them, and the chart would claim cards were never bought.
   */
  merge?: (kept: T, bucket: readonly T[]) => T;
}

/**
 * Reduces `points` to at most `threshold` entries, preserving visual shape.
 *
 * Returns the input unchanged when it already fits, so a short series is never
 * perturbed and callers need no length check of their own.
 */
export function downsample<T>(
  points: readonly T[],
  threshold: number,
  options: DownsampleOptions<T>,
): T[] {
  const { value, merge } = options;

  // Below three, "every point is an endpoint" and there is nothing to choose.
  if (threshold < 3 || points.length <= threshold) return [...points];

  const out: T[] = [];
  // Buckets span the interior only: the first and last points are fixed, so
  // the algorithm is choosing threshold - 2 of them.
  const bucketSize = (points.length - 2) / (threshold - 2);

  const collect = (from: number, to: number) => points.slice(from, to);
  const emit = (index: number, from: number, to: number) => {
    const kept = points[index];
    out.push(merge ? merge(kept, collect(from, to)) : kept);
  };

  // The first point is always kept, and carries anything before the first
  // bucket boundary so no count is stranded outside every bucket.
  out.push(merge ? merge(points[0], collect(0, 1)) : points[0]);

  let anchor = 0;
  for (let i = 0; i < threshold - 2; i++) {
    const start = Math.floor(i * bucketSize) + 1;
    const end = Math.floor((i + 1) * bucketSize) + 1;

    // The next bucket's average is the triangle's third vertex, which is what
    // makes the choice depend on where the line is going rather than only on
    // where it has been.
    const nextStart = end;
    const nextEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, points.length);
    let avgX = 0;
    let avgY = 0;
    const nextCount = Math.max(nextEnd - nextStart, 1);
    for (let j = nextStart; j < nextEnd; j++) {
      avgX += j;
      avgY += value(points[j]);
    }
    if (nextEnd <= nextStart) {
      // The final bucket has no successor; aim at the last point instead.
      avgX = points.length - 1;
      avgY = value(points[points.length - 1]);
    } else {
      avgX /= nextCount;
      avgY /= nextCount;
    }

    const anchorX = anchor;
    const anchorY = value(points[anchor]);

    let bestIndex = start;
    let bestArea = -1;
    for (let j = start; j < end; j++) {
      // Twice the triangle area; the factor is constant so it never affects
      // which point wins.
      const area = Math.abs(
        (anchorX - avgX) * (value(points[j]) - anchorY) -
          (anchorX - j) * (avgY - anchorY),
      );
      if (area > bestArea) {
        bestArea = area;
        bestIndex = j;
      }
    }

    if (end > start) {
      emit(bestIndex, start, end);
      anchor = bestIndex;
    }
  }

  const lastIndex = points.length - 1;
  // Everything after the final bucket folds into the last point, for the same
  // reason the first point absorbs what precedes the first bucket.
  const tailFrom = Math.floor((threshold - 2) * bucketSize) + 1;
  out.push(
    merge
      ? merge(points[lastIndex], collect(Math.min(tailFrom, lastIndex), points.length))
      : points[lastIndex],
  );

  return out;
}

/**
 * Points to draw for a given plot width.
 *
 * Two points per pixel is the useful ceiling: past that, consecutive points
 * share a column and only thicken the stroke. Kept a little generous so a line
 * still looks continuous rather than polygonal, and floored so a very narrow
 * container still draws a real chart.
 */
export function pointBudget(widthPx: number): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return 800;
  return Math.max(120, Math.round(widthPx * 2));
}
