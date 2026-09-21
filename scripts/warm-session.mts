/**
 * Prices one uploaded collection, out of process.
 *
 *   npm run warm:session -- <session-id>
 *
 * Spawned by the upload flow. It exists as a separate process for the same
 * reason the daily ingest does: valuing a collection across five years of
 * prices is synchronous, CPU-bound work — measured at 8.5 seconds for a real
 * 3,868-holding collection and 39 seconds at the upload limit — and doing it
 * inside the request blocks the event loop, which means it blocks every other
 * visitor too, not just the one who uploaded.
 *
 * Exit code 0 means the session is ready to look at. Anything else means the
 * session says so itself, in `warm_state`, so the page waiting on it can stop
 * waiting and explain.
 */
import { drizzle } from "drizzle-orm/better-sqlite3";

import { DB_PATH, openDatabase } from "@/db/client";
import {
  getSession,
  setWarmProgress,
  setWarmState,
} from "@/db/queries/sessions";
import { warmSession } from "@/import/session";

const id = process.argv[2];
if (!id) {
  console.error("usage: warm-session <session-id>");
  process.exit(2);
}

const sqlite = openDatabase(DB_PATH);
// The web app holds readers open throughout, and the daily ingest may be
// holding the write lock; wait rather than fail.
sqlite.pragma("busy_timeout = 120000");

/**
 * A second connection, for progress alone.
 *
 * The progress callback fires from inside the loop that reads price rows, and
 * better-sqlite3 refuses to write on a connection while one of its own
 * iterators is open — "This database connection is busy executing a query".
 * Buffering the updates until the read finished would mean no progress during
 * the phase that takes three quarters of the time, which is the phase the bar
 * exists for. A separate connection can write throughout; WAL is what makes
 * that safe.
 */
const statusSqlite = openDatabase(DB_PATH);
statusSqlite.pragma("busy_timeout = 120000");

try {
  const db = drizzle(sqlite);
  const session = getSession(db, id);

  if (!session) {
    // Swept, or forgotten by its owner while this was queued. Not an error:
    // there is simply nothing left to price.
    console.log(`[warm] ${id} no longer exists; nothing to do`);
    process.exit(0);
  }

  const started = Date.now();
  // A list has no acquisition dates, so only the fixed-basket view is drawn
  // for one and only that one is worth computing.
  const basketOnly = session.source !== "csv";

  // Throttled by time rather than by count. The callback fires thousands of
  // times on a large collection, and each write is a transaction the waiting
  // page does not need: a quarter of a second is smoother than the eye and
  // cheaper than the work being measured.
  let lastWrite = 0;
  const status = drizzle(statusSqlite);
  warmSession(db, id, basketOnly, ({ percent, step, detail }) => {
    const now = Date.now();
    if (now - lastWrite < 250) return;
    lastWrite = now;
    try {
      setWarmProgress(status, id, percent, step, detail);
    } catch {
      // Progress is decoration. A collection that priced correctly must not be
      // reported as failed because the bar could not be updated.
    }
  });

  setWarmState(status, id, "ready");
  console.log(
    `[warm] ${id} ready in ${((Date.now() - started) / 1000).toFixed(1)}s` +
      ` (${session.matched} holdings${basketOnly ? ", basket only" : ""})`,
  );
} catch (error) {
  const message = (error as Error).message;
  console.error(`[warm] ${id} failed: ${message}`);
  try {
    setWarmState(drizzle(statusSqlite), id, "failed", message);
  } catch {
    // The database is what just failed; there is nowhere left to record this.
  }
  process.exitCode = 1;
} finally {
  sqlite.close();
  statusSqlite.close();
}
