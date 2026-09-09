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

import type { ValuePoint } from "@/db/queries/valuation";
import { formatUsd } from "@/lib/format";

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
}

function shortDate(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${Number(month)}/${Number(day)}`;
}

/**
 * Y ticks as whole dollars, thousands-comma'd.
 *
 * Not abbreviated to "$15k": a collection's value moves within a narrow band,
 * so rounding to thousands renders adjacent ticks as duplicate labels —
 * $15k, $15k, $14k, $14k — and the axis stops carrying information.
 */
function axisMoney(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/**
 * Rounds an axis range out to a "nice" step so ticks land on numbers a reader
 * recognises — 13,500 / 14,000 / 14,500 rather than 13,390 / 13,940 / 14,490.
 *
 * Steps come from the 1/2/2.5/5 x 10^n family, chosen to give roughly five
 * ticks across the range. Working in cents throughout; the step is never
 * smaller than a dollar.
 */
function niceScale(
  low: number,
  high: number,
  targetTicks = 5,
): { domain: [number, number]; ticks: number[] } {
  const span = Math.max(high - low, 1);
  const rough = span / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const factor = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10;
  const step = Math.max(Math.round(factor * magnitude), 100);

  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;

  const ticks: number[] = [];
  for (let value = start; value <= end; value += step) ticks.push(value);

  return { domain: [start, end], ticks };
}

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
      <div className="mt-0.5 text-[var(--viz-muted)]">
        {point.holdingsHeld.toLocaleString()} holdings
        {point.unpricedHoldings > 0
          ? ` · ${point.unpricedHoldings.toLocaleString()} unpriced`
          : ""}
      </div>
    </div>
  );
}

export function PortfolioChart({ points }: { points: ValuePoint[] }) {
  const gradientId = useId();

  if (points.length < 2) {
    return (
      <p className="py-12 text-center text-sm text-[var(--viz-muted)]">
        Not enough price history yet to chart. Run the daily ingest for a few
        days, or backfill from MTGJSON.
      </p>
    );
  }

  const data: ChartPoint[] = points.map((point) => ({
    date: point.date,
    valueCents: point.valueCents,
    holdingsHeld: point.holdingsHeld,
    unpricedHoldings: point.unpricedHoldings,
  }));

  const last = data[data.length - 1];
  const values = data.map((point) => point.valueCents);
  // Padded so the line never sits on the frame. The axis does not start at zero
  // deliberately: this is a value series being read for movement, not
  // magnitude, and a zero baseline would flatten every change into a straight
  // line. The axis labels make the range explicit.
  const pad = Math.max((Math.max(...values) - Math.min(...values)) * 0.15, 100);
  const { domain, ticks } = niceScale(
    Math.min(...values) - pad,
    Math.max(...values) + pad,
  );

  return (
    <figure className="viz-root m-0">
      <div className="h-64 w-full sm:h-72">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={{ top: 8, right: 16, bottom: 0, left: 4 }}
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
              content={<ValueTooltip />}
              cursor={{ stroke: "var(--viz-grid)", strokeWidth: 1 }}
            />

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
                  Value
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Holdings
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
                  <td className="py-0.5 text-right tabular-nums">
                    {point.holdingsHeld.toLocaleString()}
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
