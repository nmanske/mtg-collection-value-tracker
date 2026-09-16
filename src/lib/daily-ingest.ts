import { spawn } from "node:child_process";

import { eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { syncMeta } from "@/db/schema";

/**
 * Runs the daily price ingest as a child process.
 *
 * The price job is deliberately NOT imported into the web server. Two reasons,
 * and only the first is about Turbopack:
 *
 * 1. The ingest lives in `.mts` modules using `.mjs` specifiers — the form
 *    `stream-json` forces, being ESM-only — and Turbopack cannot follow them.
 *    Importing it from the scheduler broke the instrumentation hook badly
 *    enough that the server refused to start.
 * 2. More importantly, it should not run in-process anyway. The job parses a
 *    50 MB document and writes several hundred thousand rows behind a 1 GB
 *    page cache. In the server process that competes with request handling for
 *    memory and for the write lock, and an OOM or a parse failure takes the
 *    site down with it. As a child it cannot: the worst case is a non-zero
 *    exit code and yesterday's prices still on screen.
 *
 * So the scheduler stays in-process — it already handles overlap, timezone and
 * validation — and only the heavy work is pushed out. The child is the same
 * CLI a human runs, so there is one code path and `test:today` covers it.
 */

/** The outcome of the most recent run, successful or not. */
export const DAILY_RUN_KEY = "daily_ingest_last_run";

/**
 * How the ingest is invoked. Overridable because the runtime differs by
 * deployment: `tsx` locally, and whatever the image provides in a container.
 * Run through a shell so that `npm` resolves to `npm.cmd` on Windows.
 */
const DEFAULT_COMMAND = "npm run ingest:today -- --rebuild-cache";

/** Half an hour. A healthy run is ~1 minute; anything near this is wedged. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Kills the child *and* anything it started.
 *
 * `shell: true` means the direct child is a shell, and the ingest is its
 * grandchild. `child.kill()` reaps only the shell, leaving the real work
 * running — and because the grandchild still holds the stdio pipes, `close`
 * does not even fire until it finishes on its own. A 30-minute timeout that
 * waits out a wedged ingest anyway is worse than no timeout, because it
 * reports a failure while the write lock is still held.
 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    // No process groups to signal; `taskkill /T` walks the child tree.
    // Detached and unref'd so a failure to reap cannot itself hang the caller.
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      detached: true,
    }).unref();
    return;
  }
  // Negative pid signals the whole group, which `detached: true` created.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone, or never became a group leader. Fall back to the child.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Nothing left to kill.
    }
  }
}

/** How much child output to keep for the failure record. */
const TAIL_LINES = 20;

export interface DailyRunRecord {
  /** ISO timestamp of when the run finished. */
  at: string;
  ok: boolean;
  /** What triggered it — "scheduled", "first run", "manual". */
  reason: string;
  /** Exit code, or null if the child never started or was killed. */
  code: number | null;
  seconds: number;
  /** Empty on success; the tail of the child's output on failure. */
  message: string;
}

export interface RunOptions {
  command?: string;
  timeoutMs?: number;
  cwd?: string;
  log?: (message: string) => void;
}

/**
 * Spawns the ingest and waits for it.
 *
 * Never rejects. A failed price refresh is not worth crashing a scheduler tick
 * for, and the caller needs the record either way — a run that failed is the
 * single most important thing to write down, because the whole reason this
 * exists is that a day went missing without anyone noticing.
 *
 * Returns null when the ingest is deliberately disabled.
 */
export async function runDailyPriceIngest(
  reason: string,
  options: RunOptions = {},
): Promise<DailyRunRecord | null> {
  const log = options.log ?? (() => {});
  const command = options.command ?? process.env.INGEST_COMMAND ?? DEFAULT_COMMAND;

  // An explicitly empty command means the operator drives the ingest from
  // outside — a host cron, a Kubernetes job. Returning null rather than a
  // failed record matters: a deliberate choice must not light up the dashboard
  // as a broken schedule. Prices going stale will still be reported, which is
  // the check that actually belongs to the operator either way.
  if (command.trim() === "") {
    log("prices: INGEST_COMMAND is empty; skipping (run the ingest yourself)");
    return null;
  }
  // Not `??` on the parsed number: an unset variable parses to NaN and a blank
  // one to 0, neither of which `??` catches, and a 0 ms timeout kills the child
  // instantly.
  const configured = Number(process.env.INGEST_TIMEOUT_MS);
  const timeoutMs =
    options.timeoutMs ??
    (Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_TIMEOUT_MS);
  const started = Date.now();

  const finish = (code: number | null, message: string): DailyRunRecord => ({
    at: new Date().toISOString(),
    ok: code === 0,
    reason,
    code,
    seconds: (Date.now() - started) / 1000,
    message: code === 0 ? "" : message,
  });

  log(`prices: running \`${command}\``);

  return await new Promise<DailyRunRecord>((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: options.cwd ?? process.cwd(),
      // The child opens its own connection to the same database file. WAL and
      // `busy_timeout` are what make that safe; nothing is shared in memory.
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Makes the shell a process-group leader on POSIX so the whole tree can
      // be signalled. No effect on Windows, which uses `taskkill` instead.
      detached: process.platform !== "win32",
    });

    const tail: string[] = [];
    const absorb = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        const trimmed = line.trimEnd();
        if (!trimmed) continue;
        log(`prices> ${trimmed}`);
        tail.push(trimmed);
        if (tail.length > TAIL_LINES) tail.shift();
      }
    };
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);

    // `spawn`'s own `timeout` sends SIGTERM but does not tell us why the child
    // died, and a wedged ingest holding the write lock is worth naming.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
      else child.kill();
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(finish(null, `could not start: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve(
          finish(null, `timed out after ${(timeoutMs / 1000).toFixed(0)}s`),
        );
        return;
      }
      resolve(finish(code, tail.join("\n") || `exited with code ${code}`));
    });
  });
}

/** Writes the run record, so a failure is visible rather than silent. */
export function recordDailyRun(
  db: BetterSQLite3Database<Record<string, never>>,
  record: DailyRunRecord,
): void {
  db.insert(syncMeta)
    .values({
      key: DAILY_RUN_KEY,
      value: JSON.stringify(record),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: syncMeta.key,
      set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
    })
    .run();
}

/** Reads the last run record, or null if the job has never run. */
export function lastDailyRun(
  db: BetterSQLite3Database<Record<string, never>>,
): DailyRunRecord | null {
  const row = db
    .select()
    .from(syncMeta)
    .where(eq(syncMeta.key, DAILY_RUN_KEY))
    .get();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as DailyRunRecord;
  } catch {
    // A malformed record must not break the dashboard it is meant to inform.
    return null;
  }
}
