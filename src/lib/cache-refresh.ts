import { spawn } from "node:child_process";

/**
 * Rebuilds the portfolio cache out of process, at most one at a time.
 *
 * The cache goes stale whenever the holdings or the prices change. Recomputing
 * it inside the request that noticed costs 20-35s, every concurrent request
 * starts its own, and the site reads as hung — which is exactly what adding a
 * single card used to do.
 *
 * So the reader serves what it has, says it is updating, and asks for a
 * rebuild here. The rebuild runs as a child process for the same reason the
 * daily ingest does: it is synchronous, CPU-bound work that would otherwise
 * block the event loop for half a minute, starving every other request and the
 * scheduler with it.
 *
 * Fire and forget. Nothing waits on the result, because the whole point is
 * that the page has already been served.
 */

/** How the rebuild is launched. The image overrides this; see the Dockerfile. */
const DEFAULT_COMMAND = "npm run cache:portfolio";

/** Generous: a rebuild is ~30s, and a wedged one should not block the next. */
const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Module-level, so one rebuild runs at a time however many requests notice.
 * A dev server re-evaluating modules is the reason this hangs off globalThis
 * rather than a plain module variable.
 */
const globalForRebuild = globalThis as unknown as {
  mtgRebuildRunning?: boolean;
  mtgRebuildLastFinished?: number;
};

/**
 * How long to wait after one rebuild before another may start.
 *
 * Without it, a rebuild that does not clear staleness — a bug, or a write that
 * lands mid-rebuild — would have every page load spawning another, forever.
 */
const COOLDOWN_MS = 60 * 1000;

function log(message: string) {
  console.log(`[cache] ${message}`);
}

/** Asks for a rebuild if one is not already running or just finished. */
export function requestCacheRebuild(): void {
  if (globalForRebuild.mtgRebuildRunning) return;

  const last = globalForRebuild.mtgRebuildLastFinished ?? 0;
  if (Date.now() - last < COOLDOWN_MS) return;

  const command = process.env.REBUILD_COMMAND ?? DEFAULT_COMMAND;
  if (command.trim() === "") return;

  globalForRebuild.mtgRebuildRunning = true;
  log(`stale; rebuilding in the background via \`${command}\``);

  const started = Date.now();
  const finish = (note: string) => {
    globalForRebuild.mtgRebuildRunning = false;
    globalForRebuild.mtgRebuildLastFinished = Date.now();
    log(`${note} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  };

  try {
    const child = spawn(command, {
      shell: true,
      cwd: process.cwd(),
      env: process.env,
      // Nothing reads the output, and an unread pipe that fills would block
      // the child. Its own logging goes to the container log via the CLI.
      stdio: "ignore",
      detached: process.platform !== "win32",
    });

    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
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
      finish(code === 0 ? "rebuilt" : `rebuild exited with code ${code}`);
    });

    // The request that triggered this must not be kept alive by it.
    child.unref();
  } catch (error) {
    finish(`could not spawn: ${(error as Error).message}`);
  }
}
