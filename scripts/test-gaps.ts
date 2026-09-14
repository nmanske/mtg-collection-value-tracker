/**
 * Tests the price-timeline gap audit.
 *
 *   npm run test:gaps
 */
import assert from "node:assert/strict";

import {
  BUILD_WINDOW_DAYS,
  buildGapReport,
  classifyGap,
  daysBetween,
  findGaps,
} from "@/lib/gaps";

const day = (i: number) =>
  new Date(Date.UTC(2021, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

// --- spans ---

assert.equal(daysBetween("2021-01-01", "2021-01-02"), 1);
assert.equal(daysBetween("2021-01-01", "2021-01-01"), 0);
// Crossing a leap day, which a fixed 365 would get wrong.
assert.equal(daysBetween("2024-02-28", "2024-03-01"), 2);

// --- finding runs ---

// Contiguous dates have no gaps at all.
assert.deepEqual(findGaps([day(0), day(1), day(2)]), []);
// A single date cannot have a gap, and neither can none.
assert.deepEqual(findGaps([day(0)]), []);
assert.deepEqual(findGaps([]), []);

const gaps = findGaps([day(0), day(1), day(5), day(6), day(20)]);
assert.equal(gaps.length, 2);
// Reported as a run with its own bounds, not as loose dates: the cause of a
// gap is a run, and 1,469 bare dates say nothing a reader can act on.
assert.deepEqual(gaps[0], {
  after: day(1),
  before: day(5),
  missing: 3,
  firstMissing: day(2),
  lastMissing: day(4),
});
assert.equal(gaps[1].missing, 13);

// --- classification ---

const gapAt = (first: string, last = first) => ({
  after: "ignored",
  before: "ignored",
  missing: daysBetween(first, last) + 1,
  firstMissing: first,
  lastMissing: last,
});

// A build's window ends on its build date and reaches back ~90 days, so a build
// dated after the gap covers it only if it is close enough.
assert.equal(
  classifyGap(gapAt("2021-06-01"), ["2021-06-10"], "2021-12-31"),
  "not-published",
  "an ingested build covers the day, so upstream simply had no price",
);
assert.equal(
  classifyGap(gapAt("2021-06-01"), ["2021-06-10"], "2021-01-01"),
  "pending",
  "the covering build is past the watermark, so it has not been read yet",
);

// Exactly on the window boundary, and one day past it.
const inWindow = day(0);
const edge = new Date(
  Date.UTC(2021, 0, 1) + (BUILD_WINDOW_DAYS - 1) * 86_400_000,
).toISOString().slice(0, 10);
const past = new Date(
  Date.UTC(2021, 0, 1) + BUILD_WINDOW_DAYS * 86_400_000,
).toISOString().slice(0, 10);
assert.equal(classifyGap(gapAt(inWindow), [edge], "2030-01-01"), "not-published");
assert.equal(
  classifyGap(gapAt(inWindow), [past], "2030-01-01"),
  "no-build",
  "a build further back than its own window cannot supply the day",
);

// Three Kaggle packages are permanently gone upstream; the days only they
// covered are reported as such rather than blamed on a missed run.
assert.equal(
  classifyGap(gapAt("2021-06-01"), ["2021-01-01", "2021-12-01"], "2030-01-01"),
  "no-build",
);

// Past the newest build, only the daily job could have recorded the day. This
// is the one reason that means something is actually wrong.
assert.equal(
  classifyGap(gapAt("2026-09-10"), ["2026-06-01"], "2026-06-01"),
  "missed-run",
);

// A build with no watermark at all has been ingested by nothing.
assert.equal(
  classifyGap(gapAt("2021-06-01"), ["2021-06-10"], null),
  "not-published",
);

// --- report ---

const report = buildGapReport(
  [day(0), day(1), day(5), "2026-09-09", "2026-09-11"],
  [day(3), "2026-06-01"],
  day(3),
);
assert.equal(report.dates, 5);
assert.equal(report.first, day(0));
assert.equal(report.last, "2026-09-11");
assert.equal(report.totalMissing, report.gaps.reduce((s, g) => s + g.missing, 0));
// The 2026-09-10 hole is past the newest build: a missed run, not upstream.
assert.equal(report.missingByReason["missed-run"], 1);
// Totals by reason account for every missing day exactly once.
assert.equal(
  Object.values(report.missingByReason).reduce((s, n) => s + n, 0),
  report.totalMissing,
);

// Build dates are sorted defensively; an unsorted archive must not change the
// verdict, since "newest build" is what separates a missed run from upstream.
assert.deepEqual(
  buildGapReport([day(0), day(5)], ["2026-06-01", day(3)], day(3))
    .missingByReason,
  buildGapReport([day(0), day(5)], [day(3), "2026-06-01"], day(3))
    .missingByReason,
);

console.log("Gap audit tests passed.");
