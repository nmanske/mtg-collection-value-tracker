import type { PriceFreshness } from "@/db/queries/freshness";

/**
 * Says so when prices have stopped arriving.
 *
 * Silent when healthy. A banner that is always on screen is furniture, and the
 * whole point is to be noticed on the one day it appears — a stale chart looks
 * identical to a fresh one, which is how 2026-09-10 went missing for five days.
 *
 * Two separate conditions, because they need different actions:
 *  - prices are behind → run the ingest, and hurry if it is near 90 days
 *  - the last automated run failed → the schedule is broken, not just a day
 * A failed run is shown even when prices are current, since the failure is the
 * warning that tomorrow will not be.
 */
export function PriceFreshnessBanner({
  freshness,
}: {
  freshness: PriceFreshness;
}) {
  const { stale, daysBehind, newestDate, lastRun } = freshness;
  const runFailed = lastRun !== null && !lastRun.ok;
  if (!stale && !runFailed) return null;

  return (
    <div
      role="status"
      className="mb-8 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/40"
    >
      {stale && newestDate !== null && (
        <p className="text-amber-900 dark:text-amber-200">
          <strong className="font-semibold">Prices are {daysBehind} days behind.</strong>{" "}
          The newest quote is from {newestDate}. Run{" "}
          <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/60">
            npm run ingest:today
          </code>{" "}
          to catch up.
          {/* Named explicitly: the cost of ignoring this is not obvious, and it
              is the reason the warning is worth interrupting for. */}
          {daysBehind !== null && daysBehind > 60 && (
            <>
              {" "}
              MTGJSON only serves about 90 days of history, so these days become
              unrecoverable soon.
            </>
          )}
        </p>
      )}
      {runFailed && lastRun && (
        <p className="mt-2 text-amber-900 first:mt-0 dark:text-amber-200">
          <strong className="font-semibold">The last automatic run failed</strong>{" "}
          ({new Date(lastRun.at).toLocaleString()}).
          <span className="mt-1 block whitespace-pre-wrap break-words font-mono text-xs text-amber-800 dark:text-amber-300">
            {lastRun.message}
          </span>
        </p>
      )}
    </div>
  );
}
