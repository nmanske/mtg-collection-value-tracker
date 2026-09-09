"use client";

import { useId } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { ValuePoint } from "@/db/queries/valuation";
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

/**
 * Margins and axis width are shared by both panes.
 *
 * The acquisition pane is a separate chart stacked underneath, so its plot area
 * only lines up with the value chart's if the reserved space either side
 * matches exactly.
 */
const CHART_MARGIN = { top: 8, right: 16, bottom: 0, left: 4 };
const Y_AXIS_WIDTH = 64;

/** Links the two panes' hover, so one crosshair drives both. */
const SYNC_ID = "portfolio";

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

function AcquisitionTooltip({ active, payload }: TooltipPayload) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  if (point.acquiredHoldings === 0) return null;

  return (
    <div className="rounded-md border border-[var(--viz-grid)] bg-[var(--viz-surface)] px-3 py-2 text-xs shadow-sm">
      <div className="font-medium text-[var(--viz-text)]">{point.date}</div>
      <div className="mt-0.5 text-[var(--viz-text)]">
        +{point.acquiredCards.toLocaleString()} card
        {point.acquiredCards === 1 ? "" : "s"}
        <span className="text-[var(--viz-muted)]">
          {" "}
          ({point.acquiredHoldings.toLocaleString()} holding
          {point.acquiredHoldings === 1 ? "" : "s"})
        </span>
      </div>
    </div>
  );
}

export function PortfolioChart({
  points,
  basketPoints,
}: {
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

  const data: ChartPoint[] = points.map((point) => ({
    date: point.date,
    valueCents: point.valueCents,
    holdingsHeld: point.holdingsHeld,
    unpricedHoldings: point.unpricedHoldings,
    basketCents: basketByDate.get(point.date) ?? null,
    acquiredHoldings: point.acquiredHoldings,
    acquiredCards: point.acquiredCards,
  }));

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
      {showBasket ? (
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
        </figcaption>
      ) : null}

      <div className="h-64 w-full sm:h-72">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={CHART_MARGIN}
            syncId={SYNC_ID}
          >
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

            {/* Hidden when the acquisition pane is shown: the two panes share
                one timeline, so the labels belong under the lower of them. The
                scale is still needed, so the axis stays and only its rendering
                goes. */}
            <XAxis
              dataKey="date"
              tickFormatter={shortDate}
              tickLine={false}
              axisLine={{ stroke: "var(--viz-grid)" }}
              tick={{ fill: "var(--viz-muted)", fontSize: 11 }}
              minTickGap={28}
              hide={showAcquisitions}
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
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {showAcquisitions ? (
        <div className="mt-1">
          {/* A separate pane rather than marks inside the value plot: the bars
              count holdings, not money, and overlaying them would put a second
              scale in the same box. Stacked and hover-linked, they read as
              annotation on the same timeline — the convention a price chart
              uses for volume. */}
          <div className="h-16 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={CHART_MARGIN} syncId={SYNC_ID}>
                <XAxis
                  dataKey="date"
                  tickFormatter={shortDate}
                  tickLine={false}
                  axisLine={{ stroke: "var(--viz-grid)" }}
                  tick={{ fill: "var(--viz-muted)", fontSize: 11 }}
                  minTickGap={28}
                />
                {/* Hidden, but the same reserved width, so the two plot areas
                    line up to the pixel. */}
                <YAxis
                  width={Y_AXIS_WIDTH}
                  domain={[0, busiestDay]}
                  hide
                />
                <Tooltip
                  content={<AcquisitionTooltip />}
                  cursor={{ fill: "var(--viz-grid)", fillOpacity: 0.35 }}
                />
                <Bar
                  dataKey="acquiredHoldings"
                  fill="var(--viz-mark)"
                  // Thin marks with a rounded data-end, grown from a single
                  // baseline; capped so a sparse window does not render a few
                  // enormous blocks.
                  maxBarSize={10}
                  radius={[2, 2, 0, 0]}
                  // A single-holding day is 0.6% of the busiest one and would
                  // render sub-pixel, so small events get a floor. Applied as a
                  // function because a plain number floors every bar including
                  // the zeroes, drawing a mark on all 89 dates and claiming
                  // acquisitions on days that had none.
                  minPointSize={(value: number | null | undefined) =>
                    value != null && value > 0 ? 2 : 0
                  }
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-1 text-xs text-[var(--viz-muted)]">
            Cards added, by day — taller means more. {" "}
            {acquisitions.length} day{acquisitions.length === 1 ? "" : "s"} in
            this window, the largest{" "}
            {busiestDay.toLocaleString()} holdings. These are the steps in the
            blue line.
          </p>
        </div>
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
