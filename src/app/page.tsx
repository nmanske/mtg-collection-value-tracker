import Link from "next/link";

import { db } from "@/db";
import { PortfolioSummaryPanel } from "@/components/portfolio-summary";
import { VendorTotals } from "@/components/vendor-totals";
import { listHoldings } from "@/db/queries/holdings";
import { CollectionControls } from "@/components/collection-controls";
import { PrivacyToggle } from "@/components/privacy-toggle";
import {
  collectionHref,
  nextDir,
  resolveDir,
  resolveFilter,
  resolveSort,
  type SortId,
} from "@/lib/collection-view";
import {
  portfolioSummary,
  PRICE_VENDORS,
  type PriceVendor,
} from "@/db/queries/valuation";
import { collectionByVendor } from "@/db/queries/vendors";
import { cachedPortfolioSeries } from "@/db/queries/portfolio-cache";
import { priceFreshness } from "@/db/queries/freshness";
import { PriceFreshnessBanner } from "@/components/price-freshness-banner";
import {
  FINISH_LABEL,
  daysAgo,
  formatUsd,
} from "@/lib/format";

// Reads the collection on every request; adds and removes must show at once.
export const dynamic = "force-dynamic";

/**
 * A column heading that sorts.
 *
 * A link rather than a button, so the sorted view has a URL that survives a
 * reload and a share, and so the table still sorts with JavaScript off. The
 * arrow is the only indicator, and it is paired with `aria-sort` rather than
 * left to colour or position.
 */
function SortHeader({
  column,
  label,
  align,
  sort,
  dir,
  filter,
  search,
}: {
  column: SortId;
  label: string;
  align?: "right";
  sort: SortId;
  dir: "asc" | "desc";
  filter: ReturnType<typeof resolveFilter>;
  search: string;
}) {
  const active = column === sort;
  const target = nextDir(column, sort, dir);

  return (
    <th
      scope="col"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={`py-2 pr-3 font-medium ${align === "right" ? "text-right" : ""}`}
    >
      <Link
        href={collectionHref({ sort: column, dir: target, filter, search })}
        scroll={false}
        className="inline-flex items-center gap-1 hover:text-neutral-700 dark:hover:text-neutral-200"
      >
        {label}
        <span aria-hidden className={active ? "" : "opacity-0"}>
          {dir === "asc" ? "↑" : "↓"}
        </span>
      </Link>
    </th>
  );
}

export default async function CollectionPage(props: PageProps<"/">) {
  // searchParams is a Promise in Next 16.
  const { page, range, prices, sort, dir, filter, q } = await props.searchParams;
  const priceSource: PriceVendor =
    typeof prices === "string" && (PRICE_VENDORS as readonly string[]).includes(prices)
      ? (prices as PriceVendor)
      : "tcgplayer";
  const activeSort = resolveSort(typeof sort === "string" ? sort : undefined);
  const activeDir = resolveDir(typeof dir === "string" ? dir : undefined, activeSort);
  const activeFilter = resolveFilter(
    typeof filter === "string" ? filter : undefined,
  );
  const search = typeof q === "string" ? q : "";

  const {
    rows,
    totalCards,
    unpricedCount,
    holdingCount,
    pageCount,
    page: current,
    matched,
  } = listHoldings(db, {
    page: Number(page) || 1,
    sort: activeSort,
    dir: activeDir,
    filter: activeFilter,
    search,
  });
  const summary = portfolioSummary(db, priceSource);
  // Card Kingdom is the only vendor here that publishes a buy price, so the
  // "if sold today" line exists on their view and nowhere else.
  const buylistPoints =
    priceSource === "cardkingdom"
      ? cachedPortfolioSeries(db, { buylist: true }).points
      : undefined;
  const vendorTotals = collectionByVendor(db);
  const freshness = priceFreshness(db);

  return (
    <main className="page-shell py-10">
      {/* Above the header: if prices have stopped arriving, that outranks
          every number on the page, because every number is derived from them. */}
      <PriceFreshnessBanner freshness={freshness} />

      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Collection</h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            {totalCards.toLocaleString()} card
            {totalCards === 1 ? "" : "s"} across{" "}
            {holdingCount.toLocaleString()} holding
            {holdingCount === 1 ? "" : "s"}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Quiet, because it is read once and then rarely. */}
          <Link
            href="/faq"
            className="px-1 text-sm text-neutral-600 dark:text-neutral-400 underline-offset-4 hover:underline"
          >
            How it works
          </Link>
          <PrivacyToggle />
          <Link
            href="/stats"
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Stats
          </Link>
          <Link
            href="/export"
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Export
          </Link>
          <Link
            href="/import"
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Import CSV
          </Link>
        </div>
      </header>

      <PortfolioSummaryPanel
        summary={summary}
        buylistPoints={buylistPoints}
        range={typeof range === "string" ? range : undefined}
        priceSource={priceSource}
        // The retail row for the selected vendor is what the chart is drawn
        // from, so its stale count is what explains the gap between the two.
        staleHoldings={
          vendorTotals.find(
            (row) => row.vendor === priceSource && row.side === "retail",
          )?.stale ?? 0
        }
      />

      <VendorTotals totals={vendorTotals} holdingCount={holdingCount} />

      {unpricedCount > 0 ? (
        // Never let an unpriced card quietly count as $0 in the total.
        <p className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {unpricedCount} unpriced holding{unpricedCount === 1 ? "" : "s"},
          excluded from the total.
        </p>
      ) : null}

      {holdingCount > 0 ? (
        <CollectionControls
          sort={activeSort}
          filter={activeFilter}
          search={search}
          matched={matched}
          total={holdingCount}
        />
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center dark:border-neutral-700">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Nothing here yet.{" "}
            <Link href="/search" className="underline underline-offset-4">
              Search for a card
            </Link>{" "}
            or{" "}
            <Link href="/import" className="underline underline-offset-4">
              import a Moxfield CSV
            </Link>
            .
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-600 dark:text-neutral-400 dark:border-neutral-800">
                {(
                  [
                    ["name", "Card", undefined],
                    ["set", "Set", undefined],
                    ["finish", "Finish", undefined],
                    ["condition", "Cond", undefined],
                    ["quantity", "Qty", "right"],
                    ["unit", "Unit", "right"],
                    ["value", "Value", "right"],
                    ["acquired", "Acquired", undefined],
                  ] as const
                ).map(([column, label, align]) => (
                  <SortHeader
                    key={column}
                    column={column}
                    label={label}
                    align={align}
                    sort={activeSort}
                    dir={activeDir}
                    filter={activeFilter}
                    search={search}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const stale =
                  row.priceDate != null && daysAgo(row.priceDate) > 2;

                return (
                  <tr
                    key={row.id}
                    className="border-b border-neutral-100 dark:border-neutral-900"
                  >
                    <td className="py-2 pr-3">
                      <div className="font-medium">
                        <Link
                          href={`/cards/${row.scryfallId}?finish=${row.finish}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {row.name}
                        </Link>
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <div className="font-mono text-xs uppercase">
                        {row.setCode}
                      </div>
                      <div className="font-mono text-xs text-neutral-600 dark:text-neutral-400">
                        #{row.collectorNumber}
                      </div>
                    </td>
                    <td className="py-2 pr-3">{FINISH_LABEL[row.finish]}</td>
                    <td className="py-2 pr-3">{row.condition}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {row.quantity}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {row.unitPriceCents == null ? (
                        <span className="text-amber-600 dark:text-amber-400">
                          no price
                        </span>
                      ) : (
                        <>
                          {formatUsd(row.unitPriceCents)}
                          {row.overridden ? (
                            <span
                              className="ml-1 text-xs text-neutral-600 dark:text-neutral-400"
                              title="Manual override"
                            >
                              (manual)
                            </span>
                          ) : stale && row.priceDate ? (
                            <span
                              className="ml-1 text-xs text-neutral-600 dark:text-neutral-400"
                              title={`Last priced ${row.priceDate}`}
                            >
                              ({daysAgo(row.priceDate)}d old)
                            </span>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {row.unitPriceCents == null
                        ? "—"
                        : formatUsd(row.unitPriceCents * row.quantity)}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-neutral-600 dark:text-neutral-400">
                      {row.dateAdded}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pageCount > 1 ? (
        // The table is paged because rendering thousands of rows costs seconds
        // of server render time; the totals above always cover everything.
        <nav
          aria-label="Pagination"
          className="mt-6 flex items-center justify-between text-sm"
        >
          {current > 1 ? (
            <Link
              href={collectionHref({
                sort: activeSort,
                filter: activeFilter,
                search,
                page: current - 1,
              })}
              className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Previous
            </Link>
          ) : (
            <span />
          )}

          <span className="text-neutral-600 dark:text-neutral-400">
            Page {current.toLocaleString()} of {pageCount.toLocaleString()}
          </span>

          {current < pageCount ? (
            <Link
              href={collectionHref({
                sort: activeSort,
                filter: activeFilter,
                search,
                page: current + 1,
              })}
              className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </main>
  );
}
