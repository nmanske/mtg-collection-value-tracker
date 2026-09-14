/**
 * Tests the portfolio cache, mostly its refusal to serve a stale answer.
 *
 *   npm run test:cache
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { openDatabase } from "@/db/client";
import {
  cacheFingerprint,
  cacheIsFresh,
  cachedPortfolioSeries,
  rebuildPortfolioCache,
} from "@/db/queries/portfolio-cache";
import { portfolioSeries } from "@/db/queries/valuation";
import { holdings, priceSnapshots, printings, vendorPrices } from "@/db/schema";

const PATH = "./data/test-cache.db";
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${PATH}${suffix}`, { force: true });
};
cleanup();
mkdirSync("./data", { recursive: true });

const sqlite = openDatabase(PATH);
const db = drizzle(sqlite);
migrate(db, { migrationsFolder: "./drizzle" });

let n = 0;
const printing = (name: string) => {
  n += 1;
  return db
    .insert(printings)
    .values({
      scryfallId: `s${n}`,
      oracleId: `o${n}`,
      name,
      setCode: "tst",
      setName: "Test",
      collectorNumber: String(n),
      finishes: ["nonfoil"],
      updatedAt: new Date(),
    })
    .returning({ id: printings.id })
    .all()[0].id;
};

const A = printing("Alpha");
db.insert(priceSnapshots)
  .values([
    { printingKey: A, finish: "nonfoil", date: "2026-01-01", priceCents: 100, source: "mtgjson" },
    { printingKey: A, finish: "nonfoil", date: "2026-01-02", priceCents: 200, source: "mtgjson" },
    // A later date, so a gap fill at 2026-01-03 sits strictly inside the range
    // and moves neither end.
    { printingKey: A, finish: "nonfoil", date: "2026-01-06", priceCents: 300, source: "mtgjson" },
  ])
  .run();
db.insert(vendorPrices)
  .values([
    { printingKey: A, finish: "nonfoil", vendor: "cardkingdom", side: "retail", date: "2026-01-01", priceCents: 500 },
    { printingKey: A, finish: "nonfoil", vendor: "cardkingdom", side: "retail", date: "2026-01-02", priceCents: 600 },
  ])
  .run();
db.insert(holdings)
  .values({
    printingKey: A,
    quantity: 2,
    finish: "nonfoil",
    condition: "NM",
    dateAdded: "2026-01-01",
    createdAt: new Date(),
  })
  .run();

// --- cold cache ---

// Nothing cached yet, so a read must compute rather than return nothing.
assert.equal(cacheIsFresh(db), false);
const cold = cachedPortfolioSeries(db, {});
assert.deepEqual(cold, portfolioSeries(db, {}), "a cold cache computes the real answer");

// --- warm cache ---

const built = rebuildPortfolioCache(db);
assert.equal(built.views, 4, "two price sources times as-held and basket");
assert.equal(cacheIsFresh(db), true);

// Every view must match what computing it directly produces, or the cache is
// quietly serving a different chart from the one the code would draw.
for (const priceSource of ["tcgplayer", "cardkingdom"] as const) {
  for (const constantBasket of [false, true]) {
    assert.deepEqual(
      cachedPortfolioSeries(db, { priceSource, constantBasket }),
      portfolioSeries(db, { priceSource, constantBasket }),
      `cached ${priceSource}${constantBasket ? " basket" : ""} must equal computed`,
    );
  }
}

// The two sources really are different, so the check above is not comparing a
// value against itself.
assert.notEqual(
  cachedPortfolioSeries(db, { priceSource: "tcgplayer" }).points.at(-1)!.valueCents,
  cachedPortfolioSeries(db, { priceSource: "cardkingdom" }).points.at(-1)!.valueCents,
);

// --- staleness ---

// The dangerous case is a holding added today carrying an old acquisition
// date: it rewrites the whole series, and "newer than the cache" would not
// catch it. The fingerprint covers the set, not its age.
const before = cacheFingerprint(db);
const B = printing("Beta");
db.insert(priceSnapshots)
  .values({ printingKey: B, finish: "nonfoil", date: "2026-01-01", priceCents: 50, source: "mtgjson" })
  .run();
db.insert(holdings)
  .values({
    printingKey: B,
    quantity: 1,
    finish: "nonfoil",
    condition: "NM",
    dateAdded: "2026-01-01",
    createdAt: new Date(),
  })
  .run();

assert.notEqual(cacheFingerprint(db), before);
assert.equal(cacheIsFresh(db), false, "a backdated holding must invalidate the cache");
assert.deepEqual(
  cachedPortfolioSeries(db, {}),
  portfolioSeries(db, {}),
  "a stale cache is bypassed, not served",
);

// Each input that can move a point must move the fingerprint.
rebuildPortfolioCache(db);
const checks: [string, () => void][] = [
  ["a quantity change", () => {
    sqlite.prepare("update holdings set quantity = quantity + 1 where printing_key = ?").run(B);
  }],
  ["a price override", () => {
    sqlite.prepare("update holdings set price_override_cents = 999 where printing_key = ?").run(B);
  }],
  ["an acquisition date change", () => {
    sqlite.prepare("update holdings set date_added = '2026-01-02' where printing_key = ?").run(B);
  }],
  ["the inferred-date flag", () => {
    sqlite.prepare("update holdings set date_added_approx = 1 where printing_key = ?").run(B);
  }],
  ["a new price date", () => {
    sqlite
      .prepare("insert into price_snapshots (printing_key, finish, date, price_cents, source, estimated) values (?, 0, '2026-01-09', 123, 1, 0)")
      .run(A);
  }],
  ["a new vendor price date", () => {
    sqlite
      .prepare("insert into vendor_prices (printing_key, finish, vendor, side, date, price_cents) values (?, 0, 1, 0, '2026-01-09', 123)")
      .run(A);
  }],
  ["a removed holding", () => {
    sqlite.prepare("delete from holdings where printing_key = ?").run(B);
  }],
  // The case that actually escaped. An archive backfill fills dates in the
  // *middle* of the range, moving neither the newest nor the oldest, so a
  // fingerprint built from max(date) read as fresh for hours while the
  // database gained 715 days of history. A real backfill also advances its
  // watermark after every build, which is what makes it detectable.
  ["an archive backfill filling a gap", () => {
    sqlite
      .prepare(
        "insert into price_snapshots (printing_key, finish, date, price_cents, source, estimated) values (?, 0, '2026-01-03', 42, 1, 0)",
      )
      .run(A);
    sqlite
      .prepare(
        "insert into sync_meta (key, value, updated_at) values ('mtgjson_archive_max_date', '2099-01-01', 0) on conflict(key) do update set value = excluded.value",
      )
      .run();
  }],
  ["a daily ingest recording a new build", () => {
    sqlite
      .prepare(
        "insert into sync_meta (key, value, updated_at) values ('mtgjson_today_version', '9.9.9', 0) on conflict(key) do update set value = excluded.value",
      )
      .run();
  }],
];

for (const [what, mutate] of checks) {
  rebuildPortfolioCache(db);
  assert.equal(cacheIsFresh(db), true, `cache should be fresh before ${what}`);
  mutate();
  assert.equal(cacheIsFresh(db), false, `${what} must invalidate the cache`);
}

// --- a known limitation, asserted rather than left implicit ---

// Detecting *any* price change without a watermark would mean counting 120
// million rows on every page load. So the contract is narrower: every ingest
// path is detected, and a hand-written INSERT that advances no watermark is
// not. Asserted so the boundary is visible and a future change to it fails
// here rather than surprising someone.
rebuildPortfolioCache(db);
sqlite
  .prepare(
    "insert into price_snapshots (printing_key, finish, date, price_cents, source, estimated) values (?, 0, '2026-01-04', 7, 1, 0)",
  )
  .run(A);
assert.equal(
  cacheIsFresh(db),
  true,
  "a bare mid-range insert is NOT detected — run cache:portfolio after one",
);

sqlite.close();
cleanup();

console.log("Cache tests passed.");
