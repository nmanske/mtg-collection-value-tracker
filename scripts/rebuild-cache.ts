/**
 * Recomputes the precomputed portfolio totals.
 *
 *   npm run cache:portfolio
 *
 * Run after an ingest or a collection import. The dashboard also rebuilds on
 * demand when it notices the cache is stale, so this is an optimisation of when
 * that cost is paid, not a correctness requirement.
 */
import { drizzle } from "drizzle-orm/better-sqlite3";

import { DB_PATH, openDatabase } from "@/db/client";
import {
  cacheIsFresh,
  rebuildPortfolioCache,
} from "@/db/queries/portfolio-cache";

const sqlite = openDatabase(DB_PATH);
sqlite.pragma("busy_timeout = 120000");

try {
  const db = drizzle(sqlite);
  console.log(cacheIsFresh(db) ? "Cache is current; rebuilding anyway." : "Cache is stale.");
  const result = rebuildPortfolioCache(db, (message) => console.log(message));
  console.log(
    `\n${result.views} views, ${result.points.toLocaleString()} points, ${result.seconds.toFixed(1)}s`,
  );
} catch (error) {
  console.error(`Cache rebuild failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  sqlite.close();
}
