/**
 * Tests the chart range rules.
 *
 *   npm run test:ranges
 */
import assert from "node:assert/strict";

import {
  DEFAULT_RANGE,
  RANGES,
  isRangeAvailable,
  isRangeId,
  rangeStart,
  resolveRange,
  spanInDays,
} from "@/lib/ranges";

const byId = (id: string) => RANGES.find((range) => range.id === id)!;

// --- span ---

// Inclusive of both ends: a single day is one day of history, not zero.
assert.equal(spanInDays("2026-09-09", "2026-09-09"), 1);
assert.equal(spanInDays("2026-06-11", "2026-09-09"), 91);
assert.equal(spanInDays("2026-01-01", "2026-12-31"), 365);
// Nonsense in, zero out, rather than a NaN that silently disables everything.
assert.equal(spanInDays("not-a-date", "2026-09-09"), 0);

// --- availability ---

// The real collection: 91 days of history unlocks 1M and 3M but not 6M or 1Y.
const span = 91;
assert.equal(isRangeAvailable(byId("1m"), span), true);
assert.equal(isRangeAvailable(byId("3m"), span), true);
assert.equal(isRangeAvailable(byId("6m"), span), false);
assert.equal(isRangeAvailable(byId("1y"), span), false);
// "All" means whatever exists, so it can never outrun the data.
assert.equal(isRangeAvailable(byId("all"), span), true);
assert.equal(isRangeAvailable(byId("all"), 1), true);

// Exactly on the boundary counts as available.
assert.equal(isRangeAvailable(byId("3m"), 90), true);
assert.equal(isRangeAvailable(byId("3m"), 89), false);

// A month of data unlocks only the month.
assert.deepEqual(
  RANGES.filter((range) => isRangeAvailable(range, 30)).map((r) => r.id),
  ["1m", "all"],
);
// A year unlocks everything.
assert.deepEqual(
  RANGES.filter((range) => isRangeAvailable(range, 365)).map((r) => r.id),
  ["1m", "3m", "6m", "1y", "all"],
);
// A brand new install has only "All".
assert.deepEqual(
  RANGES.filter((range) => isRangeAvailable(range, 1)).map((r) => r.id),
  ["all"],
);

// --- start dates ---

// Counted back from the last date with data, not from today, and inclusive:
// 30 days ending on the 9th starts on the 11th of the previous month.
assert.equal(rangeStart(byId("1m"), "2026-09-09"), "2026-08-11");
assert.equal(rangeStart(byId("3m"), "2026-09-09"), "2026-06-12");
assert.equal(rangeStart(byId("all"), "2026-09-09"), null);

// --- resolution ---

assert.equal(isRangeId("3m"), true);
assert.equal(isRangeId("2w"), false);

assert.equal(resolveRange("3m", span).id, "3m");
assert.equal(resolveRange(undefined, span).id, DEFAULT_RANGE);
assert.equal(resolveRange("nonsense", span).id, DEFAULT_RANGE);
// A link to a range the data cannot fill falls back rather than rendering an
// empty chart.
assert.equal(resolveRange("1y", span).id, DEFAULT_RANGE);
assert.equal(resolveRange("1y", 400).id, "1y");

console.log("Range tests passed.");
