import Link from "next/link";

import { InfoTip } from "@/components/info-tip";

import { ImportForm } from "@/components/import-form";

export const metadata = { title: "Import collection" };

export const dynamic = "force-dynamic";

export default function ImportPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          Import from Moxfield
        </h1>
        <Link
          href="/"
          className="text-sm text-neutral-600 dark:text-neutral-400 underline-offset-4 hover:underline"
        >
          Back to collection
        </Link>
      </header>

      <div className="mb-6 max-w-prose text-sm text-neutral-600 dark:text-neutral-400">
        Export your collection from Moxfield as CSV and upload it here. The file
        is treated as your whole collection: quantities are set from it, and
        cards it no longer lists are removed. Hand-added cards are left alone.
        <InfoTip label="How import handles dates and re-imports">
          Acquisition dates come from Moxfield&rsquo;s{" "}
          <code className="font-mono">Last Modified</code> column, which is an
          edit timestamp rather than a purchase date, so treat it as the
          earliest date you are known to have held the card. Rows with no
          timestamp fall back to today, and any date can be corrected per
          holding afterwards. Re-importing the same file changes nothing.{" "}
          <Link href="/faq#acquisition-dates" className="underline underline-offset-2">
            More
          </Link>
        </InfoTip>
      </div>

      <p className="mb-6 text-sm text-neutral-600 dark:text-neutral-400">
        Preview first to see exactly what would change.
      </p>

      <ImportForm />
    </main>
  );
}
