import Link from "next/link";

import { db } from "@/db";
import { PortfolioSummaryPanel } from "@/components/portfolio-summary";
import { VendorTotals } from "@/components/vendor-totals";
import { RemoveHoldingButton } from "@/components/remove-holding-button";
import { listHoldings } from "@/db/queries/holdings";
import { CollectionControls } from "@/components/collection-controls";
import {
  collectionHref,
  resolveFilter,
  resolveSort,
} from "@/lib/collection-view";
import {
  portfolioSummary,
  PRICE_VENDORS,
  type PriceVendor,
} from "@/db/queries/valuation";
import { collectionByVendor } from "@/db/queries/vendors";
import {
  FINISH_LABEL,
  daysAgo,
  formatUsd,
  printingCode,
} from "@/lib/format";

// Reads the collection on every request; adds and removes must show at once.
export const dynamic = "force-dynamic";

export default async function CollectionPage(props: PageProps<"/">) {
  // searchParams is a Promise in Next 16.
  const { page, range, prices, sort, filter, q } = await props.searchParams;
  const priceSource: PriceVendor =
    typeof prices === "string" && (PRICE_VENDORS as readonly string[]).includes(prices)
      ? (prices as PriceVendor)
      : "tcgplayer";
  const activeSort = resolveSort(typeof sort === "string" ? sort : undefined);
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
    filter: activeFilter,
    search,
  });
  const summary = portfolioSummary(db, priceSource);
  const vendorTotals = collectionByVendor(db);

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Collection</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {totalCards.toLocaleString()} card
            {totalCards === 1 ? "" : "s"} across{" "}
            {holdingCount.toLocaleString()} holding
            {holdingCount === 1 ? "" : "s"}
          </p>
        </div>

        <div className="flex items-center gap-3">
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
          <Link
            href="/search"
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            Add cards
          </Link>
        </div>
      </header>

      <PortfolioSummaryPanel
        summary={summary}
        range={typeof range === "string" ? range : undefined}
        priceSource={priceSource}
      />

      <VendorTotals totals={vendorTotals} holdingCount={holdingCount} />

      {unpricedCount > 0 ? (
        // Never let an unpriced card quietly count as $0 in the total.
        <p className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {unpricedCount} holding{unpricedCount === 1 ? " has" : "s have"} no
          price from any source and {unpricedCount === 1 ? "is" : "are"} excluded
          from the total above.
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
          <p className="text-sm text-neutral-500">
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
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                <th className="py-2 pr-3 font-medium">Card</th>
                <th className="py-2 pr-3 font-medium">Finish</th>
                <th className="py-2 pr-3 font-medium">Cond</th>
                <th className="py-2 pr-3 text-right font-medium">Qty</th>
                <th className="py-2 pr-3 text-right font-medium">Unit</th>
                <th className="py-2 pr-3 text-right font-medium">Value</th>
                <th className="py-2 pr-3 font-medium">Acquired</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const label = `${row.name} (${printingCode(row.setCode, row.collectorNumber)})`;
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
                      <div className="font-mono text-xs text-neutral-500">
                        {printingCode(row.setCode, row.collectorNumber)}
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
                              className="ml-1 text-xs text-neutral-500"
                              title="Manual override"
                            >
                              (manual)
                            </span>
                          ) : stale && row.priceDate ? (
                            <span
                              className="ml-1 text-xs text-neutral-500"
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
                    <td className="py-2 pr-3 tabular-nums text-neutral-500">
                      {row.dateAdded}
                    </td>
                    <td className="py-2 text-right">
                      <RemoveHoldingButton holdingId={row.id} label={label} />
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

          <span className="text-neutral-500">
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
