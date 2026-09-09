import Link from "next/link";

import type { Change, PortfolioSummary } from "@/db/queries/valuation";
import { formatUsd } from "@/lib/format";
import {
  RANGES,
  type RangeId,
  isRangeAvailable,
  rangeStart,
  resolveRange,
  spanInDays,
} from "@/lib/ranges";

import { PortfolioChart } from "./portfolio-chart";

/**
 * The dashboard head: a hero figure for the current value, a row of stat tiles
 * for the change over each window, and the value-over-time chart.
 *
 * A single current number is a stat tile, not a chart — the chart earns its
 * place by carrying the trend that the tiles only summarise.
 */

function ChangeTile({ label, change }: { label: string; change: Change }) {
  if (change.changeCents == null) {
    return (
      <div>
        <div className="text-xs text-neutral-500">{label}</div>
        <div className="text-sm text-neutral-400">not enough history</div>
      </div>
    );
  }

  const up = change.changeCents > 0;
  const flat = change.changeCents === 0;
  // Direction is stated in the text and the sign, not by colour alone.
  const tone = flat
    ? "text-neutral-500"
    : up
      ? "text-emerald-700 dark:text-emerald-400"
      : "text-red-700 dark:text-red-400";
  const sign = up ? "+" : "";

  return (
    <div>
      <div className="text-xs text-neutral-500">{label}</div>
      <div className={`text-sm font-medium tabular-nums ${tone}`}>
        {sign}
        {formatUsd(change.changeCents)}
        {change.changeRatio != null ? (
          <span className="ml-1 font-normal">
            ({sign}
            {(change.changeRatio * 100).toFixed(2)}%)
          </span>
        ) : null}
      </div>
      {change.fromDate ? (
        <div className="text-xs text-neutral-400">since {change.fromDate}</div>
      ) : null}
    </div>
  );
}

/**
 * The range buttons.
 *
 * A range the history cannot fill is rendered disabled rather than hidden, so
 * the set of choices stays stable and it is visible that more will unlock as
 * the daily job accumulates days.
 */
function RangePicker({
  active,
  spanDays,
}: {
  active: RangeId;
  spanDays: number;
}) {
  return (
    <nav aria-label="Chart range" className="flex flex-wrap gap-1">
      {RANGES.map((range) => {
        const available = isRangeAvailable(range, spanDays);
        const current = range.id === active;

        if (!available) {
          return (
            <span
              key={range.id}
              aria-disabled="true"
              title={`Needs ${range.days} days of price history; there are ${spanDays}.`}
              className="cursor-not-allowed rounded-md border border-neutral-200 px-2.5 py-1 text-xs text-neutral-300 dark:border-neutral-800 dark:text-neutral-700"
            >
              {range.label}
            </span>
          );
        }

        return (
          <Link
            key={range.id}
            href={`/?range=${range.id}`}
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

export function PortfolioSummaryPanel({
  summary,
  range: requestedRange,
}: {
  summary: PortfolioSummary;
  range?: string;
}) {
  const last = summary.points.at(-1);

  const first = summary.points[0]?.date ?? null;
  const spanDays = first && last ? spanInDays(first, last.date) : 0;
  const range = resolveRange(requestedRange, spanDays);
  const from = last ? rangeStart(range, last.date) : null;

  // Filtered from the already-computed series rather than re-queried: the full
  // series has carried prices forward from the beginning, so a slice of it is
  // identical to recomputing the range and costs nothing.
  const visible = from
    ? summary.points.filter((point) => point.date >= from)
    : summary.points;
  const visibleBasket = from
    ? summary.basketPoints.filter((point) => point.date >= from)
    : summary.basketPoints;

  return (
    <section
      aria-labelledby="portfolio-heading"
      className="mb-8 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
    >
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="portfolio-heading" className="text-xs text-neutral-500">
            Collection value
            {summary.currentDate ? ` · ${summary.currentDate}` : ""}
          </h2>
          {/* Hero figure: the one number the dashboard leads with. */}
          <div className="mt-1 text-4xl font-semibold tabular-nums">
            {formatUsd(summary.currentCents)}
          </div>
        </div>

        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <ChangeTile label="Day" change={summary.day} />
          <ChangeTile label="Week" change={summary.week} />
          <ChangeTile label="Month" change={summary.month} />
          <ChangeTile label="All time" change={summary.allTime} />
          {/* Separated by a rule: this one answers a different question from
              the three beside it — prices only, with buying held out. */}
          <div className="border-l border-neutral-200 pl-8 dark:border-neutral-800">
            <ChangeTile label="Prices only" change={summary.marketOnly} />
          </div>
        </dl>
      </div>

      <div className="mb-3 flex justify-end">
        <RangePicker active={range.id} spanDays={spanDays} />
      </div>

      <PortfolioChart points={visible} basketPoints={visibleBasket} />

      {last && last.unpricedHoldings > 0 ? (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
          {last.unpricedHoldings.toLocaleString()} holding
          {last.unpricedHoldings === 1 ? " has" : "s have"} no price on{" "}
          {last.date} and {last.unpricedHoldings === 1 ? "is" : "are"} excluded
          from these figures.
        </p>
      ) : null}

      {summary.points.length > 0 ? (
        <p className="mt-3 text-xs text-neutral-500">
          {range.days === null
            ? `History begins ${summary.points[0].date}, the earliest price data available.`
            : `Showing ${visible.length} day${visible.length === 1 ? "" : "s"} to ${last?.date}; ${spanDays} days of history are available in total.`} Cards acquired before then count from that date onward.
          {summary.marketOnly.changeCents != null &&
          summary.allTime.changeCents != null ? (
            <>
              {" "}
              Of the {formatUsd(summary.allTime.changeCents)} all-time change,{" "}
              {formatUsd(summary.marketOnly.changeCents)} came from prices and
              the rest from cards entering the collection. The fixed basket is
              the cards you hold today, so it is chosen with hindsight rather
              than being a market index.
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
