import { spawn } from "node:child_process";

/**
 * Prices an uploaded collection out of process.
 *
 * Measured against the real database: 7.4 seconds for 4,000 distinct
 * printings, and about two minutes at the upload limit. better-sqlite3 is
 * synchronous, so
 * every one of those seconds inside a request is a second in which the server
 * answers nobody — not the uploader, not the twenty people reading card pages.
 * On a public URL that is also a denial of service anyone can perform with a
 * text file.
 *
 * So the upload writes its rows, which is fast, and hands the valuing to a
 * child process. The page waits and says so. Nothing here waits on the result;
 * the child records it on the session row and the next poll picks it up.
 */

/** How the worker is launched. The image overrides this; see docker-compose. */
const DEFAULT_COMMAND = "npm run warm:session --";

/**
 * For a worker that has wedged, not for one that is merely large.
 *
 * A collection at the size limit takes about two minutes here, and the box
 * this runs on is slower than the one that was measured — it also transcodes
 * video. Five minutes would have killed legitimate uploads on hardware a
 * couple of times slower, which is the kind of limit that looks fine until
 * somebody with a real collection tries it.
 */
const TIMEOUT_MS = 15 * 60 * 1000;

/**
 * How many may run at once.
 *
 * Each is a CPU-bound process reading tens of millions of price rows. Two is a
 * deliberate floor rather than a tuned number: it keeps one slow upload from
 * blocking every other, while leaving the box able to serve pages. Anything
 * beyond the cap is not dropped — the session stays `pending`, and the page
 * polling it asks again a second later.
 */
const MAX_CONCURRENT = Number(process.env.WARM_CONCURRENCY) || 2;

/**
 * Hung off globalThis rather than module scope, because a dev server
 * re-evaluates modules and would otherwise forget what is already running.
 */
const globalForWarm = globalThis as unknown as {
  mtgWarmRunning?: Set<string>;
};

function running(): Set<string> {
  globalForWarm.mtgWarmRunning ??= new Set<string>();
  return globalForWarm.mtgWarmRunning;
}

function log(message: string) {
  console.log(`[warm] ${message}`);
}

/** Whether this session is being priced right now by this process. */
export function isWarming(sessionId: string): boolean {
  return running().has(sessionId);
}

/**
 * Starts pricing a session, unless it is already being priced or the box is
 * already busy with as many as it will take.
 *
 * Returns whether a child was started. A false is not a failure: the session
 * is still `pending` and the next page load will try again, which is what
 * makes this safe to call from a poll.
 */
export function requestSessionWarm(sessionId: string): boolean {
  const inFlight = running();
  if (inFlight.has(sessionId)) return false;
  if (inFlight.size >= MAX_CONCURRENT) return false;

  const command = process.env.WARM_COMMAND ?? DEFAULT_COMMAND;
  if (command.trim() === "") return false;

  inFlight.add(sessionId);
  const started = Date.now();

  const finish = (note: string) => {
    inFlight.delete(sessionId);
    log(`${sessionId} ${note} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  };

  try {
    // The id is appended as an argument rather than interpolated into the
    // command string: `shell: true` means the string is parsed by a shell, and
    // a session id is the one part of it that did not come from configuration.
    // It is a UUID today, which makes this a guard rather than a fix, and a
    // guard is what stops that from being load-bearing.
    const child = spawn(`${command} ${shellSafe(sessionId)}`, {
      shell: true,
      cwd: process.cwd(),
      env: process.env,
      // The worker logs to the container log; nothing here reads its output,
      // and an unread pipe that fills would block the child.
      stdio: "ignore",
      detached: process.platform !== "win32",
    });

    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          // The whole tree: `shell: true` means the direct child is a shell,
          // and killing only that leaves the real work running while this
          // reports a failure.
          process.kill(process.platform === "win32" ? child.pid : -child.pid);
        } catch {
          child.kill();
        }
      }
    }, TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      finish(`could not start: ${error.message}`);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0 ? "priced" : `worker exited with code ${code}`);
    });

    // The request that triggered this must not be kept alive by it.
    child.unref();
    return true;
  } catch (error) {
    finish(`could not spawn: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Refuses anything that is not a plain id.
 *
 * Session ids come from `randomUUID`, so this can never fire. It exists
 * because the alternative is trusting that forever, on a string that is about
 * to be handed to a shell.
 */
function shellSafe(id: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) {
    throw new Error(`refusing to spawn a worker for id ${JSON.stringify(id)}`);
  }
  return id;
}
