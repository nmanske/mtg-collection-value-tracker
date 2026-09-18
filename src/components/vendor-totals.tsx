import Link from "next/link";

import { InfoTip } from "./info-tip";
import {
  type CollectionTotalsByVendor,
  STALE_AFTER_DAYS,
} from "@/db/queries/vendors";
import type { MarketSide, Vendor } from "@/db/schema";
import { formatUsd } from "@/lib/format";

/**
 * What the collection is worth from each vendor, and what it would fetch if
 * sold.
 *
 * Coverage is stated on every row rather than left implied. Vendors quote
 * different subsets of a collection, so an uncaveated comparison would read a
 * partial total against a complete one and look like a price difference.
 *
 * This never replaces the headline portfolio figure, which stays on the
 * canonical TCGplayer-retail series so it keeps one definition.
 */

const VENDOR_LABEL: Record<Vendor, string> = {
  tcgplayer: "TCGplayer",
  cardkingdom: "Card Kingdom",
};

const SIDE_LABEL: Record<MarketSide, string> = {
  retail: "retail",
  buylist: "buylist",
};

export function VendorTotals({
  totals,
  holdingCount,
}: {
  totals: CollectionTotalsByVendor[];
  holdingCount: number;
}) {
  if (totals.length === 0) return null;

  return (
    <section
      aria-labelledby="vendor-totals-heading"
      className="mb-8 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
    >
      <h2
        id="vendor-totals-heading"
        className="text-xs text-neutral-500"
      >
        By vendor
      </h2>
      <p className="mt-1 mb-4 text-sm text-neutral-500">
        What each shop asks, and what it would pay.
      </p>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
            <th scope="col" className="py-2 pr-4 font-medium">
              Vendor
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Side
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              Total
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Covers
            </th>
            <th scope="col" className="py-2 font-medium">
              Priced
            </th>
          </tr>
        </thead>
        <tbody>
          {totals.map((row) => {
            const coverage =
              holdingCount > 0 ? row.covered / holdingCount : 0;

            return (
              <tr
                key={`${row.vendor}-${row.side}`}
                className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
              >
                <td className="py-2 pr-4">{VENDOR_LABEL[row.vendor]}</td>
                <td className="py-2 pr-4 text-neutral-500">
                  {SIDE_LABEL[row.side]}
                </td>
                <td className="py-2 pr-4 text-right font-medium tabular-nums">
                  {formatUsd(row.totalCents)}
                </td>
                <td className="py-2 text-xs tabular-nums text-neutral-500">
                  {/* Plain text, not a bar. Every vendor quotes 95-100% of a
                      real collection, so a coverage bar is five identical
                      shapes; the number only matters when it is short. */}
                  {row.missing === 0 ? (
                    <span>all {holdingCount.toLocaleString()}</span>
                  ) : row.stale > 0 ? (
                    // Named rather than folded into "missing": a card the shop
                    // never quotes and one it quoted three years ago are
                    // different facts, and only the second looks like a bug
                    // when the totals move.
                    <span className="text-amber-600 dark:text-amber-400">
                      {row.covered.toLocaleString()} of{" "}
                      {holdingCount.toLocaleString()}
                      <span className="text-neutral-500">
                        {" "}
                        · {row.stale.toLocaleString()} last quoted over{" "}
                        {STALE_AFTER_DAYS} days ago, excluded
                      </span>
                    </span>
                  ) : (
                    <span
                      className={
                        coverage < 0.99
                          ? "text-amber-600 dark:text-amber-400"
                          : undefined
                      }
                    >
                      {row.covered.toLocaleString()} of{" "}
                      {holdingCount.toLocaleString()}
                      {coverage < 0.99
                        ? ` (${Math.round(coverage * 100)}%)`
                        : ""}
                    </span>
                  )}
                </td>
                <td
                  className="py-2 text-xs tabular-nums text-neutral-500"
                  // Almost every card is priced on the newest date, so that is
                  // the only one shown. The rare card a shop has stopped
                  // listing keeps an older price in the total; the oldest one
                  // still counted rides along as a tooltip rather than a second
                  // date, which read as a range and invited the question of
                  // which number the total actually used.
                  title={
                    row.oldestDate && row.oldestDate !== row.date
                      ? `Oldest price still counted in this total: ${row.oldestDate}`
                      : undefined
                  }
                >
                  {row.date ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="mt-4 text-xs text-neutral-500">
        A lower total often means thinner coverage, not a better price &mdash;
        check <em>covers</em>.
        <InfoTip label="How these totals are built">
          Totals span only the cards a vendor actually quotes, and leave out any
          quote more than {STALE_AFTER_DAYS} days older than that
          vendor&rsquo;s newest data.{" "}
          <Link href="/faq#coverage" className="underline underline-offset-2">
            More
          </Link>
        </InfoTip>
      </div>

    </section>
  );
}
