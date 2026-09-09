import Link from "next/link";

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
          className="text-sm text-neutral-500 underline-offset-4 hover:underline"
        >
          Back to collection
        </Link>
      </header>

      <p className="mb-6 text-sm text-neutral-500">
        Export your collection from Moxfield as CSV, then upload it here.
        Acquisition dates come from the{" "}
        <code className="font-mono text-xs">Last Modified</code> column. That is
        strictly an edit timestamp rather than a purchase date — editing a card
        in Moxfield later moves it forward — so treat it as the earliest date
        you are known to have held the card. Rows with no usable timestamp fall
        back to today, and any date can be corrected per holding afterwards.
      </p>

      <p className="mb-6 text-sm text-neutral-500">
        The export is treated as your whole collection: quantities are set from
        the file, and cards it no longer lists are removed. Re-importing the
        same file therefore changes nothing. Cards you added by hand are left
        alone. Preview first to see exactly what would change.
      </p>

      <ImportForm />
    </main>
  );
}
