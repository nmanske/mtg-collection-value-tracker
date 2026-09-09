/**
 * Unit tests for the pure parts of ingestion — the price conversion and the
 * snapshot-date rule. The streaming ingest itself is exercised by running
 * `npm run ingest:scryfall -- --dry-run --limit 5000` against the live file.
 *
 *   npm run test:ingest
 */
import assert from "node:assert/strict";

import { centsToPriceString, priceStringToCents } from "@/ingest/money";
import { snapshotDateFor } from "@/ingest/scryfall";

// Exact conversion: 0.35 * 100 is 34.999... in floating point, so the parser
// must not go via parseFloat.
assert.equal(priceStringToCents("0.35"), 35);
assert.equal(priceStringToCents("1234.50"), 123_450);
assert.equal(priceStringToCents("0.01"), 1);
assert.equal(priceStringToCents("0.1"), 10);
assert.equal(priceStringToCents("7"), 700);
assert.equal(priceStringToCents("  2.99 "), 299);
assert.equal(priceStringToCents("0.00"), 0);
assert.equal(priceStringToCents("29999.99"), 2_999_999);

// Absence stays absence — never coerced to zero.
assert.equal(priceStringToCents(null), null);
assert.equal(priceStringToCents(undefined), null);
assert.equal(priceStringToCents(""), null);
assert.equal(priceStringToCents("N/A"), null);
assert.equal(priceStringToCents("1.234"), null);
assert.equal(priceStringToCents("1,234.00"), null);

assert.equal(centsToPriceString(35), "0.35");
assert.equal(centsToPriceString(123_450), "1234.50");
assert.equal(centsToPriceString(0), "0.00");
assert.equal(centsToPriceString(5), "0.05");

// Round-trip over a spread of values.
for (const value of ["0.01", "0.35", "9.99", "150.00", "29999.99"]) {
  assert.equal(centsToPriceString(priceStringToCents(value)!), value);
}

// Snapshots are filed under the bulk file's build date, in UTC.
assert.equal(snapshotDateFor("2026-09-09T09:05:20.214+00:00"), "2026-09-09");
// A build stamped just before midnight UTC files against that day, even for a
// reader in a timezone where it is already tomorrow.
assert.equal(snapshotDateFor("2026-09-09T23:58:00.000+00:00"), "2026-09-09");
// ...and an offset timestamp is normalised to UTC rather than taken at face
// value: 20:05 on the 9th at -05:00 is 01:05 on the 10th UTC.
assert.equal(snapshotDateFor("2026-09-09T20:05:00.000-05:00"), "2026-09-10");

console.log("Ingest unit tests passed.");
