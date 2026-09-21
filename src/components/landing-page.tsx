import Link from "next/link";

import { CollectionIntake } from "@/components/collection-intake";

/**
 * What a visitor sees before there is anything to show them.
 *
 * Deliberately not a marketing page. Somebody arriving here either has a file
 * or has a card in mind, and both are one click away; the only prose is the
 * sentence that says what the numbers behind them are worth.
 */
export function LandingPage() {
  return (
    <main className="page-shell py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">
          What is your collection worth?
        </h1>
        <p className="mt-2 max-w-prose text-neutral-600 dark:text-neutral-400">
          Five years of daily prices for every Magic printing, from TCGplayer
          and Card Kingdom. Upload a collection and see what it is worth now,
          what it was worth then, and what a shop would pay for it today.
        </p>
      </header>

      <CollectionIntake />

      <footer className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-600 dark:text-neutral-400">
        <Link href="/faq" className="underline-offset-4 hover:underline">
          How it works
        </Link>
        <span>
          Prices from MTGJSON, updated daily. Card data and images from
          Scryfall.
        </span>
      </footer>
    </main>
  );
}
