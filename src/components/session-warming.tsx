"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * The wait while an uploaded collection is priced.
 *
 * The work happens in a child process, so this page is genuinely idle: it asks
 * the server again every second and the server answers instantly, because it
 * is not the thing doing the work. That is the point of the whole arrangement
 * — the wait is one visitor's now, not everybody's.
 *
 * The bar is fed by the worker, which writes its progress to the session row
 * as it goes. What it says is what is happening: reading prices for most of
 * the time, then a sweep through the months at the end. Those proportions are
 * not a design choice — see `viewFraction`, where they come from measurement.
 */
export function SessionWarming({
  label,
  holdings,
  percent,
  step,
  detail,
}: {
  label: string;
  holdings: number;
  percent: number;
  step: string | null;
  detail: string | null;
}) {
  const router = useRouter();

  useEffect(() => {
    const poll = setInterval(() => router.refresh(), 1_000);
    return () => clearInterval(poll);
  }, [router]);

  return (
    <main className="page-shell py-16">
      <div className="mx-auto max-w-md">
        <h1 className="text-xl font-medium">Pricing {label}</h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          {holdings.toLocaleString()} holding{holdings === 1 ? "" : "s"}
        </p>

        <div
          className="mt-6 h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Pricing progress"
        >
          {/* Transitioned over the poll interval, so the bar glides between
              updates rather than stepping once a second. */}
          <div
            className="h-full rounded-full bg-neutral-900 transition-[width] duration-1000 ease-linear dark:bg-neutral-100"
            style={{ width: `${Math.max(2, percent)}%` }}
          />
        </div>

        <div className="mt-2 flex items-baseline justify-between gap-4 text-sm">
          <span className="text-neutral-800 dark:text-neutral-200" aria-live="polite">
            {step ?? "Starting"}
          </span>
          <span className="tabular-nums text-neutral-600 dark:text-neutral-400">
            {percent}%
          </span>
        </div>

        {/* The line that actually moves. A card name during the long read,
            a day count while valuing — truncated rather than wrapped, so the
            layout does not jump every time a longer name goes past. */}
        <p className="mt-1 h-4 truncate text-xs text-neutral-600 dark:text-neutral-400">
          {detail ?? ""}
        </p>

        <p className="mt-6 text-xs text-neutral-600 dark:text-neutral-400">
          This page updates itself; there is no need to reload.
        </p>
      </div>
    </main>
  );
}
