import Link from "next/link";

import { STALE_AFTER_DAYS } from "@/db/queries/vendors";

export const metadata = { title: "How it works" };

/**
 * Where the long explanations live.
 *
 * Each of these used to sit permanently under the figure it described, in grey
 * text, on every visit. They are worth keeping — several of them are the
 * difference between reading a number correctly and misreading it — but they
 * are read once, not daily. The pages now state the fact and link here.
 */

function Q({ id, question, children }: { id: string; question: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-8 border-t border-neutral-200 py-6 first:border-t-0 dark:border-neutral-800">
      <h2 className="text-sm font-medium">{question}</h2>
      <div className="mt-2 max-w-prose space-y-3 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
        {children}
      </div>
    </section>
  );
}

export default function FaqPage() {
  return (
    <main className="page-shell py-10">
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">How it works</h1>
        <Link href="/" className="text-sm text-neutral-600 dark:text-neutral-400 underline-offset-4 hover:underline">
          Back to collection
        </Link>
      </header>

      <p className="mb-6 max-w-prose text-sm text-neutral-600 dark:text-neutral-400">
        Why some of the numbers here mean less, or more, than they appear to.
      </p>

      <Q id="two-lines" question="Why are there two lines on the chart?">
        <p>
          <strong className="font-medium text-neutral-700 dark:text-neutral-300">As held</strong> is
          what the collection was actually worth on each day — it rises when prices rise and when
          you buy cards.
        </p>
        <p>
          <strong className="font-medium text-neutral-700 dark:text-neutral-300">Prices only</strong>{" "}
          values the cards you own <em>today</em> on every past date, so buying is held out and only
          price movement is left. It is not a market index: the basket is whatever you happen to own
          now, so it is chosen with hindsight.
        </p>
      </Q>

      <Q id="acquisition-dates" question="Why do some acquisition dates look wrong?">
        <p>
          Moxfield&rsquo;s export gives a last-modified timestamp, not a purchase date, and it moves
          forward every time you edit a card. Everything you already owned when you first uploaded
          your collection therefore shares one date.
        </p>
        <p>
          Those holdings are counted from that date. It is an upper bound, so the line understates
          the past rather than inventing it, and they are not drawn as a day of buying. The step you
          see is the upload, not a shopping spree.
        </p>
      </Q>

      <Q id="stale" question="Why does the vendor table total less than the chart?">
        <p>
          They answer different questions. The chart asks what your cards were worth on a date, and
          a three-year-old price is the right answer for a three-year-old date.
        </p>
        <p>
          The vendor table asks what a shop would pay <em>today</em>, so it drops any quote more than{" "}
          {STALE_AFTER_DAYS} days older than that vendor&rsquo;s newest data rather than repeating a
          price nobody would honour. Both figures are correct; the vendor one is smaller.
        </p>
      </Q>

      <Q id="coverage" question="What do the vendor columns mean?">
        <p>
          <strong className="font-medium text-neutral-700 dark:text-neutral-300">Asks</strong> is what
          that shop sells the card for.{" "}
          <strong className="font-medium text-neutral-700 dark:text-neutral-300">Pays</strong> is what
          it offers to buy the card from you — its buylist price, not the market.{" "}
          <strong className="font-medium text-neutral-700 dark:text-neutral-300">Covers</strong> is how
          many of your holdings that vendor quotes at all.
        </p>
        <p>
          A lower total usually means thinner coverage rather than a better price, so read{" "}
          <em>covers</em> before reading a smaller figure as a discount. Totals also leave out any
          quote more than {STALE_AFTER_DAYS} days older than that vendor&rsquo;s newest data.
        </p>
      </Q>

      <Q id="unpriced" question="What happens to cards with no price?">
        <p>
          They are left out of totals rather than counted as $0, and flagged wherever that changes a
          figure. Silently valuing an unpriced card at nothing is the easiest way to make a
          collection look like it lost money.
        </p>
      </Q>

      <Q id="like-for-like" question="How is “best year” calculated?">
        <p>
          Not by reading two points off the chart. A card cannot have a price before it was printed,
          so a basket of today&rsquo;s cards quietly grows as you go forward through time — about
          two thirds of the current collection had a price in 2020, against all of it now. Subtracting
          two dates would report five years of new printings as growth.
        </p>
        <p>
          Instead each month is compared only against the cards priced at <em>both</em> ends of that
          month, and the months are chained together. Cards appearing then affects where a step
          starts, never the size of the move. On this collection the raw chart reads +58% since 2020;
          measured properly it is &minus;13%.
        </p>
      </Q>

      <Q id="freshness" question="Where do the prices come from?">
        <p>
          MTGJSON, once a day, for TCGplayer and Card Kingdom. Scryfall supplies card details and
          images but no prices, so there is one pricing source to reason about.
        </p>
        <p>
          If a day is missed the dashboard says so. MTGJSON only serves about 90 days of history, so
          a gap left long enough becomes permanent.
        </p>
      </Q>

      <Q id="exports" question="Why can't I export the full price history?">
        <p>
          The exports describe your collection — what you own, and what it has been worth. The price
          tables behind them run to hundreds of millions of rows and belong to the providers, not to
          us. You can export your holdings with current prices, and the daily total behind the chart.
        </p>
      </Q>
    </main>
  );
}
