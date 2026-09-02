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
 */
export function openDatabase(path: string = DB_PATH) {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return sqlite;
}
