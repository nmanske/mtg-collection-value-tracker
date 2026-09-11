"use client";

import { useId } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { ValuePoint } from "@/db/queries/valuation";
import { downsample, pointBudget } from "@/lib/downsample";

import { ChartFrame } from "./chart-frame";
import { formatUsd } from "@/lib/format";

import { axisMoney, paddedScale, shortDate } from "./chart-utils";

/**
 * Portfolio value over time.
 *
 * One series, so there is no legend — the heading names what is plotted, and a
 * one-swatch legend box would only restate it. An area chart rather than a bare
 * line because a single series over time reads better with the wash beneath it;
 * the wash is the series hue at 10%, not a saturated block.
 *
 * Colors come from CSS custom properties defined for both light and dark, each
 * validated against its own surface rather than flipped automatically.
 */

export interface ChartPoint {
  date: string;
  valueCents: number;
  holdingsHeld: number;
  unpricedHoldings: number;
  /** Today's holdings valued on this date, ignoring acquisition dates. */
  basketCents: number | null;
  acquiredHoldings: number;
  acquiredCards: number;
}

const CHART_MARGIN = { top: 8, right: 16, bottom: 0, left: 4 };
const Y_AXIS_WIDTH = 64;

/**
 * How much of the plot height the busiest acquisition day fills.
 *
 * The bars sit behind the value lines on their own hidden scale, so this is
 * the only thing setting their size. Tall enough that a small day is legible,
 * short enough that a big one does not read as part of the value series.
 */
const ACQUISITION_HEIGHT = 0.45;

interface TooltipPayload {
  active?: boolean;
  payload?: { payload: ChartPoint }[];
}

function ValueTooltip({ active, payload }: TooltipPayload) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;

  return (
    <div className="rounded-md border border-[var(--viz-grid)] bg-[var(--viz-surface)] px-3 py-2 text-xs shadow-sm">
      <div className="font-medium text-[var(--viz-text)]">{point.date}</div>
      <div className="mt-1 flex items-center gap-1.5">
        {/* Identity comes from the mark beside the text, never from colouring
            the text itself. */}
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full bg-[var(--viz-series)]"
        />
        <span className="tabular-nums text-[var(--viz-text)]">
          {formatUsd(point.valueCents)}
        </span>
      </div>
      {point.basketCents != null ? (
        <div className="mt-1 flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-[var(--viz-series-2)]"
          />
          <span className="tabular-nums text-[var(--viz-text)]">
            {formatUsd(point.basketCents)}
          </span>
          <span className="text-[var(--viz-muted)]">if held throughout</span>
        </div>
      ) : null}
      <div className="mt-0.5 text-[var(--viz-muted)]">
        {point.holdingsHeld.toLocaleString()} holdings
        {point.unpricedHoldings > 0
          ? ` · ${point.unpricedHoldings.toLocaleString()} unpriced`
          : ""}
      </div>
      {point.acquiredHoldings > 0 ? (
        <div className="mt-1 border-t border-[var(--viz-grid)] pt-1 text-[var(--viz-text)]">
          +{point.acquiredCards.toLocaleString()} card
          {point.acquiredCards === 1 ? "" : "s"} added
          <span className="text-[var(--viz-muted)]">
            {" "}
            ({point.acquiredHoldings.toLocaleString()} holding
            {point.acquiredHoldings === 1 ? "" : "s"})
          </span>
        </div>
      ) : null}
    </div>
  );
}

function PortfolioChartBody({
  points,
  basketPoints,
  width,
  plotClass,
}: {
  width: number;
  /** Height classes for the plot element; see ChartFrame. */
  plotClass: string;
  points: ValuePoint[];
  /**
   * The same holdings valued across the whole window regardless of when they
   * were bought. Plotted alongside so the gap between the lines is the part of
   * the change that came from acquiring cards rather than from prices.
   */
  basketPoints?: ValuePoint[];
}) {
  const gradientId = useId();

  if (points.length < 2) {
    return (
      <p className="py-12 text-center text-sm text-[var(--viz-muted)]">
        Not enough price history yet to chart. Run the daily ingest for a few
        days, or backfill from MTGJSON.
      </p>
    );
  }

  const basketByDate = new Map(
    (basketPoints ?? []).map((point) => [point.date, point.valueCents]),
  );
  const showBasket = basketByDate.size > 0;

  const full: ChartPoint[] = points.map((point) => ({
    date: point.date,
    valueCents: point.valueCents,
    holdingsHeld: point.holdingsHeld,
    unpricedHoldings: point.unpricedHoldings,
    basketCents: basketByDate.get(point.date) ?? null,
    acquiredHoldings: point.acquiredHoldings,
    acquiredCards: point.acquiredCards,
  }));

  // Thinned to what the plot can actually resolve. Acquisition counts are
  // summed into the point that survives rather than dropped with the points
  // that do not, so the bars still total the cards actually bought in the
  // window -- a chart that quietly lost a purchase would be worse than a
  // crowded one.
  const data = downsample(full, pointBudget(width), {
    value: (point) => point.valueCents,
    merge: (kept, bucket) => ({
      ...kept,
      acquiredHoldings: bucket.reduce((sum, p) => sum + p.acquiredHoldings, 0),
      acquiredCards: bucket.reduce((sum, p) => sum + p.acquiredCards, 0),
    }),
  });

  // Only worth a pane if anything was actually acquired inside the window.
  const acquisitions = data.filter((point) => point.acquiredHoldings > 0);
  const showAcquisitions = acquisitions.length > 0;
  const busiestDay = Math.max(1, ...data.map((point) => point.acquiredHoldings));

  const last = data[data.length - 1];
  const { domain, ticks } = paddedScale(
    data.flatMap((point) =>
      point.basketCents == null
        ? [point.valueCents]
        : [point.valueCents, point.basketCents],
    ),
  );

  return (
    <figure className="viz-root m-0">
      {showBasket || showAcquisitions ? (
        <figcaption className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-0.5 w-4 rounded-full bg-[var(--viz-series)]"
            />
            <span className="text-[var(--viz-text)]">As held</span>
            <span className="text-[var(--viz-muted)]">
              counts each card from the day you got it
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-0.5 w-4 rounded-full bg-[var(--viz-series-2)]"
            />
            <span className="text-[var(--viz-text)]">If held throughout</span>
            <span className="text-[var(--viz-muted)]">
              today&apos;s cards priced across the whole window
            </span>
          </span>
          {showAcquisitions ? (
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2 rounded-sm bg-[var(--viz-mark)] opacity-55"
              />
              <span className="text-[var(--viz-text)]">Cards added</span>
              <span className="text-[var(--viz-muted)]">
                taller means more that day
              </span>
            </span>
          ) : null}
        </figcaption>
      ) : null}

      <div className={`${plotClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={CHART_MARGIN}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor="var(--viz-series)"
                  stopOpacity={0.18}
                />
                <stop
                  offset="100%"
                  stopColor="var(--viz-series)"
                  stopOpacity={0.02}
                />
              </linearGradient>
            </defs>

            {/* Hairline, solid, recessive — never dashed. */}
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
              width={Y_AXIS_WIDTH}
            />
            {/* The acquisition scale: hidden, unlabelled, and never compared
                against the value axis. The bars are an annotation of when cards
                arrived, not a second measure to read off.
                Only this axis is named — the value axis stays the chart's
                default, because anything that does not name an axis (the grid,
                the tooltip cursor) binds to the default id, and naming every
                axis leaves those bound to an id that no longer exists. */}
            <YAxis
              yAxisId="acquisitions"
              domain={[0, busiestDay / ACQUISITION_HEIGHT]}
              hide
            />

            {/* First child, so the bars paint behind both lines. */}
            {showAcquisitions ? (
              <Bar
                yAxisId="acquisitions"
                dataKey="acquiredHoldings"
                fill="var(--viz-mark)"
                fillOpacity={0.55}
                maxBarSize={14}
                radius={[2, 2, 0, 0]}
                // A function, not a number: a plain floor applies to the zeroes
                // too and would draw a mark on every date, claiming cards were
                // added on days that had none.
                minPointSize={(value: number | null | undefined) =>
                  value != null && value > 0 ? 3 : 0
                }
                isAnimationActive={false}
              />
            ) : null}

            <Tooltip
              content={<ValueTooltip />}
              cursor={{ stroke: "var(--viz-grid)", strokeWidth: 1 }}
            />

            {showBasket ? (
              <Area
                type="monotone"
                dataKey="basketCents"
                stroke="var(--viz-series-2)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                // No fill: two washes over one another muddies both, and this
                // line is context for the primary rather than a second total.
                fill="none"
                dot={false}
                activeDot={{
                  r: 4,
                  fill: "var(--viz-series-2)",
                  stroke: "var(--viz-surface)",
                  strokeWidth: 2,
                }}
                isAnimationActive={false}
                connectNulls
              />
            ) : null}

            <Area
              type="monotone"
              dataKey="valueCents"
              stroke="var(--viz-series)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill={`url(#${gradientId})`}
              // A dot per day would be 89 marks of noise; the endpoint is
              // marked instead and the tooltip carries the rest.
              dot={false}
              activeDot={{
                r: 4,
                fill: "var(--viz-series)",
                stroke: "var(--viz-surface)",
                strokeWidth: 2,
              }}
              isAnimationActive={false}
            />

            {/* The end marker: >=8px across, with a 2px surface ring so it stays
                legible where it meets the line. */}
            <ReferenceDot
              x={last.date}
              y={last.valueCents}
              r={4}
              fill="var(--viz-series)"
              stroke="var(--viz-surface)"
              strokeWidth={2}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {showAcquisitions ? (
        <p className="mt-2 text-xs text-[var(--viz-muted)]">
          Grey bars mark days cards were added — taller means more.{" "}
          {acquisitions.length} day{acquisitions.length === 1 ? "" : "s"} in this
          window, the largest {busiestDay.toLocaleString()} holdings. They are
          what the steps in the blue line are.
        </p>
      ) : null}

      {/* The table view, so nothing is gated behind hover or colour. */}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-[var(--viz-muted)] hover:text-[var(--viz-text)]">
          View as table
        </summary>
        <div className="mt-2 max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <caption className="sr-only">
              Portfolio value on each date with price data
            </caption>
            <thead className="sticky top-0 bg-[var(--viz-surface)]">
              <tr className="text-left text-[var(--viz-muted)]">
                <th scope="col" className="py-1 pr-4 font-medium">
                  Date
                </th>
                <th scope="col" className="py-1 pr-4 text-right font-medium">
                  As held
                </th>
                {showBasket ? (
                  <th scope="col" className="py-1 pr-4 text-right font-medium">
                    If held throughout
                  </th>
                ) : null}
                <th scope="col" className="py-1 pr-4 text-right font-medium">
                  Holdings
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Added
                </th>
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((point) => (
                <tr key={point.date}>
                  <td className="py-0.5 pr-4 tabular-nums">{point.date}</td>
                  <td className="py-0.5 pr-4 text-right tabular-nums">
                    {formatUsd(point.valueCents)}
                  </td>
                  {showBasket ? (
                    <td className="py-0.5 pr-4 text-right tabular-nums">
                      {point.basketCents == null
                        ? "—"
                        : formatUsd(point.basketCents)}
                    </td>
                  ) : null}
                  <td className="py-0.5 pr-4 text-right tabular-nums">
                    {point.holdingsHeld.toLocaleString()}
                  </td>
                  <td className="py-0.5 text-right tabular-nums">
                    {point.acquiredCards > 0
                      ? `+${point.acquiredCards.toLocaleString()}`
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/**
 * The value chart.
 *
 * Wrapped in a frame that can be expanded to full screen, with the measured
 * width fed back in: a wider plot resolves more points, so expanding shows more
 * of the series rather than the same thinned points stretched across more
 * pixels.
 */
export function PortfolioChart(props: {
  points: ValuePoint[];
  basketPoints?: ValuePoint[];
}) {
  return (
    <ChartFrame label="of collection value over time">
      {({ width, plotClass }) => (
        <PortfolioChartBody {...props} width={width} plotClass={plotClass} />
      )}
    </ChartFrame>
  );
}
