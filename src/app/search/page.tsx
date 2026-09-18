import Link from "next/link";

import { AddHoldingForm } from "@/components/add-holding-form";
import { CardImage } from "@/components/card-image";
import { db } from "@/db";
import {
  SEARCH_LIMIT,
  countPrintings,
  searchPrintings,
} from "@/db/queries/printings";
import { FINISH_LABEL, formatUsd, printingCode } from "@/lib/format";

export const metadata = {
  title: "Add cards",
};

// Holdings change on every add, and the price table is refreshed by a nightly
// job, so there is nothing worth caching between requests here.
export const dynamic = "force-dynamic";

export default async function SearchPage(props: PageProps<"/search">) {
  // searchParams is a Promise in Next 16 — synchronous access was removed.
  const { q } = await props.searchParams;
  const query = typeof q === "string" ? q : "";
  const results = searchPrintings(db, query);
  const today = new Date().toISOString().slice(0, 10);
  const totalPrintings = countPrintings(db);

  return (
    <main className="page-shell py-10">
      <header className="mb-8 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Add cards</h1>
        <Link
          href="/"
          className="text-sm text-neutral-600 dark:text-neutral-400 underline-offset-4 hover:underline"
        >
          Back to collection
        </Link>
      </header>

      {/* A plain GET form: the query lives in the URL, so a search is
          linkable and works without JavaScript. */}
      <form method="get" className="mb-8 flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query}
          autoFocus
          placeholder="Card name, or set and number like blb 280"
          aria-label="Search cards"
          className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Search
        </button>
      </form>

      {totalPrintings === 0 ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          No cards in the database yet. Run{" "}
          <code className="font-mono">npm run ingest:scryfall</code> first.
        </p>
      ) : null}

      {query.trim().length === 1 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Type at least two characters.
        </p>
      ) : null}

      {query.trim().length >= 2 && results.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          No printings match <strong>{query}</strong>.
        </p>
      ) : null}

      {results.length > 0 ? (
        <>
          <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
            {results.length === SEARCH_LIMIT
              ? `First ${SEARCH_LIMIT} printings — narrow the search to see more.`
              : `${results.length} printing${results.length === 1 ? "" : "s"}.`}
          </p>

          {/* A single column of full-width cards wastes most of a wide display
              on empty space beside each one. Two fit comfortably from 1536px
              and three from 1920px, each still wide enough for the image, the
              details and the add form to sit in one row. */}
          <ul className="grid grid-cols-1 gap-3 2xl:grid-cols-2 3xl:grid-cols-3">
            {results.map((printing) => (
              <li
                key={printing.id}
                className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 sm:flex-row sm:items-start dark:border-neutral-800"
              >
                {printing.imageUri ? (
                  <CardImage
                    src={printing.imageUriLarge ?? printing.imageUri}
                    largeSrc={printing.imageUriLarge}
                    alt={printing.name}
                    className="h-64 w-44"
                  />
                ) : (
                  <div className="h-64 w-44 shrink-0 rounded bg-neutral-100 dark:bg-neutral-800" />
                )}

                <div className="min-w-0 flex-1">
                  <h2 className="font-medium">
                    <Link
                      href={`/cards/${printing.scryfallId}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {printing.name}
                    </Link>
                  </h2>
                  <p className="text-sm text-neutral-600 dark:text-neutral-400">
                    {printing.setName} ·{" "}
                    <span className="font-mono text-xs">
                      {printingCode(printing.setCode, printing.collectorNumber)}
                    </span>
                  </p>

                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                    {printing.finishes.map((finish) => {
                      const price = printing.prices.find(
                        (candidate) => candidate.finish === finish,
                      );
                      return (
                        <span key={finish}>
                          <span className="text-neutral-600 dark:text-neutral-400">
                            {FINISH_LABEL[finish]}:
                          </span>{" "}
                          {price ? (
                            <span className="font-medium tabular-nums">
                              {formatUsd(price.priceCents)}
                            </span>
                          ) : (
                            // Case B: no listing is not a price of zero.
                            <span className="text-amber-600 dark:text-amber-400">
                              no price
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </p>

                  <div className="mt-3">
                    <AddHoldingForm printing={printing} today={today} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </main>
  );
}
