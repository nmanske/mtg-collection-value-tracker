import Link from "next/link";

import { db } from "@/db";
import {
  type CardRef,
  type Mover,
  SPREAD_FLOOR_CENTS,
  type Spread,
  collectionStats,
} from "@/db/queries/stats";
import { portfolioHistory } from "@/db/queries/history";
import type { PeriodChange } from "@/lib/portfolio-history";
import { FINISH_LABEL, formatUsd, printingCode } from "@/lib/format";
import type { Finish } from "@/db/schema";

export const metadata = { title: "Statistics" };

export const dynamic = "force-dynamic";

function cardHref(card: CardRef) {
  return `/cards/${card.scryfallId}?finish=${card.finish}`;
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</dd>
      {detail ? (
        <div className="mt-0.5 text-xs text-neutral-500">{detail}</div>
      ) : null}
    </div>
  );
}

function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-sm font-medium">{title}</h2>
      {note ? <p className="mt-1 text-xs text-neutral-500">{note}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function CardLine({
  card,
  right,
  sub,
}: {
  card: CardRef;
  right: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <li className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <span className="min-w-0">
        <Link
          href={cardHref(card)}
          className="underline-offset-4 hover:underline"
        >
          {card.name}
        </Link>{" "}
        <span className="font-mono text-xs text-neutral-500">
          {printingCode(card.setCode, card.collectorNumber)}
        </span>
        {card.finish !== "nonfoil" ? (
          <span className="ml-1 text-xs text-neutral-500">
            {FINISH_LABEL[card.finish as Finish]}
          </span>
        ) : null}
        {sub ? (
          <span className="block text-xs text-neutral-500">{sub}</span>
        ) : null}
      </span>
      <span className="shrink-0 tabular-nums">{right}</span>
    </li>
  );
}

function MoverList({ movers, tone }: { movers: Mover[]; tone: "up" | "down" }) {
  if (movers.length === 0) {
    return <p className="text-sm text-neutral-500">Nothing to report yet.</p>;
  }
  const color =
    tone === "up"
      ? "text-emerald-700 dark:text-emerald-400"
      : "text-red-700 dark:text-red-400";

  return (
    <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
      {movers.map((mover) => (
        <CardLine
          key={`${mover.scryfallId}-${mover.finish}`}
          card={mover}
          sub={`${formatUsd(mover.fromCents)} on ${mover.fromDate} → ${formatUsd(mover.toCents)}`}
          right={
            <span className={`font-medium ${color}`}>
              {mover.changeRatio > 0 ? "+" : ""}
              {Math.round(mover.changeRatio * 100)}%
            </span>
          }
        />
      ))}
    </ul>
  );
}

function SpreadList({ spreads }: { spreads: Spread[] }) {
  return (
    <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
      {spreads.map((spread) => (
        <CardLine
          key={`${spread.scryfallId}-${spread.finish}`}
          card={spread}
          sub={`pays ${formatUsd(spread.buylistCents)} of ${formatUsd(spread.retailCents)}`}
          right={
            <span className="font-medium">{Math.round(spread.ratio * 100)}%</span>
          }
        />
      ))}
    </ul>
  );
}

/** A signed percentage, coloured by direction. */
function Pct({ ratio }: { ratio: number | null }) {
  if (ratio === null) {
    return <span className="text-neutral-500">n/a</span>;
  }
  const color =
    ratio > 0
      ? "text-emerald-700 dark:text-emerald-400"
      : ratio < 0
        ? "text-red-700 dark:text-red-400"
        : "text-neutral-500";
  return (
    <span className={`font-medium tabular-nums ${color}`}>
      {ratio > 0 ? "+" : ""}
      {(ratio * 100).toFixed(1)}%
    </span>
  );
}

function YearRow({ year, widest }: { year: PeriodChange; widest: number }) {
  const ratio = year.changeRatio ?? 0;
  const share = widest > 0 ? Math.min(1, Math.abs(ratio) / widest) : 0;
  return (
    <li className="py-1.5 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="tabular-nums">
          {year.label}
          {year.partial ? (
            <span className="ml-1.5 text-xs text-neutral-500">so far</span>
          ) : null}
        </span>
        <span className="shrink-0 tabular-nums">
          <span className="mr-3 text-xs text-neutral-500">
            {formatUsd(year.fromCents)} → {formatUsd(year.toCents)}
          </span>
          <Pct ratio={year.changeRatio} />
        </span>
      </div>
      {/* A bar per year, signed from the centre, so five years of direction
          read at a glance rather than as a column of numbers. */}
      <div className="mt-1 flex h-1 items-stretch" aria-hidden="true">
        <div className="flex w-1/2 justify-end">
          {ratio < 0 ? (
            <div
              className="rounded-l-sm bg-red-500/60"
              style={{ width: `${share * 100}%` }}
            />
          ) : null}
        </div>
        <div className="flex w-1/2 justify-start">
          {ratio > 0 ? (
            <div
              className="rounded-r-sm bg-emerald-500/60"
              style={{ width: `${share * 100}%` }}
            />
          ) : null}
        </div>
      </div>
    </li>
  );
}

export default async function StatsPage() {
  const stats = collectionStats(db);
  const history = portfolioHistory(db);

  const sellRatio =
    stats.buylistRetailCents > 0
      ? stats.buylistTotalCents / stats.buylistRetailCents
      : 0;
  const widestSet = stats.topSets[0]?.valueCents ?? 1;
  const busiestMonth = Math.max(
    1,
    ...stats.acquisitions.map((month) => month.holdings),
  );
  // The whole tracked span, like-for-like: what today's cards were worth at the
  // start of the index against what they are worth now. This is the headline
  // number the raw basket line gets most wrong — it reads +58% where the
  // like-for-like answer is -13%, because two thirds of the drift is cards
  // that had not been printed in 2020.
  const allTime =
    history && history.points.length > 1 && history.points[0].valueCents > 0
      ? {
          ratio:
            history.points[history.points.length - 1].valueCents /
              history.points[0].valueCents -
            1,
          from: history.points[0].date,
        }
      : null;

  // The widest year, so the bars are scaled against the biggest move rather
  // than against 100% — which would leave every bar a sliver.
  const widestYear = Math.max(
    0.01,
    ...(history?.years ?? []).map((year) => Math.abs(year.changeRatio ?? 0)),
  );

  return (
    <main className="page-shell py-10">
      <header className="mb-8 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Statistics</h1>
        <Link
          href="/"
          className="text-sm text-neutral-500 underline-offset-4 hover:underline"
        >
          Back to collection
        </Link>
      </header>

      <dl className="mb-8 grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-7">
        <Stat label="Value" value={formatUsd(stats.totalValueCents)} />
        <Stat
          label="Cards"
          value={stats.totalCards.toLocaleString()}
          detail={`${stats.totalHoldings.toLocaleString()} holdings`}
        />
        <Stat
          label="Distinct printings"
          value={stats.distinctPrintings.toLocaleString()}
        />
        <Stat label="Sets" value={stats.distinctSets.toLocaleString()} />
        <Stat
          label="Median card"
          value={formatUsd(stats.medianCardCents)}
          detail="half are worth less"
        />
        <Stat
          label="If you sold it all"
          value={formatUsd(stats.buylistTotalCents)}
          detail={`${Math.round(sellRatio * 100)}% of Card Kingdom's ask`}
        />
        {allTime ? (
          <Stat
            label="Since tracking began"
            value={`${allTime.ratio > 0 ? "+" : ""}${(allTime.ratio * 100).toFixed(1)}%`}
            detail={`these cards, from ${allTime.from}`}
          />
        ) : null}
      </dl>

      {history ? (
        <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-2 3xl:grid-cols-3">
          <Panel
            title="Year by year"
            note={`What today's cards were worth at each year end, comparing only the cards priced at both ends of each step. Measured from ${history.points[0].date}.`}
          >
            <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
              {[...history.years].reverse().map((year) => (
                <YearRow key={year.label} year={year} widest={widestYear} />
              ))}
            </ul>
            <p className="mt-4 text-xs text-neutral-500">
              The oldest step covers{" "}
              {history.earliestCompared.toLocaleString()} of{" "}
              {history.totalHoldings.toLocaleString()} holdings — the rest had
              not been printed yet. Each step compares only the cards priced on
              both of its dates, so a card appearing does not read as a gain.
            </p>
          </Panel>

          <Panel
            title="Peak and trough"
            note="The deepest fall from a high, by percentage rather than by dollars, so a big decline in a small collection is not hidden by a small one in a large collection."
          >
            {history.drawdown ? (
              <dl className="grid grid-cols-2 gap-6">
                <Stat
                  label="Deepest fall"
                  value={`-${(history.drawdown.depthRatio * 100).toFixed(1)}%`}
                  detail={`${formatUsd(history.drawdown.peakCents)} → ${formatUsd(history.drawdown.troughCents)}`}
                />
                <Stat
                  label="Took"
                  value={`${history.drawdown.monthsToTrough} mo`}
                  detail={`${history.drawdown.peakDate} → ${history.drawdown.troughDate}`}
                />
                <Stat
                  label="Recovered"
                  value={
                    history.drawdown.recoveredDate
                      ? `${history.drawdown.monthsToRecover} mo`
                      : "Not yet"
                  }
                  detail={
                    history.drawdown.recoveredDate ??
                    "still below that peak"
                  }
                />
                {history.high ? (
                  <Stat
                    label="Below its high"
                    value={`${(history.high.belowRatio * 100).toFixed(1)}%`}
                    detail={`peaked ${history.high.date}, ${history.high.monthsSince} months ago`}
                  />
                ) : null}
              </dl>
            ) : (
              <p className="text-sm text-neutral-500">
                The collection has never fallen from a high.
              </p>
            )}
          </Panel>

          <Panel
            title="Best and worst"
            note="Ranked by percentage across the whole tracked history."
          >
            <dl className="grid grid-cols-2 gap-6">
              {(
                [
                  ["Best year", history.bestYear],
                  ["Worst year", history.worstYear],
                  ["Best month", history.bestMonth],
                  ["Worst month", history.worstMonth],
                ] as const
              ).map(([label, period]) => (
                <Stat
                  key={label}
                  label={label}
                  value={
                    period
                      ? `${period.changeRatio! > 0 ? "+" : ""}${(period.changeRatio! * 100).toFixed(1)}%`
                      : "—"
                  }
                  detail={
                    period
                      ? `${period.label}${period.partial ? " so far" : ""} · ${formatUsd(period.fromCents)} → ${formatUsd(period.toCents)}`
                      : "not enough history"
                  }
                />
              ))}
            </dl>
          </Panel>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 3xl:grid-cols-3">
        <Panel
          title="The long tail"
          note="Most collections are a few good cards and a mountain of commons. Here is the shape of yours."
        >
          <ul className="flex flex-col gap-3 text-sm">
            <li>
              <strong className="tabular-nums">
                {stats.holdingsForHalfValue.toLocaleString()}
              </strong>{" "}
              holdings carry half the value — {" "}
              <span className="text-neutral-500">
                {(
                  (stats.holdingsForHalfValue / stats.totalHoldings) *
                  100
                ).toFixed(1)}
                % of the collection.
              </span>
            </li>
            <li>
              <strong className="tabular-nums">
                {stats.underOneDollar.toLocaleString()}
              </strong>{" "}
              holdings are worth under a dollar, and together they are{" "}
              <strong className="tabular-nums">
                {(stats.underOneDollarShare * 100).toFixed(1)}%
              </strong>{" "}
              of the total.
            </li>
            <li>
              The ten most valuable are{" "}
              <strong className="tabular-nums">
                {(stats.topTenShare * 100).toFixed(1)}%
              </strong>{" "}
              of everything.
            </li>
            {stats.cheapest ? (
              <li className="text-neutral-500">
                Cheapest card:{" "}
                <Link
                  href={cardHref(stats.cheapest)}
                  className="underline-offset-4 hover:underline"
                >
                  {stats.cheapest.name}
                </Link>{" "}
                at {formatUsd(stats.cheapest.priceCents)}.
              </li>
            ) : null}
          </ul>
        </Panel>

        <Panel title="Most valuable" note="Single cards, by unit price.">
          <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
            {stats.mostValuable.map((card) => (
              <CardLine
                key={`${card.scryfallId}-${card.finish}`}
                card={card}
                right={
                  <span className="font-medium">
                    {formatUsd(card.priceCents)}
                  </span>
                }
              />
            ))}
          </ul>
        </Panel>

        <Panel
          title="Biggest risers"
          note="Since each card was first tracked. Cards under a dollar are excluded — a two-cent move is not news."
        >
          <MoverList movers={stats.gainers} tone="up" />
        </Panel>

        <Panel
          title="Biggest fallers"
          note="Same window. New sets often appear at preorder prices and slide once supply arrives."
        >
          <MoverList movers={stats.losers} tone="down" />
        </Panel>

        <Panel
          title="Made you the most"
          note="Ranked by effect on the collection — change times how many you own — rather than by percentage."
        >
          {stats.biggestGains.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing up yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
              {stats.biggestGains.map((mover) => (
                <CardLine
                  key={`${mover.scryfallId}-${mover.finish}`}
                  card={mover}
                  sub={`${mover.quantity}x · ${formatUsd(mover.fromCents)} → ${formatUsd(mover.toCents)}`}
                  right={
                    <span className="font-medium text-emerald-700 dark:text-emerald-400">
                      +{formatUsd(mover.impactCents)}
                    </span>
                  }
                />
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Cost you the most" note="The same, in the other direction.">
          {stats.biggestLosses.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing down yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
              {stats.biggestLosses.map((mover) => (
                <CardLine
                  key={`${mover.scryfallId}-${mover.finish}`}
                  card={mover}
                  sub={`${mover.quantity}x · ${formatUsd(mover.fromCents)} → ${formatUsd(mover.toCents)}`}
                  right={
                    <span className="font-medium text-red-700 dark:text-red-400">
                      {formatUsd(mover.impactCents)}
                    </span>
                  }
                />
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Where the value sits"
          note="Top sets by total value. Bars are relative to the largest."
        >
          <ul className="flex flex-col gap-2">
            {stats.topSets.map((set) => (
              <li key={set.setCode} className="text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">
                    {set.setName}{" "}
                    <span className="font-mono text-xs text-neutral-500">
                      {set.setCode.toUpperCase()}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatUsd(set.valueCents)}
                  </span>
                </div>
                {/* A thin bar with a rounded data-end, one hue, grown from a
                    single baseline — magnitude only, no second encoding. */}
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                  <div
                    className="h-full rounded-full bg-[var(--viz-series)]"
                    style={{
                      width: `${Math.max(2, (set.valueCents / widestSet) * 100)}%`,
                    }}
                  />
                </div>
                <div className="mt-0.5 text-xs text-neutral-500">
                  {set.holdings.toLocaleString()} holdings
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          title="Most copies"
          note="Counted across every printing of the same card."
        >
          <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
            {stats.mostCopies.map((card) => (
              <li
                key={card.scryfallId}
                className="flex items-baseline justify-between gap-3 py-1.5 text-sm"
              >
                <Link
                  href={`/cards/${card.scryfallId}`}
                  className="min-w-0 truncate underline-offset-4 hover:underline"
                >
                  {card.name}
                </Link>
                <span className="shrink-0 font-medium tabular-nums">
                  {card.quantity}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          title="Easiest to sell"
          note={`Card Kingdom's buy price as a share of its own ask, for cards it lists above ${formatUsd(SPREAD_FLOOR_CENTS)}. Below that its flat floor price swamps the ratio.`}
        >
          <SpreadList spreads={stats.bestSpreads} />
        </Panel>

        <Panel title="Hardest to sell" note="The same, at the other end.">
          <SpreadList spreads={stats.worstSpreads} />
        </Panel>

        <Panel
          title="When you bought"
          note={`Holdings by acquisition month, ${stats.firstAcquired ?? ""} to ${stats.lastAcquired ?? ""}. Dates come from Moxfield's Last Modified column, so they are a lower bound.`}
        >
          <ul className="flex flex-col gap-1">
            {stats.acquisitions.map((month) => (
              <li key={month.month} className="flex items-center gap-3 text-xs">
                <span className="w-16 shrink-0 tabular-nums text-neutral-500">
                  {month.month}
                </span>
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                  <span
                    className="block h-full rounded-full bg-[var(--viz-series)]"
                    style={{
                      width: `${Math.max(1, (month.holdings / busiestMonth) * 100)}%`,
                    }}
                  />
                </span>
                <span className="w-12 shrink-0 text-right tabular-nums text-neutral-500">
                  {month.holdings.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Finishes" note="Holdings and value by finish.">
          <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
            {stats.finishSplit.map((row) => (
              <li
                key={row.finish}
                className="flex items-baseline justify-between gap-3 py-1.5 text-sm"
              >
                <span>{FINISH_LABEL[row.finish as Finish]}</span>
                <span className="shrink-0 tabular-nums">
                  {formatUsd(row.valueCents)}{" "}
                  <span className="text-xs text-neutral-500">
                    · {row.holdings.toLocaleString()} holdings
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <p className="mt-8 text-xs text-neutral-500">
        Movement is measured from the first day each card was tracked, which is
        not the same date for every card — a set released last month has a
        shorter history than the rest, and its first price is a preorder price.
        Buylist figures are Card Kingdom&apos;s, the only vendor here publishing
        one, and cover {Math.round(stats.buylistCoverage * 100)}% of holdings.
      </p>
    </main>
  );
}
