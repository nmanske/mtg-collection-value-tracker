/**
 * A fixed-window rate limiter, in memory.
 *
 * Uploads are the expensive thing here: each one starts a CPU-bound worker
 * that reads tens of millions of price rows and can run for two minutes. Nothing else on the site can be
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
  options: RateLimitOptions,
  now = Date.now(),
): RateLimitResult {
  const result = peekRateLimit(key, options, now);
  if (result.ok) recordHit(key, options, now);
  return result;
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

/**
 * Whether this key is within its limit, without spending anything.
 *
 * Separate from counting because the two happen at different moments for the
 * expensive limit: an upload is checked before the file is read, so a refusal
 * stays cheap, but counted only once it has actually started a worker. A file
 * that turns out to be the wrong CSV is the commonest reason anyone tries
 * twice in a row, and charging a ten-minute quota for it would punish exactly
 * the person who most needs another go.
 */
export function peekRateLimit(
  key: string,
  options: RateLimitOptions,
  now = Date.now(),
): RateLimitResult {
  const current = windows().get(key);
  if (!current || current.resetAt <= now) return { ok: true, retryAfter: 0 };
  if (current.count >= options.limit) {
    return { ok: false, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

/** Spends one against this key. */
export function recordHit(
  key: string,
  options: RateLimitOptions,
  now = Date.now(),
): void {
  const map = windows();
  const current = map.get(key);

  // Expired entries are dropped as they are met. A sweep would be tidier, and
  // this map only grows while requests keep arriving from new addresses.
  if (!current || current.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + options.windowMs });
    pruneOccasionally(map, now);
    return;
  }

  current.count += 1;
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
