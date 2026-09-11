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
  requiredDays,
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
// A year unlocks up to 1Y, but not the multi-year windows.
assert.deepEqual(
  RANGES.filter((range) => isRangeAvailable(range, 365)).map((r) => r.id),
  ["1m", "3m", "6m", "1y", "all"],
);
// The archive backfill's ~5.7 years unlocks every fixed window.
assert.deepEqual(
  RANGES.filter((range) => isRangeAvailable(range, 2_100)).map((r) => r.id),
  ["1m", "3m", "6m", "1y", "2y", "5y", "all"],
);
assert.equal(isRangeAvailable(byId("2y"), 730), true);
assert.equal(isRangeAvailable(byId("2y"), 729), false);
assert.equal(isRangeAvailable(byId("5y"), 1_825), true);
assert.equal(isRangeAvailable(byId("5y"), 1_824), false);

// --- year to date ---

// YTD is not a fixed window: what it needs depends on how far into the year
// the last date falls, so it is measured against that date, never against
// today. Without a last date it cannot be sized and is treated as unbounded.
assert.equal(requiredDays(byId("ytd"), "2026-09-09"), 252);
assert.equal(requiredDays(byId("ytd"), "2026-01-01"), 1);
assert.equal(requiredDays(byId("ytd"), "2026-12-31"), 365);
// A leap year has the extra day, which a fixed 365 would get wrong.
assert.equal(requiredDays(byId("ytd"), "2024-12-31"), 366);
assert.equal(requiredDays(byId("all"), "2026-09-09"), null);

assert.equal(rangeStart(byId("ytd"), "2026-09-09"), "2026-01-01");
assert.equal(rangeStart(byId("ytd"), "2026-01-01"), "2026-01-01");

// Available only once the history reaches back into January.
assert.equal(isRangeAvailable(byId("ytd"), 252, "2026-09-09"), true);
assert.equal(isRangeAvailable(byId("ytd"), 251, "2026-09-09"), false);
// On New Year's Day the window is a single point, which is not a chart.
assert.equal(isRangeAvailable(byId("ytd"), 5_000, "2026-01-01"), false);
assert.equal(isRangeAvailable(byId("ytd"), 5_000, "2026-01-02"), true);
// With no last date, YTD cannot be sized. It must not fall through to
// "unbounded, always available" -- that is what "All" means, and offering an
// unsizable YTD would render a chart over a window nobody chose.
assert.equal(isRangeAvailable(byId("ytd"), 91), false);
assert.equal(isRangeAvailable(byId("ytd"), 5_000, null), false);
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
// YTD resolution needs the last date, exactly as availability does.
assert.equal(resolveRange("ytd", 2_100, "2026-09-09").id, "ytd");
assert.equal(resolveRange("ytd", 100, "2026-09-09").id, DEFAULT_RANGE);
assert.equal(resolveRange("5y", 2_100, "2026-09-09").id, "5y");

console.log("Range tests passed.");
