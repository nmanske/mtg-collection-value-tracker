/**
 * Runs once when a Next.js server instance starts, before it serves requests.
 *
 * Applies pending migrations and starts the daily price refresh, so that a
 * `docker compose up` needs no second process and no manual setup step.
 */
export async function register() {
  // `register` is called in every runtime. The scheduler needs Node APIs —
  // better-sqlite3, timers, the filesystem — so it must not load on the edge.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startScheduler } = await import("@/lib/scheduler");
  await startScheduler();
}
