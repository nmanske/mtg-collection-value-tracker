import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

/**
 * Connection helpers, deliberately free of `server-only` so that the CLI
 * scripts (migrate, ingest, backfill) can reuse them outside Next.js.
 * Application code should import the shared `db` from `@/db` instead.
 */

export const DB_PATH = process.env.DATABASE_PATH ?? "./data/mtg.db";

/** How long a write waits for another process's write. See `openDatabase`. */
const BUSY_TIMEOUT_MS = Number(process.env.SQLITE_BUSY_TIMEOUT_MS) || 30_000;

/**
 * Opens a SQLite connection with the pragmas this app depends on.
 *
 * - WAL lets the daily ingest job write while the web app reads.
 * - `foreign_keys` is off by default in SQLite and must be set per connection,
 *   or the schema's references are silently unenforced.
 * - `busy_timeout` makes a writer wait out another writer instead of throwing
 *   SQLITE_BUSY. In WAL mode readers never block, so this is only about
 *   writes — and it matters most when two app instances share one database
 *   file, which is the supported way to serve a personal site and a public one
 *   from the same 27 GB of prices. The daily ingest holds the write lock for
 *   seconds at a time and a backfill for far longer; a visitor's upload
 *   landing in that window should wait rather than fail. Five seconds was
 *   enough when one process wrote; it is not now.
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
  sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return sqlite;
}
