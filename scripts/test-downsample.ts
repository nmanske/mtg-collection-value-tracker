/**
 * Tests the chart downsampler.
 *
 *   npm run test:downsample
 */
import assert from "node:assert/strict";

import { downsample, pointBudget } from "@/lib/downsample";

interface P {
  date: string;
  value: number;
  added: number;
}

const value = (p: P) => p.value;
const day = (i: number) =>
  new Date(Date.UTC(2021, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

/** A flat series with one spike, which naive every-Nth sampling would lose. */
const series: P[] = Array.from({ length: 2_100 }, (_, i) => ({
  date: day(i),
  value: 1_000,
  added: 0,
}));
series[937].value = 50_000; // the spike
series[1_500].value = 10; // the trough
for (const i of [12, 300, 937, 2_050]) series[i].added = 7;

// --- pass-through ---

// A series that already fits is returned untouched, so short histories are
// never perturbed and callers need no length check.
const short = series.slice(0, 10);
assert.deepEqual(downsample(short, 100, { value }), short);
assert.deepEqual(downsample(short, 10, { value }), short);
// A threshold too small to have interior buckets is a no-op rather than a
// crash or a two-point line.
assert.deepEqual(downsample(short, 2, { value }), short);

// --- size and endpoints ---

const out = downsample(series, 500, { value });
assert.ok(out.length <= 500, `expected <= 500, got ${out.length}`);
assert.ok(out.length > 400, `expected close to 500, got ${out.length}`);
// Endpoints are fixed, so the x-axis does not shift as the threshold changes.
assert.equal(out[0].date, series[0].date);
assert.equal(out.at(-1)!.date, series.at(-1)!.date);
// Order is preserved; a chart drawn from unsorted dates is nonsense.
const dates = out.map((p) => p.date);
assert.deepEqual(dates, [...dates].sort());

// --- extremes survive ---

// The whole reason for largest-triangle over every-Nth: a spike between two
// evenly spaced samples would vanish, and with it the day the card doubled.
assert.ok(
  out.some((p) => p.value === 50_000),
  "the spike must survive downsampling",
);
assert.ok(
  out.some((p) => p.value === 10),
  "the trough must survive downsampling",
);
// True even when thinning very hard.
const tiny = downsample(series, 20, { value });
assert.ok(tiny.length <= 20);
assert.ok(
  tiny.some((p) => p.value === 50_000),
  "the spike must survive even a 100x reduction",
);

// --- counted values are merged, not dropped ---

// Acquisitions are events, not measurements: dropping the point that carries
// one would make the chart claim cards were never bought.
const merged = downsample(series, 50, {
  value,
  merge: (kept, bucket) => ({
    ...kept,
    added: bucket.reduce((sum, p) => sum + p.added, 0),
  }),
});
assert.equal(
  merged.reduce((sum, p) => sum + p.added, 0),
  series.reduce((sum, p) => sum + p.added, 0),
  "every acquired card must be accounted for after thinning",
);
// Including ones at the very edges, which fall outside every interior bucket.
const edges: P[] = Array.from({ length: 500 }, (_, i) => ({
  date: day(i),
  value: i,
  added: i === 0 || i === 499 ? 5 : 0,
}));
assert.equal(
  downsample(edges, 30, {
    value,
    merge: (kept, bucket) => ({
      ...kept,
      added: bucket.reduce((sum, p) => sum + p.added, 0),
    }),
  }).reduce((sum, p) => sum + p.added, 0),
  10,
  "counts on the first and last points must not be stranded",
);

// Without a merge function the kept points are passed through untouched.
assert.ok(downsample(series, 50, { value }).every((p) => series.includes(p)));

// --- budget ---

// Two points per pixel: past that, neighbours share a column and only thicken
// the stroke.
assert.equal(pointBudget(900), 1_800);
assert.equal(pointBudget(2_400), 4_800);
// A container that has not been measured yet still yields a usable chart
// rather than an empty one.
assert.equal(pointBudget(0), 800);
assert.equal(pointBudget(Number.NaN), 800);
// Never so small that a chart becomes a sketch.
assert.equal(pointBudget(10), 120);

console.log("Downsample tests passed.");
