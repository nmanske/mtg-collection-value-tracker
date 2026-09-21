import Link from "next/link";


import { db } from "@/db";
import { EXPORTS, EXPORT_ORDER, exportSizes } from "@/export/datasets";
import { currentScope } from "@/lib/session";

export const metadata = { title: "Export" };

export const dynamic = "force-dynamic";

/** A rough file size, so a download is not a surprise. */
function estimateBytes(id: string, rows: number): number {
  return rows * (id === "collection" ? 160 : 60);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} bytes`;
}

export default async function ExportPage() {
  const scope = await currentScope();
  const sizes = new Map(exportSizes(db, scope).map((row) => [row.id, row.rows]));

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Export</h1>
        <Link
          href="/"
          className="text-sm text-neutral-600 dark:text-neutral-400 underline-offset-4 hover:underline"
        >
          Back to collection
        </Link>
      </header>

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
                  <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                    {spec.description}
                  </p>
                  <p className="mt-2 text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
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

    </main>
  );
}
