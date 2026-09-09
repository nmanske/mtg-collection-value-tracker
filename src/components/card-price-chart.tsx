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
      <div className="mt-0.5 text-[var(--viz-muted)]">
        {row.estimated ? "estimated — not tracked data" : `via ${row.source}`}
      </div>
    </div>
  );
}

export function CardPriceChart({ points }: { points: PricePoint[] }) {
  const gradientId = useId();

  if (points.length < 2) {
    return (
      <p className="rounded-lg border border-dashed border-neutral-300 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700">
        {points.length === 0
          ? "No price history for this printing and finish."
          : "Only one day of price data so far — not enough to chart."}
      </p>
    );
  }

  const data: Row[] = points.map((point) => ({
    date: point.date,
    priceCents: point.priceCents,
    estimatedCents: point.estimated ? point.priceCents : null,
    source: point.source,
    estimated: point.estimated,
  }));

  const last = data[data.length - 1];
  const { domain, ticks } = paddedScale(data.map((row) => row.priceCents));
  const hasEstimates = data.some((row) => row.estimated);

  return (
    <figure className="viz-root m-0">
      <div className="h-56 w-full sm:h-64">
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
                <th scope="col" className="py-1 pr-4 text-right font-medium">
                  Price
                </th>
                <th scope="col" className="py-1 font-medium">
                  Source
                </th>
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((row) => (
                <tr key={row.date}>
                  <td className="py-0.5 pr-4 tabular-nums">{row.date}</td>
                  <td className="py-0.5 pr-4 text-right tabular-nums">
                    {formatUsd(row.priceCents)}
                  </td>
                  <td className="py-0.5">
                    {row.estimated ? "estimated" : row.source}
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
