import Link from "next/link";
import { notFound } from "next/navigation";

import { CardPriceChart } from "@/components/card-price-chart";
import { VendorQuotes } from "@/components/vendor-quotes";
import { db } from "@/db";
import { holdingsForPrinting } from "@/db/queries/holdings";
import {
  getPrintingByScryfallId,
  otherPrintings,
  priceHistory,
  priceStats,
} from "@/db/queries/printings";
import { vendorQuotes } from "@/db/queries/vendors";
import { FINISHES, type Finish } from "@/db/schema";
import { FINISH_LABEL, formatUsd, printingCode } from "@/lib/format";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/cards/[scryfallId]">) {
  const { scryfallId } = await props.params;
  const printing = getPrintingByScryfallId(db, scryfallId);
  if (!printing) return { title: "Card not found" };
  return {
    title: `${printing.name} · ${printingCode(printing.setCode, printing.collectorNumber)}`,
  };
}

export default async function CardPage(props: PageProps<"/cards/[scryfallId]">) {
  // params and searchParams are both Promises in Next 16.
  const [{ scryfallId }, search] = await Promise.all([
    props.params,
    props.searchParams,
  ]);

  const printing = getPrintingByScryfallId(db, scryfallId);
  if (!printing) notFound();

  // Default to the first finish this printing exists in, not a hardcoded one:
  // plenty of printings are foil-only.
  const requested = typeof search.finish === "string" ? search.finish : "";
  const finish: Finish =
    FINISHES.includes(requested as Finish) &&
    printing.finishes.includes(requested as Finish)
      ? (requested as Finish)
      : (printing.finishes[0] ?? "nonfoil");

  const points = priceHistory(db, printing.id, finish);
  const stats = priceStats(points);
  const owned = holdingsForPrinting(db, printing.id);
  const quotes = vendorQuotes(db, printing.id, finish);
  const others = otherPrintings(db, printing.oracleId, printing.scryfallId);

  const ownedForFinish = owned.filter((holding) => holding.finish === finish);
  const ownedQuantity = ownedForFinish.reduce(
    (sum, holding) => sum + holding.quantity,
    0,
  );

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <nav className="mb-6 text-sm text-neutral-500">
        <Link href="/" className="underline-offset-4 hover:underline">
          Collection
        </Link>
        <span className="mx-2">/</span>
        <Link href="/search" className="underline-offset-4 hover:underline">
          Search
        </Link>
      </nav>

      <header className="mb-6 flex flex-col gap-5 sm:flex-row">
        {printing.imageUri ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={printing.imageUri}
            alt={printing.name}
            className="h-56 w-40 shrink-0 self-start rounded-lg object-cover"
          />
        ) : null}

        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {printing.name}
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            {printing.setName} ·{" "}
            <span className="font-mono text-xs">
              {printingCode(printing.setCode, printing.collectorNumber)}
            </span>
          </p>

          {/* Finish is a link, not a control: it belongs in the URL so a
              particular series is shareable and reloadable. */}
          {printing.finishes.length > 1 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {printing.finishes.map((option) => {
                const active = option === finish;
                return (
                  <Link
                    key={option}
                    href={`/cards/${printing.scryfallId}?finish=${option}`}
                    aria-current={active ? "page" : undefined}
                    className={`rounded-md border px-3 py-1 text-sm transition-colors ${
                      active
                        ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                        : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                    }`}
                  >
                    {FINISH_LABEL[option]}
                  </Link>
                );
              })}
            </div>
          ) : (
            <p className="mt-4 text-sm text-neutral-500">
              {FINISH_LABEL[finish]} only
            </p>
          )}

          {ownedQuantity > 0 ? (
            <p className="mt-4 text-sm">
              You hold{" "}
              <strong className="tabular-nums">{ownedQuantity}</strong>{" "}
              {FINISH_LABEL[finish].toLowerCase()}
              {ownedForFinish.length > 1
                ? ` across ${ownedForFinish.length} holdings`
                : ""}
              {stats.currentCents != null
                ? ` · ${formatUsd(stats.currentCents * ownedQuantity)}`
                : ""}
            </p>
          ) : (
            <p className="mt-4 text-sm text-neutral-500">
              Not in your collection.
            </p>
          )}
        </div>
      </header>

      <section className="mb-8 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-xs text-neutral-500">
              {FINISH_LABEL[finish]} price
              {stats.currentDate ? ` · ${stats.currentDate}` : ""}
            </h2>
            <div className="mt-1 text-3xl font-semibold tabular-nums">
              {stats.currentCents == null
                ? "No price"
                : formatUsd(stats.currentCents)}
            </div>
          </div>

          <dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-neutral-500">30 days</dt>
              <dd
                className={`font-medium tabular-nums ${
                  stats.changeCents == null || stats.changeCents === 0
                    ? "text-neutral-500"
                    : stats.changeCents > 0
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-red-700 dark:text-red-400"
                }`}
              >
                {stats.changeCents == null ? (
                  <span className="text-neutral-400">not enough history</span>
                ) : (
                  <>
                    {stats.changeCents > 0 ? "+" : ""}
                    {formatUsd(stats.changeCents)}
                    {stats.changeRatio != null
                      ? ` (${stats.changeCents > 0 ? "+" : ""}${(stats.changeRatio * 100).toFixed(1)}%)`
                      : ""}
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Low</dt>
              <dd className="font-medium tabular-nums">
                {stats.lowCents == null ? "—" : formatUsd(stats.lowCents)}
                {stats.lowDate ? (
                  <span className="ml-1 text-xs font-normal text-neutral-400">
                    {stats.lowDate}
                  </span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">High</dt>
              <dd className="font-medium tabular-nums">
                {stats.highCents == null ? "—" : formatUsd(stats.highCents)}
                {stats.highDate ? (
                  <span className="ml-1 text-xs font-normal text-neutral-400">
                    {stats.highDate}
                  </span>
                ) : null}
              </dd>
            </div>
          </dl>
        </div>

        <CardPriceChart points={points} />
      </section>

      <section className="mb-8 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="text-xs text-neutral-500">
          Vendors · {FINISH_LABEL[finish].toLowerCase()}
        </h2>
        <p className="mt-1 mb-4 text-sm text-neutral-500">
          What each shop asks, and what it would pay.
        </p>
        <VendorQuotes quotes={quotes} />
      </section>

      {others.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-medium">
            Other printings of {printing.name}
          </h2>
          <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
            {others.map((other) => {
              const price = other.prices.find(
                (candidate) => candidate.finish === other.finishes[0],
              );
              return (
                <li key={other.scryfallId}>
                  <Link
                    href={`/cards/${other.scryfallId}`}
                    className="flex items-baseline justify-between gap-4 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900"
                  >
                    <span className="min-w-0 truncate">
                      {other.setName}{" "}
                      <span className="font-mono text-xs text-neutral-500">
                        {printingCode(other.setCode, other.collectorNumber)}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums text-neutral-500">
                      {price ? formatUsd(price.priceCents) : "no price"}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
