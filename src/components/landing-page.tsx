import Link from "next/link";

import { CollectionIntake } from "@/components/collection-intake";

/**
 * What a visitor sees before there is anything to show them.
 *
 * Deliberately short. Somebody arriving here either has a file or has a card
 * in mind, and both are one click away; every sentence that is not helping
 * them do one of those is in the way. The only prose left is the line saying
 * what happens to an upload, which is the question a stranger actually has
 * when a site asks them for one.
 */
export function LandingPage() {
  return (
    <main className="page-shell py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">
          What is your collection worth?
        </h1>
        <p className="mt-2 text-neutral-600 dark:text-neutral-400">
          Five years of daily Magic prices, from TCGplayer and Card Kingdom.
        </p>
      </header>

      <CollectionIntake />

      <footer className="mt-8 flex flex-wrap gap-x-5 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
        <Link href="/faq" className="underline-offset-4 hover:underline">
          How it works
        </Link>
        <span>Prices from MTGJSON. Cards and images from Scryfall.</span>
      </footer>
    </main>
  );
}
