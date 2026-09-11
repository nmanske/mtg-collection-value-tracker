import type { VendorQuote } from "@/db/queries/vendors";
import type { MarketSide, Vendor } from "@/db/schema";
import { formatUsd } from "@/lib/format";

/**
 * What each vendor quotes for one printing, retail beside buylist.
 *
 * Buylist coverage is thin in practice — against a real collection only Card
 * Kingdom publishes one — so the panel says which vendor a buylist figure
 * belongs to rather than implying a market-wide number.
 *
 * Every kept vendor quotes USD, so the figures here are directly comparable.
 */

const VENDOR_LABEL: Record<Vendor, string> = {
  tcgplayer: "TCGplayer",
  cardkingdom: "Card Kingdom",
};

const SIDE_LABEL: Record<MarketSide, string> = {
  retail: "asks",
  buylist: "pays",
};

function Row({
  quote,
  spreadAgainst,
}: {
  quote: VendorQuote;
  /** The same vendor's retail quote, for a buylist ratio. */
  spreadAgainst?: VendorQuote;
}) {
  const ratio =
    spreadAgainst && spreadAgainst.priceCents > 0
      ? quote.priceCents / spreadAgainst.priceCents
      : null;

  return (
    <tr className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
      <td className="py-1.5 pr-4">{VENDOR_LABEL[quote.vendor]}</td>
      <td className="py-1.5 pr-4 text-neutral-500">{SIDE_LABEL[quote.side]}</td>
      <td className="py-1.5 pr-4 text-right font-medium tabular-nums">
        {formatUsd(quote.priceCents)}
      </td>
      <td className="py-1.5 pr-4 text-right text-xs tabular-nums text-neutral-500">
        {ratio != null ? `${Math.round(ratio * 100)}% of retail` : ""}
      </td>
      <td className="py-1.5 text-right text-xs tabular-nums text-neutral-400">
        {quote.date}
      </td>
    </tr>
  );
}

export function VendorQuotes({ quotes }: { quotes: VendorQuote[] }) {
  if (quotes.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        No vendor comparison for this printing. Vendor data covers cards in your
        collection only — run{" "}
        <code className="font-mono text-xs">
          npm run backfill:mtgjson -- --vendors
        </code>{" "}
        after importing.
      </p>
    );
  }

  const retail = quotes.filter((quote) => quote.side === "retail");
  const buylist = quotes.filter((quote) => quote.side === "buylist");
  // A spread only means anything against the same vendor's own asking price.
  const retailFor = (vendor: Vendor) =>
    retail.find((quote) => quote.vendor === vendor);

  return (
    <div>
      <table className="w-full text-sm">
        <caption className="sr-only">
          Latest price from each vendor, retail and buylist
        </caption>
        <tbody>
          {retail
            .slice()
            .sort((a, b) => b.priceCents - a.priceCents)
            .map((quote) => (
              <Row key={`${quote.vendor}-${quote.side}`} quote={quote} />
            ))}
          {buylist
            .slice()
            .sort((a, b) => b.priceCents - a.priceCents)
            .map((quote) => (
              <Row
                key={`${quote.vendor}-${quote.side}`}
                quote={quote}
                spreadAgainst={retailFor(quote.vendor)}
              />
            ))}
        </tbody>
      </table>

      <p className="mt-3 text-xs text-neutral-500">
        {buylist.length === 0
          ? "No vendor publishes a buylist price for this printing."
          : `"Pays" is what that shop offers for the card, not the market.`}
      </p>
    </div>
  );
}
