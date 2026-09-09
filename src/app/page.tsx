import Link from "next/link";

import { db } from "@/db";
import { RemoveHoldingButton } from "@/components/remove-holding-button";
import { listHoldings } from "@/db/queries/holdings";
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
  const { page } = await props.searchParams;
  const { rows, totalCards, totalValueCents, unpricedCount, holdingCount, pageCount, page: current } =
    listHoldings(db, Number(page) || 1);

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

        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums">
              {formatUsd(totalValueCents)}
            </div>
            <div className="text-xs text-neutral-500">current value</div>
          </div>
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

      {unpricedCount > 0 ? (
        // Never let an unpriced card quietly count as $0 in the total.
        <p className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {unpricedCount} holding{unpricedCount === 1 ? " has" : "s have"} no
          price from any source and {unpricedCount === 1 ? "is" : "are"} excluded
          from the total above.
        </p>
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
                      <div className="font-medium">{row.name}</div>
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
              href={`/?page=${current - 1}`}
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
              href={`/?page=${current + 1}`}
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
