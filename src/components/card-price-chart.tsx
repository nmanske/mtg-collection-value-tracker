"use client";

import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { PricePoint } from "@/db/queries/printings";
import { downsample, pointBudget } from "@/lib/downsample";

import { ChartFrame } from "./chart-frame";
import { formatUsd } from "@/lib/format";

import { axisMoney, paddedScale, shortDate } from "./chart-utils";

/**
 * One printing-and-finish's price history.
 *
 * Same single-series treatment as the portfolio chart — no legend, one
 * validated hue, an end marker rather than a dot per day — so the two charts
 * read as one system.
 *
 * Estimated points are drawn as a separate, dashed series on top of the real
 * one. Nothing in the database is estimated yet: flat-fill is deferred, so the
 * dashed series is currently always empty. It exists because a synthetic price
 * must never be presented as though it were tracked data, and wiring that in
 * after the fact is how it gets forgotten.
 */

interface Row {
  date: string;
  priceCents: number;
  /** Card Kingdom's buy price on the same day, when they publish one. */
  buylistCents: number | null;
  /** The same value, but only on estimated points, so it draws separately. */
  estimatedCents: number | null;
  source: string;
  estimated: boolean;
}

interface TooltipProps {
  active?: boolean;
  payload?: { payload: Row }[];
}

function PriceTooltip({ active, payload }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;

  return (
    <div className="rounded-md border border-[var(--viz-grid)] bg-[var(--viz-surface)] px-3 py-2 text-xs shadow-sm">
      <div className="font-medium text-[var(--viz-text)]">{row.date}</div>
      <div className="mt-1 flex items-center gap-1.5">
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full bg-[var(--viz-series)]"
        />
        <span className="tabular-nums text-[var(--viz-text)]">
          {formatUsd(row.priceCents)}
        </span>
      </div>
      {row.buylistCents != null ? (
        <div className="mt-1 flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-0.5 w-2 rounded-full bg-[var(--viz-series-2)]"
          />
          <span className="tabular-nums text-[var(--viz-text)]">
            {formatUsd(row.buylistCents)}
          </span>
          <span className="text-[var(--viz-muted)]">buylist</span>
        </div>
      ) : null}
      <div className="mt-0.5 text-[var(--viz-muted)]">
        {row.estimated ? "estimated — not tracked data" : `via ${row.source}`}
      </div>
    </div>
  );
}

function CardPriceChartBody({
  points,
  buylist,
  width,
  plotClass,
}: {
  points: PricePoint[];
  buylist?: { date: string; priceCents: number }[];
  width: number;
  /** Height classes for the plot element; see ChartFrame. */
  plotClass: string;
}) {
  const gradientId = useId();

  if (points.length < 2) {
    return (
      <p className="rounded-lg border border-dashed border-neutral-300 py-10 text-center text-sm text-neutral-600 dark:text-neutral-400 dark:border-neutral-700">
        {points.length === 0
          ? "No price history for this printing and finish."
          : "Only one day of price data so far — not enough to chart."}
      </p>
    );
  }

  // Keyed by date rather than zipped: the two series are published on their
  // own schedules and a buy price is missing on plenty of days.
  const buylistByDate = new Map(
    (buylist ?? []).map((point) => [point.date, point.priceCents]),
  );
  const hasBuylist = buylistByDate.size > 0;
  // The caller passes a buylist only on the Card Kingdom view, so this says
  // "Card Kingdom is selected" where hasBuylist says "there is a line to
  // draw". The table column follows the selection: a card nobody buys should
  // say so with dashes, not by quietly dropping the column.
  const buylistSelected = buylist != null;

  const full: Row[] = points.map((point) => ({
    date: point.date,
    priceCents: point.priceCents,
    buylistCents: buylistByDate.get(point.date) ?? null,
    estimatedCents: point.estimated ? point.priceCents : null,
    source: point.source,
    estimated: point.estimated,
  }));

  // Thinned to the plot's own width. Largest-triangle keeps the turning
  // points, so a spike that made the card interesting survives instead of
  // falling between two evenly spaced samples.
  const data = downsample(full, pointBudget(width), {
    value: (row) => row.priceCents,
  });

  const last = data[data.length - 1];
  // Both series share the axis, so the scale has to cover the lower one too or
  // the buylist line would be clipped off the bottom.
  const { domain, ticks } = paddedScale(
    data.flatMap((row) =>
      row.buylistCents == null
        ? [row.priceCents]
        : [row.priceCents, row.buylistCents],
    ),
  );
  const hasEstimates = data.some((row) => row.estimated);

  return (
    <figure className="viz-root m-0">
      <div className={`${plotClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--viz-series)" stopOpacity={0.18} />
                <stop offset="100%" stopColor="var(--viz-series)" stopOpacity={0.02} />
              </linearGradient>
            </defs>

            <CartesianGrid
              stroke="var(--viz-grid)"
              strokeWidth={1}
              vertical={false}
            />

            <XAxis
              dataKey="date"
              tickFormatter={shortDate}
              tickLine={false}
              axisLine={{ stroke: "var(--viz-grid)" }}
              tick={{ fill: "var(--viz-muted)", fontSize: 11 }}
              minTickGap={28}
            />
            <YAxis
              domain={domain}
              ticks={ticks}
              tickFormatter={axisMoney}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--viz-muted)", fontSize: 11 }}
              width={64}
            />

            <Tooltip
              content={<PriceTooltip />}
              cursor={{ stroke: "var(--viz-grid)", strokeWidth: 1 }}
            />

            <Area
              type="monotone"
              dataKey="priceCents"
              stroke="var(--viz-series)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{
                r: 4,
                fill: "var(--viz-series)",
                stroke: "var(--viz-surface)",
                strokeWidth: 2,
              }}
              isAnimationActive={false}
            />

            {/* Card Kingdom's buy price. Dashed, thinner and unfilled: it is
                context for the retail line, not a second headline, and the two
                answer different questions — what a card costs against what one
                shop will pay for it. `connectNulls` because a missing buy
                price is a day they did not publish one, not a day it was
                worth nothing. */}
            {hasBuylist ? (
              <Area
                type="monotone"
                dataKey="buylistCents"
                stroke="var(--viz-series-2)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                fill="none"
                dot={false}
                connectNulls
                activeDot={{
                  r: 3,
                  fill: "var(--viz-series-2)",
                  stroke: "var(--viz-surface)",
                  strokeWidth: 2,
                }}
                isAnimationActive={false}
              />
            ) : null}

            {/* Estimated stretches, drawn dashed and unfilled over the real
                line so a guess never looks like a measurement. */}
            <Area
              type="monotone"
              dataKey="estimatedCents"
              stroke="var(--viz-series)"
              strokeWidth={2}
              strokeDasharray="4 3"
              strokeOpacity={0.7}
              fill="none"
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />

            <ReferenceDot
              x={last.date}
              y={last.priceCents}
              r={4}
              fill="var(--viz-series)"
              stroke="var(--viz-surface)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {hasBuylist ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--viz-muted)]">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-0.5 w-4 rounded-full bg-[var(--viz-series)]"
            />
            <span className="text-[var(--viz-text)]">Retail</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-0.5 w-4 bg-[var(--viz-series-2)]"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 7px)",
              }}
            />
            <span className="text-[var(--viz-text)]">
              Card Kingdom buylist
            </span>
          </span>
        </p>
      ) : null}

      {hasEstimates ? (
        <p className="mt-2 text-xs text-[var(--viz-muted)]">
          Dashed sections are estimated, not tracked prices.
        </p>
      ) : null}

      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-[var(--viz-muted)] hover:text-[var(--viz-text)]">
          View as table
        </summary>
        <div className="mt-2 max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <caption className="sr-only">Price on each recorded date</caption>
            <thead className="sticky top-0 bg-[var(--viz-surface)]">
              <tr className="text-left text-[var(--viz-muted)]">
                <th scope="col" className="py-1 pr-4 font-medium">
                  Date
                </th>
                {/* Named as the chart names them: the table is the same data
                    read a different way, not a second vocabulary. */}
                <th scope="col" className="py-1 pr-4 text-right font-medium">
                  Retail
                </th>
                {/* The table carries every series the chart draws, or it is
                    not an alternative to it. */}
                {buylistSelected ? (
                  <th scope="col" className="py-1 text-right font-medium">
                    Card Kingdom buylist
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((row) => (
                <tr key={row.date}>
                  <td className="py-0.5 pr-4 tabular-nums">{row.date}</td>
                  <td className="py-0.5 pr-4 text-right tabular-nums">
                    {formatUsd(row.priceCents)}
                    {/* The source column said "mtgjson" on every tracked row
                        and carried one bit of real information, which moves
                        here: an estimated price is not a quoted one. */}
                    {row.estimated ? (
                      <span
                        className="ml-1.5 text-[var(--viz-muted)]"
                        title="Estimated, not a tracked price"
                      >
                        est.
                      </span>
                    ) : null}
                  </td>
                  {/* A day Card Kingdom did not publish is blank, not zero. */}
                  {buylistSelected ? (
                    <td className="py-0.5 text-right tabular-nums">
                      {row.buylistCents == null
                        ? "—"
                        : formatUsd(row.buylistCents)}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/** One printing's price history, expandable to full screen. */
export function CardPriceChart({
  points,
  buylist,
}: {
  points: PricePoint[];
  buylist?: { date: string; priceCents: number }[];
}) {
  return (
    <ChartFrame label="of this card's price history" height="h-56 sm:h-64">
      {({ width, plotClass }) => (
        <CardPriceChartBody
          points={points}
          buylist={buylist}
          width={width}
          plotClass={plotClass}
        />
      )}
    </ChartFrame>
  );
}
