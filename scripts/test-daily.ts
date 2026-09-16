/**
 * Tests the daily price ingest runner — the child-process wrapper, not the
 * ingest itself, which `test:today` already drives from a fixture.
 *
 * What matters here is the failure handling. The job exists because a missed
 * day went unnoticed for five days, so "a failure is recorded and readable"
 * is the property under test, not the happy path.
 *
 *   npm run test:daily
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";

import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { openDatabase } from "@/db/client";
import {
  lastDailyRun,
  recordDailyRun,
  runDailyPriceIngest,
} from "@/lib/daily-ingest";

const PATH = "./data/test-daily.db";
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${PATH}${suffix}`, { force: true });
  }
};
cleanup();
mkdirSync("./data", { recursive: true });

const sqlite = openDatabase(PATH);
const db = drizzle(sqlite);
migrate(db, { migrationsFolder: "./drizzle" });

const quiet = () => {};

/** Asserts a run happened at all, so each case can read its record directly. */
async function run(command: string, timeoutMs?: number) {
  const record = await runDailyPriceIngest("test", {
    command,
    timeoutMs,
    log: quiet,
  });
  assert.ok(record, `expected a run record for \`${command}\``);
  return record;
}

// Wrapped: these scripts run as CommonJS, which has no top-level await.
async function main() {

  // --- a run that succeeds ---

  const ok = await run("node -e \"console.log('recorded 1 day')\"");
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 0);
  assert.equal(ok.reason, "test");
  // No message on success: a record that always carries output gives a reader
  // nothing to scan for.
  assert.equal(ok.message, "");

  // --- a run that fails ---

  const failed = await run("node -e \"console.error('MTGJSON returned 503'); process.exit(1)\"");
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 1);
  // stderr is captured, not just the exit code. "exited with code 1" would not
  // tell anyone whether to retry or to go looking at MTGJSON.
  assert.match(failed.message, /503/);

  // The CLI signals failure with `process.exitCode`, not a throw, so a run that
  // prints an error and exits non-zero must not read as success.
  const softFail = await run("node -e \"console.log('Daily ingest failed: no uuid map'); process.exitCode = 1\"");
  assert.equal(softFail.ok, false);
  assert.match(softFail.message, /no uuid map/);

  // --- a command that cannot start ---

  const missing = await run("definitely-not-a-real-command-xyz");
  assert.equal(missing.ok, false);
  // Either the shell reports it or spawn does; what matters is that it is not ok
  // and that something is written down rather than an empty message.
  assert.ok(missing.message.length > 0);

  // --- a run that hangs ---

  const stuck = await run("node -e \"setTimeout(() => {}, 60000)\"", 400);
  assert.equal(stuck.ok, false);
  assert.match(stuck.message, /timed out/);
  // Killed, not waited out: the point of the timeout is that a wedged ingest
  // holding the write lock does not block the next day's run too.
  assert.ok(stuck.seconds < 30, `killed promptly, took ${stuck.seconds}s`);

  // A blank INGEST_TIMEOUT_MS parses to 0, which `??` does not catch and which
  // would kill every child instantly. It must fall back to the default.
  process.env.INGEST_TIMEOUT_MS = "";
  const blankTimeout = await run("node -e \"console.log('fine')\"");
  assert.equal(blankTimeout.ok, true);
  delete process.env.INGEST_TIMEOUT_MS;

  // --- deliberately disabled ---

  // An empty command means the operator runs the ingest elsewhere. That must
  // read as "not run", not as a failure, or turning the feature off would
  // permanently light up the dashboard as broken.
  const disabled = await runDailyPriceIngest("test", {
    command: "   ",
    log: quiet,
  });
  assert.equal(disabled, null);

  // --- the record survives a round trip ---

  assert.equal(lastDailyRun(db), null, "nothing recorded yet");

  recordDailyRun(db, failed);
  const readBack = lastDailyRun(db);
  assert.ok(readBack);
  assert.equal(readBack.ok, false);
  assert.match(readBack.message, /503/);

  // One row, overwritten: the dashboard asks "is the job healthy", which is a
  // question about the last run, not a log to grow forever.
  recordDailyRun(db, ok);
  assert.equal(lastDailyRun(db)?.ok, true);

  // A record written by an older version, or truncated, must not take the
  // dashboard down with it.
  db.run(
    "update sync_meta set value = 'not json' where key = 'daily_ingest_last_run'",
  );
  assert.equal(lastDailyRun(db), null);
}

main().then(() => {
  sqlite.close();
  cleanup();
  console.log("daily ingest runner: all assertions passed");
});
