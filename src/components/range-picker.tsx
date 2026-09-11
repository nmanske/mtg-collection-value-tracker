import Link from "next/link";

import {
  isRangeAvailable,
  RANGES,
  type RangeId,
  requiredDays,
} from "@/lib/ranges";

/**
 * The range buttons, shared by the portfolio chart and a card's price history.
 *
 * A range the history cannot fill is rendered disabled rather than hidden, so
 * the set of choices stays stable and it is visible that more will unlock as
 * data accumulates. That matters more on a card page than on the dashboard: a
 * newly printed card has weeks of history while the collection has years, and
 * hiding the difference would make the two charts look comparable when they
 * are not.
 *
 * `hrefFor` rather than a fixed path, because each caller has its own other
 * query parameters to preserve — the card page must keep `finish`, or changing
 * the range would silently switch which printing's series is shown.
 */
export function RangePicker({
  active,
  spanDays,
  lastDate,
  hrefFor,
}: {
  active: RangeId;
  spanDays: number;
  lastDate: string | null;
  hrefFor: (id: RangeId) => string;
}) {
  return (
    <nav aria-label="Chart range" className="flex flex-wrap gap-1">
      {RANGES.map((range) => {
        const available = isRangeAvailable(range, spanDays, lastDate);
        const current = range.id === active;

        if (!available) {
          const needed = requiredDays(range, lastDate);
          return (
            <span
              key={range.id}
              aria-disabled="true"
              title={
                needed === null
                  ? `${range.description} is not available yet.`
                  : `Needs ${needed} days of history for ${range.description}; there ${spanDays === 1 ? "is" : "are"} ${spanDays}.`
              }
              className="cursor-not-allowed rounded-md border border-neutral-200 px-2.5 py-1 text-xs text-neutral-300 dark:border-neutral-800 dark:text-neutral-700"
            >
              {range.label}
            </span>
          );
        }

        return (
          <Link
            key={range.id}
            href={hrefFor(range.id)}
            scroll={false}
            aria-current={current ? "true" : undefined}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              current
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            }`}
          >
            {range.label}
          </Link>
        );
      })}
    </nav>
  );
}
