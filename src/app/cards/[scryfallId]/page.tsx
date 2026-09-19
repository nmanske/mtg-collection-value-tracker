import Link from "next/link";
import { notFound } from "next/navigation";

import { CardHoverPreview } from "@/components/card-hover-preview";
import { CardImage } from "@/components/card-image";
import { CardPriceChart } from "@/components/card-price-chart";
import { RangePicker } from "@/components/range-picker";
import { VendorQuotes } from "@/components/vendor-quotes";
import { db } from "@/db";
import { holdingsForPrinting } from "@/db/queries/holdings";
import {
  getPrintingByScryfallId,
  otherPrintings,
  type PricePoint,
  priceHistory,
  priceStats,
} from "@/db/queries/printings";
import {
  PRICE_VENDOR_LABEL,
  PRICE_VENDORS,
  type PriceVendor,
} from "@/db/queries/valuation";
import {
  latestQuotesFor,
  vendorQuotes,
  vendorSeries,
} from "@/db/queries/vendors";
import { FINISH_CODES } from "@/db/codec";
import { FINISHES, type Finish } from "@/db/schema";
import { FINISH_LABEL, formatUsd, printingCode } from "@/lib/format";
import { rangeStart, resolveRange, spanInDays } from "@/lib/ranges";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/cards/[scryfallId]">) {
  const { scryfallId } = await props.params;
  const printing = getPrintingByScryfallId(db, scryfallId);
  if (!printing) return { title: "Card not found" };
  return {
    title: `${printing.name} · ${printingCode(printing.setCode, printing.collectorNumber, printing.releasedAt)}`,
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

  // Same control, same labels and same default as the collection chart, so
  // switching vendor means the same thing wherever you do it.
  const requestedVendor =
    typeof search.prices === "string" ? search.prices : undefined;
  const priceSource: PriceVendor =
    requestedVendor && (PRICE_VENDORS as readonly string[]).includes(requestedVendor)
      ? (requestedVendor as PriceVendor)
      : "tcgplayer";

  // TCGplayer retail comes from `price_snapshots`, which carries the source and
  // the estimated flag the chart draws differently. Card Kingdom's lives in
  // `vendor_prices`, which has neither, so those are filled in: every row there
  // is a recorded MTGJSON price, never an interpolation.
  const points: PricePoint[] =
    priceSource === "tcgplayer"
      ? priceHistory(db, printing.id, finish)
      : vendorSeries(db, printing.id, finish, priceSource, "retail").map(
          (point) => ({ ...point, source: "mtgjson" as const, estimated: false }),
        );

  // Card Kingdom is the only vendor kept here that publishes a buy price, so
  // the second line exists on their view and nowhere else — exactly as on the
  // collection chart.
  // Undefined rather than empty on the other view: the chart reads the
  // difference as "not selected" against "selected, but this card is not
  // bought", and only the second should get a column of dashes.
  const buylist =
    priceSource === "cardkingdom"
      ? vendorSeries(db, printing.id, finish, "cardkingdom", "buylist")
      : undefined;

  // The range governs every figure in the price panel, not just the chart: a
  // "high" that ignored the selected window would contradict the line drawn
  // beside it. `lookback` is the whole window, so the change tile reads as the
  // change across what is shown -- which is why its label is the range too.
  const first = points[0]?.date ?? null;
  const last = points.at(-1)?.date ?? null;
  const spanDays = first && last ? spanInDays(first, last) : 0;
  const requestedRange = typeof search.range === "string" ? search.range : undefined;
  // "All" rather than the collection's "Owned": a card's price history is not
  // about ownership, and "Owned" has no date to start from here, so it would
  // silently render the whole series under a label that implies otherwise.
  const range = resolveRange(requestedRange, spanDays, last, "all");
  const from = last ? rangeStart(range, last) : null;
  const visible = from ? points.filter((point) => point.date >= from) : points;
  const stats = priceStats(visible, Math.max(visible.length - 1, 1));
  const owned = holdingsForPrinting(db, printing.id);
  const quotes = vendorQuotes(db, printing.id, finish);
  const others = otherPrintings(db, printing.oracleId, printing.scryfallId);
  // Other printings are priced from `price_snapshots`, which is TCGplayer
  // retail only. On the Card Kingdom view that left the list contradicting
  // every other figure on the page, so their quotes are read in one pass and
  // substituted -- ask and bid, as the collection table shows them.
  const otherQuotes =
    priceSource === "cardkingdom"
      ? latestQuotesFor(
          db,
          others.map((other) => ({
            printingKey: other.id,
            finish: other.finishes[0] ?? "nonfoil",
          })),
          "cardkingdom",
        )
      : null;

  const ownedForFinish = owned.filter((holding) => holding.finish === finish);
  const ownedQuantity = ownedForFinish.reduce(
    (sum, holding) => sum + holding.quantity,
    0,
  );

  return (
    <main className="page-shell py-10">
      <nav className="mb-6 text-sm text-neutral-600 dark:text-neutral-400">
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
          <CardImage
            src={printing.imageUriLarge ?? printing.imageUri}
            backSrc={printing.imageUriBack}
            alt={printing.name}
            className="w-80 self-start"
            // The selected finish, not the printing's: the page is showing one
            // series, and this is the art for that series.
            foil={finish !== "nonfoil"}
          />
        ) : null}

        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {printing.name}
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            {printing.setName} ·{" "}
            <span className="font-mono text-xs">
              {printingCode(
                printing.setCode,
                printing.collectorNumber,
                printing.releasedAt,
              )}
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
                    href={`/cards/${printing.scryfallId}?finish=${option}${
                      priceSource === "tcgplayer" ? "" : `&prices=${priceSource}`
                    }`}
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
            <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">
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
            <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">
              Not in your collection.
            </p>
          )}

          {/* The price and the controls that scope it sit beside the art:
              the column is as tall as a card image and was carrying four
              lines of text. The chart keeps the full width below, where a
              wide plot resolves more days. */}
          <div className="mt-6 border-t border-neutral-200 pt-5 dark:border-neutral-800">
            <div>
              <h2 className="text-xs text-neutral-600 dark:text-neutral-400">
                {FINISH_LABEL[finish]} price
                {stats.currentDate ? ` · ${stats.currentDate}` : ""}
              </h2>
              <div className="mt-1 text-3xl font-semibold tabular-nums">
                {stats.currentCents == null
                  ? "No price"
                  : formatUsd(stats.currentCents)}
              </div>
            </div>

            <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3 text-sm">
              <div>
                <dt className="text-xs text-neutral-600 dark:text-neutral-400">
                  {range.window === null ? "All time" : range.description}
                </dt>
                <dd
                  className={`font-medium tabular-nums ${
                    stats.changeCents == null || stats.changeCents === 0
                      ? "text-neutral-600 dark:text-neutral-400"
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
                <dt className="text-xs text-neutral-600 dark:text-neutral-400">Low</dt>
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
                <dt className="text-xs text-neutral-600 dark:text-neutral-400">High</dt>
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
        </div>
      </header>

      {/* The controls sit with the chart they scope, left-aligned above it
          and clear of the card's own details. */}
      <section className="mt-8 mb-8 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* Same control, markup and labels as the collection chart. Beside
              the range because it changes the same thing the range does: what
              the chart is showing, not what the card is. */}
          <nav aria-label="Price source" className="flex flex-wrap gap-1">
            {PRICE_VENDORS.map((vendor) => {
              const current = vendor === priceSource;
              return (
                <Link
                  key={vendor}
                  href={`/cards/${printing.scryfallId}?finish=${finish}&prices=${vendor}${
                    requestedRange ? `&range=${requestedRange}` : ""
                  }`}
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
            lastDate={last}
            exclude={["held"]}
            hrefFor={(id) =>
              `/cards/${printing.scryfallId}?finish=${finish}&range=${id}${
                priceSource === "tcgplayer" ? "" : `&prices=${priceSource}`
              }`
            }
          />
        </div>
        <CardPriceChart
          points={visible}
          buylist={
            buylist && from
              ? buylist.filter((point) => point.date >= from)
              : buylist
          }
        />

        {points.length > 0 ? (
          <p className="mt-3 text-xs text-neutral-600 dark:text-neutral-400">
            {range.window === null
              ? `History begins ${points[0].date}, the earliest price data for this printing.`
              : `Showing ${visible.length} day${visible.length === 1 ? "" : "s"} to ${last}; ${spanDays} days are available in total.`}
          </p>
        ) : null}
      </section>

      <section className="mb-8 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="text-xs text-neutral-600 dark:text-neutral-400">
          Vendors · {FINISH_LABEL[finish].toLowerCase()}
        </h2>
        <p className="mt-1 mb-4 text-sm text-neutral-600 dark:text-neutral-400">
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
              const otherFinish = other.finishes[0] ?? "nonfoil";
              const quote = otherQuotes?.get(
                `${other.id}.${FINISH_CODES[otherFinish]}`,
              );
              const askCents = otherQuotes
                ? (quote?.retailCents ?? null)
                : (other.prices.find(
                    (candidate) => candidate.finish === otherFinish,
                  )?.priceCents ?? null);
              return (
                <li key={other.scryfallId}>
                  <Link
                    href={`/cards/${other.scryfallId}`}
                    className="flex items-baseline justify-between gap-4 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900"
                  >
                    {/* The art is what tells two printings apart; the set
                        name often does not. */}
                    <CardHoverPreview
                      src={other.imageUri}
                      alt={`${other.name}, ${other.setName}`}
                      className="min-w-0 truncate"
                      foil={!other.finishes.includes("nonfoil")}
                    >
                      {other.setName}{" "}
                      <span className="font-mono text-xs text-neutral-600 dark:text-neutral-400">
                        {printingCode(
                          other.setCode,
                          other.collectorNumber,
                          other.releasedAt,
                        )}
                      </span>
                    </CardHoverPreview>
                    <span className="shrink-0 tabular-nums text-neutral-600 dark:text-neutral-400">
                      {askCents == null ? "no price" : formatUsd(askCents)}
                      {/* What they would pay, beside what they ask. Shown only
                          where it exists: a printing Card Kingdom sells but
                          does not buy is the common case, not an error. */}
                      {quote?.buylistCents != null ? (
                        <span className="ml-2 text-xs">
                          pays {formatUsd(quote.buylistCents)}
                        </span>
                      ) : null}
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
