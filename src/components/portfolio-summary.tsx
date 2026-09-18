import Link from "next/link";

import type {
  Change,
  PortfolioSummary,
  ValuePoint,
} from "@/db/queries/valuation";
import { formatUsd } from "@/lib/format";
import {
  PRICE_VENDOR_LABEL,
  PRICE_VENDORS,
  type PriceVendor,
} from "@/db/queries/valuation";
import { STALE_AFTER_DAYS } from "@/db/queries/vendors";
import { rangeStart, resolveRange, spanInDays } from "@/lib/ranges";

import { InfoTip } from "./info-tip";
import { PortfolioChart } from "./portfolio-chart";
import { RangePicker } from "./range-picker";

/**
 * The dashboard head: a hero figure for the current value, a row of stat tiles
 * for the change over each window, and the value-over-time chart.
 *
 * A single current number is a stat tile, not a chart — the chart earns its
 * place by carrying the trend that the tiles only summarise.
 */

function ChangeTile({
  label,
  change,
  tip,
}: {
  label: string;
  change: Change;
  tip?: React.ReactNode;
}) {
  if (change.changeCents == null) {
    return (
      <div>
        <div className="text-xs text-neutral-600 dark:text-neutral-400">{label}</div>
        <div className="text-sm text-neutral-400">not enough history</div>
      </div>
    );
  }

  const up = change.changeCents > 0;
  const flat = change.changeCents === 0;
  // Direction is stated in the text and the sign, not by colour alone.
  const tone = flat
    ? "text-neutral-600 dark:text-neutral-400"
    : up
      ? "text-emerald-700 dark:text-emerald-400"
      : "text-red-700 dark:text-red-400";
  const sign = up ? "+" : "";

  return (
    <div>
      <div className="text-xs text-neutral-600 dark:text-neutral-400">
        {label}
        {tip}
      </div>
      <div className={`text-sm font-medium tabular-nums ${tone}`}>
        {sign}
        <span className="money">{formatUsd(change.changeCents)}</span>
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

export function PortfolioSummaryPanel({
  summary,
  buylistPoints,
  range: requestedRange,
  priceSource,
  staleHoldings,
}: {
  summary: PortfolioSummary;
  /** What the collection would fetch if sold, when a buylist exists. */
  buylistPoints?: ValuePoint[];
  range?: string;
  priceSource: PriceVendor;
  /** Holdings this vendor last quoted too long ago to count as current. */
  staleHoldings: number;
}) {
  const last = summary.points.at(-1);

  const first = summary.points[0]?.date ?? null;
  const spanDays = first && last ? spanInDays(first, last.date) : 0;
  const range = resolveRange(requestedRange, spanDays, last?.date ?? null);

  // The first date anything was held, taken from the series rather than
  // queried: every point already carries how many holdings it covers, so the
  // answer is sitting in the data the chart is drawn from.
  const firstHeldDate =
    summary.points.find((point) => point.holdingsHeld > 0)?.date ?? null;
  const from = last ? rangeStart(range, last.date, firstHeldDate) : null;

  // Only on the Card Kingdom view: they are the one vendor here publishing a
  // buy price, so on the TCGplayer view there is no such line to draw.
  const visibleBuylist =
    buylistPoints && from
      ? buylistPoints.filter((point) => point.date >= from)
      : buylistPoints;

  // Filtered from the already-computed series rather than re-queried: the full
  // series has carried prices forward from the beginning, so a slice of it is
  // identical to recomputing the range and costs nothing.
  const visible = from
    ? summary.points.filter((point) => point.date >= from)
    : summary.points;

  return (
    <section
      aria-labelledby="portfolio-heading"
      className="mb-8 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
    >
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="portfolio-heading" className="text-xs text-neutral-600 dark:text-neutral-400">
            Collection value
            {summary.currentDate ? ` · ${summary.currentDate}` : ""}
          </h2>
          {/* Hero figure: the one number the dashboard leads with. */}
          <div className="mt-1 text-4xl font-semibold tabular-nums">
            <span className="money money-lg">
              {formatUsd(summary.currentCents)}
            </span>
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
            <ChangeTile
              label="Price change only"
              change={summary.marketOnly}
              tip={
                <InfoTip label="What “price change only” means">
                  Today&rsquo;s cards valued back through time, so buying is held
                  out and only price movement is left.{" "}
                  {summary.allTime.changeCents != null &&
                  summary.marketOnly.changeCents != null ? (
                    <>
                      Of the {formatUsd(summary.allTime.changeCents)} all-time
                      change, {formatUsd(summary.marketOnly.changeCents)} came
                      from prices and the rest from cards arriving.{" "}
                    </>
                  ) : null}
                  <Link href="/faq#two-lines" className="underline underline-offset-2">
                    More
                  </Link>
                </InfoTip>
              }
            />
          </div>
        </dl>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        {/* Which shop's asking price the whole panel is computed from. Placed
            beside the range rather than near the hero figure, because it
            changes the same thing the range does: what the chart is showing,
            not what the collection is. */}
        <nav aria-label="Price source" className="flex flex-wrap gap-1">
          {PRICE_VENDORS.map((vendor) => {
            const current = vendor === priceSource;
            return (
              <Link
                key={vendor}
                href={`/?prices=${vendor}${requestedRange ? `&range=${requestedRange}` : ""}`}
                scroll={false}
                aria-current={current ? "true" : undefined}
                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  current
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                    : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                }`}
              >
                {PRICE_VENDOR_LABEL[vendor]}
              </Link>
            );
          })}
        </nav>

        <RangePicker
          active={range.id}
          spanDays={spanDays}
          lastDate={last?.date ?? null}
          hrefFor={(id) => `/?range=${id}`}
        />
      </div>

      <PortfolioChart points={visible} buylistPoints={visibleBuylist} />

      {/* One line of footnotes, not four paragraphs. Each states the fact and
          the consequence; the reasoning lives on /faq. */}
      {/* Plain inline flow rather than a flex row: an open tip is a block
          inside an inline `details`, which breaks out to the width of the
          nearest block. As a flex item that block would be the narrow chip,
          and the panel would be a squeezed column. */}
      <div className="mt-3 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
        {range.window === null
          ? `From ${summary.points[0]?.date ?? "—"}`
          : `${visible.length} day${visible.length === 1 ? "" : "s"} to ${last?.date}`}

        {summary.stale ? (
          <>
            {" · "}
            <span className="text-neutral-400">updating…</span>
            <InfoTip label="Why the figures say updating">
              Something changed &mdash; an import, an ingest, a card added
              &mdash; so these are the previous figures while the value history
              is recomputed in the background. Reload in a minute.
            </InfoTip>
          </>
        ) : null}

        {last && last.unpricedHoldings > 0 ? (
          <>
            {" · "}
            <span className="text-amber-700 dark:text-amber-400">
              {last.unpricedHoldings.toLocaleString()} unpriced, excluded
            </span>
            <InfoTip label="Why unpriced holdings are excluded">
              No source quotes {last.unpricedHoldings === 1 ? "it" : "them"} on{" "}
              {last.date}. Left out rather than counted as $0.
            </InfoTip>
          </>
        ) : null}

        {staleHoldings > 0 ? (
          <>
            {" · "}
            {staleHoldings.toLocaleString()} priced from an old quote
            <InfoTip label="Why the vendor table totals less">
              Valued here from {PRICE_VENDOR_LABEL[priceSource]} quotes over{" "}
              {STALE_AFTER_DAYS} days old. The chart keeps them, the vendor table
              drops them, which is why its total is lower.{" "}
              <Link href="/faq#stale" className="underline underline-offset-2">
                More
              </Link>
            </InfoTip>
          </>
        ) : null}

        {visible.some((point) => point.inferredHoldings > 0) ? (
          <>
            {" · "}
            {/* Italic rather than amber. This is a note about provenance, not
                a warning, and colouring it like one made it shout. */}
            <span className="italic">
              {visible.at(-1)!.inferredHoldings.toLocaleString()} estimated dates
            </span>
            <InfoTip label="Why some acquisition dates are estimated">
              Moxfield exports a last-modified date, not a purchase date, so
              cards owned before your first upload share that day. Counted from
              then, so the line understates rather than invents.{" "}
              <Link
                href="/faq#acquisition-dates"
                className="underline underline-offset-2"
              >
                More
              </Link>
            </InfoTip>
          </>
        ) : null}
      </div>

    </section>
  );
}
