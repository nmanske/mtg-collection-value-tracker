import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

/**
 * Connection helpers, deliberately free of `server-only` so that the CLI
 * scripts (migrate, ingest, backfill) can reuse them outside Next.js.
 * Application code should import the shared `db` from `@/db` instead.
 */

export const DB_PATH = process.env.DATABASE_PATH ?? "./data/mtg.db";

/**
 * Opens a SQLite connection with the pragmas this app depends on.
 *
 * - WAL lets the daily ingest job write while the web app reads.
 * - `foreign_keys` is off by default in SQLite and must be set per connection,
 *   or the schema's references are silently unenforced.
 * - `busy_timeout` makes readers wait out an ingest write instead of throwing
 *   SQLITE_BUSY.
 *
 * The parent directory is created first. better-sqlite3 will make a missing
 * database file but not a missing directory, and `@/db` opens a connection at
 * module scope — so importing it anywhere the directory does not yet exist
 * throws "Cannot open database because the directory does not exist". That is
 * not hypothetical: `next build` collects page data by importing every route,
 * and the Docker build deliberately removes `data/` beforehand, so the image
 * could not be built at all. `migrateOnStart` already did this; doing it here
 * covers every caller.
 */
export function openDatabase(path: string = DB_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return sqlite;
}
