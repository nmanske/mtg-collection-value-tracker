import Link from "next/link";

import { db } from "@/db";
import { EXPORTS, EXPORT_ORDER, exportSizes } from "@/export/datasets";

export const metadata = { title: "Export" };

export const dynamic = "force-dynamic";

/** A rough file size, so a 31 MB download is not a surprise. */
function estimateBytes(id: string, rows: number): number {
  const perRow = id === "price-history" ? 72 : id === "collection" ? 160 : 60;
  return rows * perRow;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} bytes`;
}

export default async function ExportPage() {
  const sizes = new Map(exportSizes(db).map((row) => [row.id, row.rows]));

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Export</h1>
        <Link
          href="/"
          className="text-sm text-neutral-500 underline-offset-4 hover:underline"
        >
          Back to collection
        </Link>
      </header>

      <p className="mb-8 text-sm text-neutral-500">
        Everything here is CSV, UTF-8 with a byte-order mark so spreadsheets read
        accented card names correctly. Each export is scoped to your collection
        rather than the whole card database — the price tables hold 15.7 million
        rows between them, and dumping those verbatim is what these are designed
        to avoid.
      </p>

      <ul className="flex flex-col gap-4">
        {EXPORT_ORDER.map((id) => {
          const spec = EXPORTS[id];
          const rows = sizes.get(id) ?? 0;
          const bytes = estimateBytes(id, rows);
          const large = bytes > 5e6;

          return (
            <li
              key={id}
              className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="font-medium">{spec.title}</h2>
                  <p className="mt-1 text-sm text-neutral-500">
                    {spec.description}
                  </p>
                  <p className="mt-2 text-xs tabular-nums text-neutral-500">
                    {rows.toLocaleString()} row{rows === 1 ? "" : "s"} ·
                    approximately {formatBytes(bytes)}
                    {large ? (
                      <span className="ml-1 text-amber-600 dark:text-amber-400">
                        · large file, streamed
                      </span>
                    ) : null}
                  </p>
                </div>

                {/* A plain link, not a fetch: the browser saves the response
                    directly and the file never passes through React state. */}
                <a
                  href={`/api/export/${id}`}
                  download
                  className="shrink-0 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
                >
                  Download CSV
                </a>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-8 flex flex-col gap-2 text-xs text-neutral-500">
        <p>
          The two card exports are meant to be used together and share no
          duplicated columns.{" "}
          <strong className="font-medium">Collection</strong> describes each
          card once — name, set, quantity, today&apos;s prices.{" "}
          <strong className="font-medium">Price history</strong> is the time
          series alone, identified by{" "}
          <code className="font-mono">scryfall_id</code> and{" "}
          <code className="font-mono">finish</code>. Join on those two columns
          to put names against the history.
        </p>
        <p>
          Card names are deliberately absent from the history: repeating them
          once per date wrote the same 3,724 names 89 times, which was a fifth
          of the file.
        </p>
        <p>
          Prices are decimal dollars except the Cardmarket columns, which are
          euros and labelled as such — nothing here converts between
          currencies. Vendor prices are columns rather than extra rows, which
          keeps the history to a third of a million rows instead of roughly
          three million.
        </p>
      </div>
    </main>
  );
}
