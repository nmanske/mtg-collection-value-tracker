import type { VendorQuote } from "@/db/queries/vendors";
import type { Currency, MarketSide, Vendor } from "@/db/schema";
import { formatMoney } from "@/lib/format";

/**
 * What each vendor quotes for one printing, retail beside buylist.
 *
 * Buylist coverage is thin in practice — against a real collection only Card
 * Kingdom publishes one — so the panel says which vendor a buylist figure
 * belongs to rather than implying a market-wide number.
 *
 * Currencies are never mixed or converted: Cardmarket quotes euros and is
 * labelled as such.
 */

const VENDOR_LABEL: Record<Vendor, string> = {
  tcgplayer: "TCGplayer",
  cardkingdom: "Card Kingdom",
  cardmarket: "Cardmarket",
  manapool: "Mana Pool",
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
  /** The retail quote in the same currency, for a buylist ratio. */
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
        {formatMoney(quote.priceCents, quote.currency)}
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
  const currencies = new Set(quotes.map((quote) => quote.currency));

  // Retail in the same currency, so a buylist ratio compares like with like.
  const retailFor = (vendor: Vendor, currency: Currency) =>
    retail.find(
      (quote) => quote.vendor === vendor && quote.currency === currency,
    );

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
                spreadAgainst={retailFor(quote.vendor, quote.currency)}
              />
            ))}
        </tbody>
      </table>

      <p className="mt-3 text-xs text-neutral-500">
        {buylist.length === 0
          ? "No vendor publishes a buylist price for this printing."
          : `"Pays" is what that shop offers for the card, not the market.`}
        {currencies.has("EUR")
          ? " Cardmarket quotes euros; nothing here converts between currencies."
          : ""}
      </p>
    </div>
  );
}
