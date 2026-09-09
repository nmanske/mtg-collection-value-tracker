import type { CollectionTotalsByVendor } from "@/db/queries/vendors";
import type { MarketSide, Vendor } from "@/db/schema";
import { formatMoney } from "@/lib/format";

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
  cardmarket: "Cardmarket",
  manapool: "Mana Pool",
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
        What each shop asks for your cards, and what it would pay for them.
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
            <th scope="col" className="py-2 font-medium">
              Covers
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
                  {formatMoney(row.totalCents, row.currency)}
                </td>
                <td className="py-2 text-xs tabular-nums text-neutral-500">
                  {/* Plain text, not a bar. Every vendor quotes 95-100% of a
                      real collection, so a coverage bar is five identical
                      shapes; the number only matters when it is short. */}
                  {row.missing === 0 ? (
                    <span>all {holdingCount.toLocaleString()}</span>
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
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="mt-4 text-xs text-neutral-500">
        Totals only span the holdings a vendor actually quotes, so a smaller
        figure may mean thinner coverage rather than a lower price — check the
        &ldquo;covers&rdquo; column before reading it as a discount. Cardmarket
        quotes euros and is not converted. Vendor data covers your collection
        only.
      </p>
    </section>
  );
}
