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
        Export your collection from Moxfield as CSV, then upload it here. Every
        row is stamped with today&apos;s date as its acquisition date —
        Moxfield&apos;s export has no acquisition date, and its{" "}
        <code className="font-mono text-xs">Last Modified</code> column is its
        own edit timestamp rather than when you got the card. You can edit
        individual dates afterwards.
      </p>

      <ImportForm />
    </main>
  );
}
