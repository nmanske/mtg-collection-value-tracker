"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The wait while an uploaded collection is priced.
 *
 * The work happens in a child process, so this page is genuinely idle: it asks
 * the server again every second and a half, and the server answers instantly
 * because it is not the thing doing the work. That is the whole point of the
 * rearrangement — the wait is now one visitor's, not everybody's.
 *
 * `router.refresh()` rather than a full reload, so the poll costs an RSC
 * payload instead of a document, and so the page does not flash.
 */
export function SessionWarming({
  label,
  holdings,
}: {
  label: string;
  holdings: number;
}) {
  const router = useRouter();
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const poll = setInterval(() => router.refresh(), 1_500);
    const clock = setInterval(() => setSeconds((n) => n + 1), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [router]);

  return (
    <main className="page-shell py-16">
      <div className="mx-auto max-w-lg text-center">
        <div
          aria-hidden
          className="mx-auto mb-6 h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900 dark:border-neutral-700 dark:border-t-neutral-100"
        />
        <h1 className="text-xl font-medium">Pricing {label}</h1>
        <p
          className="mt-2 text-sm text-neutral-600 dark:text-neutral-400"
          role="status"
          aria-live="polite"
        >
          Valuing {holdings.toLocaleString()} holding
          {holdings === 1 ? "" : "s"} against five years of daily prices.
          {seconds > 20
            ? " A large collection takes up to a minute."
            : " This usually takes a few seconds."}
        </p>
        <p className="mt-6 text-xs text-neutral-600 dark:text-neutral-400">
          This page updates itself; there is no need to reload.
        </p>
      </div>
    </main>
  );
}
