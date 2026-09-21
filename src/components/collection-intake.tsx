"use client";

import { useActionState, useState } from "react";
import Link from "next/link";

import {
  pasteListAction,
  uploadCsvAction,
  type UploadResult,
} from "@/app/actions/collection";

/**
 * The front door.
 *
 * Two ways in, side by side, because there are two reasons to be here and
 * neither is more legitimate than the other: you have a collection and want to
 * know what it is worth, or you have one card in mind. Hiding the card search
 * behind an upload prompt would make the second reason feel like a detour
 * through the first.
 *
 * Nothing is kept. That is said once, plainly, near the button rather than in
 * a footer — it is the answer to the question a stranger actually has when a
 * site asks them to upload a file.
 */

type Tab = "file" | "list";

export function CollectionIntake() {
  const [tab, setTab] = useState<Tab>("file");

  return (
    <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
      <section className="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800">
        <h2 className="text-lg font-medium">Value a collection</h2>
        <p className="mt-1 max-w-prose text-sm text-neutral-600 dark:text-neutral-400">
          Upload a Moxfield collection export, or paste any decklist. You get
          the full dashboard — value over time, biggest movers, what each shop
          would pay — for as long as this browser stays on the page.
        </p>

        <div
          role="tablist"
          aria-label="How to add a collection"
          className="mt-5 flex gap-1"
        >
          <TabButton current={tab} value="file" onSelect={setTab}>
            Upload a file
          </TabButton>
          <TabButton current={tab} value="list" onSelect={setTab}>
            Paste a list
          </TabButton>
        </div>

        <div className="mt-4">
          {tab === "file" ? <CsvForm /> : <ListForm />}
        </div>

        <p className="mt-5 border-t border-neutral-200 pt-4 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
          No account, and nothing kept. What you upload is held on the server
          only while you are looking at it and is deleted after two days idle —
          or the moment you press Forget.
        </p>
      </section>

      <section className="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800">
        <h2 className="text-lg font-medium">Look up one card</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Every printing of every card, with five years of prices from
          TCGplayer and Card Kingdom. No upload needed.
        </p>
        <Link
          href="/search"
          className="mt-5 inline-block rounded-md border border-neutral-900 bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Search cards
        </Link>
      </section>
    </div>
  );
}

function TabButton({
  current,
  value,
  onSelect,
  children,
}: {
  current: Tab;
  value: Tab;
  onSelect: (tab: Tab) => void;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(value)}
      className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
        active
          ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
          : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      }`}
    >
      {children}
    </button>
  );
}

function CsvForm() {
  const [state, action, pending] = useActionState<UploadResult | null, FormData>(
    uploadCsvAction,
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-3">
      <input
        type="file"
        name="file"
        accept=".csv,text/csv"
        required
        className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-neutral-300 file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:font-medium dark:file:border-neutral-700"
      />
      <p className="text-xs text-neutral-600 dark:text-neutral-400">
        Moxfield → Collection → Export. The file keeps its acquisition dates,
        which is what lets the chart show what you held over time.
      </p>
      <Submit pending={pending}>
        {pending ? "Pricing your cards…" : "See what it is worth"}
      </Submit>
      <Problem state={state} />
    </form>
  );
}

function ListForm() {
  const [state, action, pending] = useActionState<UploadResult | null, FormData>(
    pasteListAction,
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-3">
      <textarea
        name="list"
        rows={6}
        spellCheck={false}
        placeholder={"1 Sol Ring (C18) 120\n4 Lightning Bolt\n2 Arcane Signet *F*"}
        className="w-full rounded-md border border-neutral-300 bg-transparent p-3 font-mono text-xs dark:border-neutral-700"
      />
      <div className="flex flex-col gap-1">
        <label
          htmlFor="deck-url"
          className="text-xs text-neutral-600 dark:text-neutral-400"
        >
          …or a link to one
        </label>
        <input
          id="deck-url"
          name="url"
          type="url"
          inputMode="url"
          placeholder="https://archidekt.com/decks/123456"
          className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
        />
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          Archidekt links, or a link to the raw text of a list. Moxfield blocks
          links being read by other sites, so paste those in the box above.
        </p>
      </div>
      <Submit pending={pending}>
        {pending ? "Pricing the list…" : "Price this list"}
      </Submit>
      <Problem state={state} />
    </form>
  );
}

function Submit({
  pending,
  children,
}: {
  pending: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="self-start rounded-md border border-neutral-900 bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-60 dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
    >
      {children}
    </button>
  );
}

function Problem({ state }: { state: UploadResult | null }) {
  if (!state) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
    >
      {state.message}
    </p>
  );
}
