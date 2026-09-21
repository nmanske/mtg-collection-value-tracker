import Link from "next/link";

import { STALE_AFTER_DAYS } from "@/db/queries/vendors";

export const metadata = { title: "How it works" };

/**
 * Where the longer explanations live.
 *
 * Kept short on purpose. Each answer is the least that stops a number being
 * misread; the reasoning behind the implementation belongs in the code, not
 * here. An answer needing a third paragraph is usually explaining a design
 * decision nobody asked about.
 */

function Q({
  id,
  question,
  children,
}: {
  id: string;
  question: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-8 border-t border-neutral-200 py-5 first:border-t-0 dark:border-neutral-800"
    >
      <h2 className="text-sm font-medium">{question}</h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
        {children}
      </p>
    </section>
  );
}

/** Emphasis inside an answer, for the terms being defined. */
function Term({ children }: { children: React.ReactNode }) {
  return (
    <strong className="font-medium text-neutral-800 dark:text-neutral-200">
      {children}
    </strong>
  );
}

export default function FaqPage() {
  return (
    <main className="page-shell py-10">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">How it works</h1>
        <Link
          href="/"
          className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
        >
          Back to collection
        </Link>
      </header>

      <Q id="kept" question="What happens to the file I upload?">
        It is read, matched against card data, and held on the server for as
        long as you are looking at it. There is no account and nothing is
        linked to you — your browser gets an opaque id in a cookie, and the
        collection behind it is deleted after two days idle, or the moment you
        press <Term>Forget this collection</Term>. Nothing is shared, sold, or
        kept.
      </Q>

      <Q id="which-printing" question="How is a plain decklist priced?">
        A line naming a set and number — <code>1 Sol Ring (C18) 120</code> — is
        that exact printing. A line with only a name is ambiguous, and Sol Ring
        alone spans three orders of magnitude, so the <Term>cheapest</Term>
        printing with a price is used: a list without set information is a list
        of cards to acquire, and what it is worth is what it would cost.
      </Q>

      <Q id="list-value" question="Why does a pasted list have no “as held” line?">
        Because a list says nothing about when anything was acquired. Drawing
        one would mean pretending you bought every card the moment you pasted
        it. What is shown instead is the same cards valued backwards through
        time — what that list would have been worth — which is the only
        question a list without dates can answer. A Moxfield collection export
        does carry dates, so it gets the real line.
      </Q>

      <Q id="two-lines" question="What are the two lines on the chart?">
        <Term>As held</Term> is what your collection was worth each day — it
        rises when prices rise and when you buy. <Term>Price change only</Term> values
        today&rsquo;s cards on every past date, so buying is held out and only
        price movement is left.
      </Q>

      <Q
        id="acquisition-dates"
        question="Why are some acquisition dates marked *?"
      >
        Moxfield exports a last-modified date, not a purchase date, and it moves
        forward whenever you edit a card. Everything you already owned at your
        first upload therefore shares one date. Those are counted from that
        date, which is the latest they could have arrived, so the figures
        understate rather than invent.
      </Q>

      <Q id="movers" question="What are risers and fallers measured from?">
        The day you acquired each card, not the start of the price history. A
        card bought in 2023 measured from its 2020 price would rank by what the
        market did before you owned it.
      </Q>

      <Q
        id="stale"
        question="Why does the vendor table total less than the chart?"
      >
        They answer different questions. The chart asks what your cards were
        worth on a date, where an old price is the right answer. The vendor
        table asks what a shop would pay <em>today</em>, so it drops quotes more
        than {STALE_AFTER_DAYS} days behind that vendor&rsquo;s newest data.
      </Q>

      <Q id="coverage" question="What do the vendor columns mean?">
        <Term>Asks</Term> is what the shop sells for, <Term>pays</Term> is what
        it would buy from you, and <Term>covers</Term> is how many of your cards
        it quotes at all. A lower total usually means thinner coverage rather
        than a better price.
      </Q>

      <Q id="unpriced" question="What happens to cards with no price?">
        They are left out of totals rather than counted as $0, and flagged
        wherever that changes a figure.
      </Q>

      <Q id="freshness" question="Where do the prices come from?">
        MTGJSON, once a day, for TCGplayer and Card Kingdom. Scryfall supplies
        card details and images but no prices. If a day is missed the dashboard
        says so — MTGJSON serves only about 90 days of history, so a gap left
        long enough becomes permanent.
      </Q>
    </main>
  );
}
