/**
 * Tests the chart axis helpers.
 *
 * These are here because the axis got it wrong three times in a row, each time
 * only visible in a screenshot: duplicate "$15k" labels, ticks on unreadable
 * values like $13,390, and a gridline at $132.50 labelled "$133".
 *
 *   npm run test:chart
 */
import assert from "node:assert/strict";

import {
  axisMoney,
  dateAxisFormat,
  monthYear,
  niceScale,
  paddedScale,
  shortDate,
} from "@/components/chart-utils";

// --- labels ---

// Whole dollars carry no decimals and are thousands-comma'd.
assert.equal(axisMoney(1_500_000), "$15,000");
assert.equal(axisMoney(13_50000), "$13,500");
assert.equal(axisMoney(0), "$0");

// A tick is never rounded to a value it does not sit on. $132.50 labelled
// "$133" tells the reader something false about where the gridline is.
assert.equal(axisMoney(13_250), "$132.50");
assert.equal(axisMoney(20), "$0.20");
assert.equal(axisMoney(2), "$0.02");
assert.equal(axisMoney(-2_550), "$-25.50");

assert.equal(shortDate("2026-09-09"), "9/9");
assert.equal(shortDate("2026-01-01"), "1/1");
assert.equal(shortDate("2026-12-31"), "12/31");

assert.equal(monthYear("2025-09-09"), "Sep '25");
assert.equal(monthYear("2020-01-31"), "Jan '20");
assert.equal(monthYear("2026-12-01"), "Dec '26");

// --- which label an axis gets ---

const span = (first: string, last: string) => dateAxisFormat([first, last]);

// A quarter of days: the day of the month is the useful part.
assert.equal(span("2026-06-01", "2026-08-30").format("2026-07-04"), "7/4");
// Five years of it is a column of day numbers with nothing to place them
// against, so the year comes back.
assert.equal(span("2020-12-15", "2026-09-17").format("2023-03-04"), "Mar '23");
// The wider label needs more room between ticks, or Recharts packs them
// until they touch.
assert.ok(
  span("2020-12-15", "2026-09-17").minTickGap >
    span("2026-06-01", "2026-08-30").minTickGap,
);
// The boundary is a span, not a date: 180 days keeps the dense label and 181
// does not.
assert.equal(span("2026-01-01", "2026-06-30").format("2026-03-01"), "3/1");
assert.equal(span("2026-01-01", "2026-07-01").format("2026-03-01"), "Mar '26");
// An empty or one-point series must not throw on the way to a label.
assert.equal(dateAxisFormat([]).format("2026-03-01"), "3/1");
assert.equal(dateAxisFormat(["2026-03-01"]).format("2026-03-01"), "3/1");

// --- scale ---

/** Every tick must be a multiple of the step, and the domain must cover them. */
function assertWellFormed(
  result: { domain: [number, number]; ticks: number[] },
  label: string,
) {
  const { domain, ticks } = result;
  assert.ok(ticks.length >= 2, `${label}: expected at least two ticks`);
  assert.equal(ticks[0], domain[0], `${label}: first tick is the domain floor`);
  assert.equal(
    ticks[ticks.length - 1],
    domain[1],
    `${label}: last tick is the domain ceiling`,
  );

  const step = ticks[1] - ticks[0];
  ticks.forEach((tick, index) => {
    assert.equal(
      tick,
      ticks[0] + step * index,
      `${label}: ticks must be evenly spaced`,
    );
  });

  // The whole point: no two ticks may render as the same label.
  const labels = ticks.map(axisMoney);
  assert.equal(
    new Set(labels).size,
    labels.length,
    `${label}: duplicate tick labels ${labels.join(", ")}`,
  );
}

// A collection-sized range: the case that produced "$15k, $15k, $14k, $14k".
const collection = paddedScale([1_387_268, 1_518_672]);
assertWellFormed(collection, "collection");
assert.ok(collection.domain[0] <= 1_387_268);
assert.ok(collection.domain[1] >= 1_518_672);
assert.deepEqual(collection.ticks.map(axisMoney).slice(0, 2), [
  "$13,500",
  "$14,000",
]);

// A mid-price card: the case that produced a $2.50 step and "$133" for $132.50.
const midPrice = paddedScale([13_295, 13_770]);
assertWellFormed(midPrice, "mid price");
// Above a dollar the step snaps to whole dollars, so no half-dollar gridlines.
const midStep = midPrice.ticks[1] - midPrice.ticks[0];
assert.equal(midStep % 100, 0, `expected a whole-dollar step, got ${midStep}`);

// A penny card still needs cents, or every tick reads "$0".
const penny = paddedScale([13, 20]);
assertWellFormed(penny, "penny");
assert.ok(
  penny.ticks.some((tick) => tick % 100 !== 0),
  "a sub-dollar range should use a sub-dollar step",
);

// A perfectly flat series must still produce a usable band rather than a
// zero-height domain.
const flat = paddedScale([5_000, 5_000]);
assertWellFormed(flat, "flat");
assert.ok(flat.domain[1] > flat.domain[0]);

// Degenerate inputs must not loop forever or produce a single tick.
assertWellFormed(niceScale(0, 1), "tiny");
assertWellFormed(niceScale(0, 100_000_000), "huge");
assertWellFormed(paddedScale([0, 0]), "zero");

// Ticks stay evenly spaced and unique across a sweep of realistic ranges.
for (const high of [50, 199, 1_000, 9_999, 100_000, 2_450_000]) {
  assertWellFormed(paddedScale([Math.floor(high * 0.9), high]), `sweep ${high}`);
}

// A series starting near nothing must not pad below zero. The collection is
// worth $0 the day before the first card arrives, and padding under that used
// to produce a -$5,000 tick and a band of dead space.
const fromZero = paddedScale([0, 1_572_000]);
assert.equal(fromZero.domain[0], 0, "money has a floor");
assert.ok(fromZero.ticks.every((t) => t >= 0), "no negative ticks");

// Small values near zero, same rule.
assert.equal(paddedScale([77_200, 1_572_000]).domain[0], 0);

// A series that genuinely goes negative is still drawn honestly.
assert.ok(paddedScale([-500, 500]).domain[0] < 0);

console.log("Chart axis tests passed.");
