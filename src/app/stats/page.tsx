import Link from "next/link";

import { db } from "@/db";
import {
  type CardRef,
  type Mover,
  SPREAD_FLOOR_CENTS,
  type Spread,
  collectionStats,
} from "@/db/queries/stats";
import { PrivacyToggle } from "@/components/privacy-toggle";
import { InfoTip } from "@/components/info-tip";
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
  hide,
}: {
  label: string;
  value: string;
  detail?: React.ReactNode;
  /** A figure that reveals what the collection is worth. */
  hide?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-neutral-600 dark:text-neutral-400">{label}</dt>
      <dd className="mt-0.5 text-2xl font-semibold tabular-nums">
        {hide ? <span className="money money-lg">{value}</span> : value}
      </dd>
      {detail ? (
        <div className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">
          {hide ? <span className="money">{detail}</span> : detail}
        </div>
      ) : null}
    </div>
  );
}

function Panel({
  title,
  note,
  tip,
  children,
}: {
  title: string;
  /** One short line. Anything needing a second sentence belongs in `tip`. */
  note?: string;
  tip?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      {/* The tip is a sibling of the heading, not a child: `details` is flow
          content and an `h2` takes phrasing content only. */}
      <div className="text-sm font-medium">
        <h2 className="inline">{title}</h2>
        {tip}
      </div>
      {note ? <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">{note}</p> : null}
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
        <span className="font-mono text-xs text-neutral-600 dark:text-neutral-400">
          {printingCode(card.setCode, card.collectorNumber)}
        </span>
        {card.finish !== "nonfoil" ? (
          <span className="ml-1 text-xs text-neutral-600 dark:text-neutral-400">
            {FINISH_LABEL[card.finish as Finish]}
          </span>
        ) : null}
        {sub ? (
          <span className="block text-xs text-neutral-600 dark:text-neutral-400">{sub}</span>
        ) : null}
      </span>
      <span className="shrink-0 tabular-nums">{right}</span>
    </li>
  );
}

function MoverList({ movers, tone }: { movers: Mover[]; tone: "up" | "down" }) {
  if (movers.length === 0) {
    return <p className="text-sm text-neutral-600 dark:text-neutral-400">Nothing to report yet.</p>;
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
          sub={`${formatUsd(mover.fromCents)} on ${mover.fromDate}${mover.fromDateApprox ? "*" : ""} → ${formatUsd(mover.toCents)}`}
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

export default async function StatsPage() {
  const stats = collectionStats(db);

  const sellRatio =
    stats.buylistRetailCents > 0
      ? stats.buylistTotalCents / stats.buylistRetailCents
      : 0;
  const widestSet = stats.topSets[0]?.valueCents ?? 1;
  const busiestMonth = Math.max(
    1,
    ...stats.acquisitions.map((month) => month.holdings),
  );
  return (
    <main className="page-shell py-10">
      <header className="mb-8 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Statistics</h1>
        <div className="flex flex-wrap items-center gap-4">
          {/* The preference is global, so it has to be reachable from the page
              it is hiding things on — not only from the dashboard. */}
          <PrivacyToggle />
          <Link
            href="/faq"
            className="text-sm text-neutral-600 dark:text-neutral-400 underline-offset-4 hover:underline"
          >
            How it works
          </Link>
          <Link
            href="/"
            className="text-sm text-neutral-600 dark:text-neutral-400 underline-offset-4 hover:underline"
          >
            Back to collection
          </Link>
        </div>
      </header>

      <dl className="mb-8 grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-7">
        <Stat label="Value" value={formatUsd(stats.totalValueCents)} hide />
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
          label="Average card"
          value={formatUsd(stats.meanCardCents)}
          detail="every priced card, averaged"
        />
        <Stat
          label="Median card"
          value={formatUsd(stats.medianCardCents)}
          detail="half are worth less"
        />
        <Stat
          label="If you sold it all"
          value={formatUsd(stats.buylistTotalCents)}
          hide
          detail={`${Math.round(sellRatio * 100)}% of Card Kingdom's ask`}
        />
      </dl>


      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 3xl:grid-cols-3">
        <Panel
          title="The long tail"
        >
          <ul className="flex flex-col gap-3 text-sm">
            <li>
              <strong className="tabular-nums">
                {stats.holdingsForHalfValue.toLocaleString()}
              </strong>{" "}
              holdings carry half the value — {" "}
              <span className="text-neutral-600 dark:text-neutral-400">
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
              <li className="text-neutral-600 dark:text-neutral-400">
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

        <Panel title="Most valuable" note="By unit price.">
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
          note="Since you acquired each card. Under $1 excluded."
          tip={
            <InfoTip label="What these are measured from">
              Each card is measured from its first price on or after the day you
              acquired it, not from the start of the price history. A card
              bought in 2023 measured from its 2020 price would rank by what the
              market did before you owned it. Dates marked * come from
              Moxfield&rsquo;s last-modified column and are a floor, so the
              window is if anything too short.{" "}
              <Link href="/faq#acquisition-dates" className="underline underline-offset-2">
                More
              </Link>
            </InfoTip>
          }
        >
          <MoverList movers={stats.gainers} tone="up" />
        </Panel>

        <Panel
          title="Biggest fallers"
          note="Same window."
          tip={
            <InfoTip label="Why new sets dominate the fallers">
              New sets often list at preorder prices and slide once supply
              arrives.
            </InfoTip>
          }
        >
          <MoverList movers={stats.losers} tone="down" />
        </Panel>

        <Panel
          title="Made you the most"
          note="Change × quantity, since you acquired each card."
        >
          {stats.biggestGains.length === 0 ? (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">Nothing up yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
              {stats.biggestGains.map((mover) => (
                <CardLine
                  key={`${mover.scryfallId}-${mover.finish}`}
                  card={mover}
                  sub={`${mover.quantity}x · ${formatUsd(mover.fromCents)} on ${mover.fromDate}${mover.fromDateApprox ? "*" : ""} → ${formatUsd(mover.toCents)}`}
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

        <Panel title="Cost you the most" note="The same, downward.">
          {stats.biggestLosses.length === 0 ? (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">Nothing down yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
              {stats.biggestLosses.map((mover) => (
                <CardLine
                  key={`${mover.scryfallId}-${mover.finish}`}
                  card={mover}
                  sub={`${mover.quantity}x · ${formatUsd(mover.fromCents)} on ${mover.fromDate}${mover.fromDateApprox ? "*" : ""} → ${formatUsd(mover.toCents)}`}
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
          note="By total value."
        >
          <ul className="flex flex-col gap-2">
            {stats.topSets.map((set) => (
              <li key={set.setCode} className="text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">
                    {set.setName}{" "}
                    <span className="font-mono text-xs text-neutral-600 dark:text-neutral-400">
                      {set.setCode.toUpperCase()}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">
                    <span className="money">{formatUsd(set.valueCents)}</span>
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
                <div className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">
                  {set.holdings.toLocaleString()} holdings
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          title="Most copies"
          note="Across every printing."
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
          title="Narrowest spread"
          note={`Card Kingdom pays the most of what it asks. Cards above ${formatUsd(SPREAD_FLOOR_CENTS)}.`}
          tip={
            <InfoTip label="Why cheap cards are excluded">
              Below {formatUsd(SPREAD_FLOOR_CENTS)} Card Kingdom&rsquo;s flat
              floor price swamps the ratio and every cheap card shows the same
              number.
            </InfoTip>
          }
        >
          <SpreadList spreads={stats.bestSpreads} />
        </Panel>

        <Panel
          title="Widest spread"
          note="Where the gap between ask and buy price is largest."
        >
          <SpreadList spreads={stats.worstSpreads} />
        </Panel>

        <Panel
          title="When you bought"
          note={`${stats.firstAcquired ?? ""} to ${stats.lastAcquired ?? ""}.`}
          tip={
            <InfoTip label="Why acquisition dates are approximate">
              Moxfield exports a last-modified date, not a purchase date, so
              these are a lower bound.{" "}
              <Link href="/faq#acquisition-dates" className="underline underline-offset-2">
                More
              </Link>
            </InfoTip>
          }
        >
          <ul className="flex flex-col gap-1">
            {stats.acquisitions.map((month) => (
              <li key={month.month} className="flex items-center gap-3 text-xs">
                <span className="w-16 shrink-0 tabular-nums text-neutral-600 dark:text-neutral-400">
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
                <span className="w-12 shrink-0 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                  {month.holdings.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Finishes" note="By finish.">
          <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
            {stats.finishSplit.map((row) => (
              <li
                key={row.finish}
                className="flex items-baseline justify-between gap-3 py-1.5 text-sm"
              >
                <span>{FINISH_LABEL[row.finish as Finish]}</span>
                <span className="shrink-0 tabular-nums">
                  <span className="money">{formatUsd(row.valueCents)}</span>{" "}
                  <span className="text-xs text-neutral-600 dark:text-neutral-400">
                    · {row.holdings.toLocaleString()} holdings
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <p className="mt-8 text-xs text-neutral-600 dark:text-neutral-400">
        Movement is measured from the first day each card was tracked, which is
        not the same date for every card — a set released last month has a
        shorter history than the rest, and its first price is a preorder price.
        Buylist figures are Card Kingdom&apos;s, the only vendor here publishing
        one, and cover {Math.round(stats.buylistCoverage * 100)}% of holdings.
      </p>
    </main>
  );
}
