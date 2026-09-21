/**
 * A fixed-window rate limiter, in memory.
 *
 * Uploads are the expensive thing here: each one starts a CPU-bound worker
 * that reads tens of millions of price rows. Nothing else on the site can be
 * made to cost that on demand, so nothing else needs limiting.
 *
 * In memory, which means per process. Two things follow, and both are fine for
 * what this defends against: the count resets when the container restarts, and
 * two instances sharing a database each keep their own. This is a guard
 * against one person with a loop, not a distributed-attack defence — that
 * belongs at the proxy, where the connection is, and this is the layer that
 * can be written honestly in twenty lines.
 *
 * Kept free of `server-only` so the logic can be tested directly.
 */

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets. Zero when allowed. */
  retryAfter: number;
}

interface Window {
  count: number;
  resetAt: number;
}

/** Hung off globalThis so a dev server's module reload does not forget. */
const globalForLimit = globalThis as unknown as {
  mtgRateWindows?: Map<string, Window>;
};

function windows(): Map<string, Window> {
  globalForLimit.mtgRateWindows ??= new Map<string, Window>();
  return globalForLimit.mtgRateWindows;
}

/**
 * Counts one attempt against `key`, and says whether to allow it.
 *
 * Fixed windows rather than a token bucket: the failure mode of a fixed window
 * is that someone can spend two windows' worth across a boundary, which for a
 * limit of five uploads a minute is not worth a more complicated
 * implementation or a second timestamp per key.
 */
export function checkRateLimit(
  key: string,
  options: { limit: number; windowMs: number },
  now = Date.now(),
): RateLimitResult {
  const map = windows();

  // Expired entries are dropped as they are met. A sweep would be tidier, and
  // this map only grows while requests keep arriving from new addresses.
  const current = map.get(key);
  if (!current || current.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + options.windowMs });
    pruneOccasionally(map, now);
    return { ok: true, retryAfter: 0 };
  }

  if (current.count >= options.limit) {
    return { ok: false, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
  }

  current.count += 1;
  return { ok: true, retryAfter: 0 };
}

/**
 * Drops expired windows when the map has grown enough to be worth walking.
 *
 * Without this, one address per request would leave an entry behind forever.
 * The threshold keeps it from being a scan on every upload.
 */
function pruneOccasionally(map: Map<string, Window>, now: number): void {
  if (map.size < 1_000) return;
  for (const [key, window] of map) {
    if (window.resetAt <= now) map.delete(key);
  }
}

/** Test seam: forgets every window. */
export function resetRateLimits(): void {
  windows().clear();
}
