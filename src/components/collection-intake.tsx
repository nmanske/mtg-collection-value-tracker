"use client";

import { useActionState, useState } from "react";
import Link from "next/link";

import {
  pasteListAction,
  uploadCsvAction,
  type UploadResult,
} from "@/app/actions/collection";
import { MAX_SESSION_ROWS } from "@/lib/limits";

/**
 * The front door.
 *
 * Two ways in, side by side, because there are two reasons to be here and
 * neither is more legitimate than the other: you have a collection and want to
 * know what it is worth, or you have one card in mind. Hiding the card search
 * behind an upload prompt would make the second reason feel like a detour
 * through the first.
 *
 * The copy is as short as it can be while still answering the two questions a
 * stranger has: what happens to my file, and what am I allowed to upload.
 */

type Tab = "file" | "list";

/** Rows, not cards — a row carries a quantity. See `MAX_SESSION_ROWS`. */
const LIMIT = MAX_SESSION_ROWS.toLocaleString();

export function CollectionIntake() {
  const [tab, setTab] = useState<Tab>("file");

  return (
    <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
      <section className="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800">
        <h2 className="text-lg font-medium">Value a collection</h2>

        <div
          role="tablist"
          aria-label="How to add a collection"
          className="mt-4 flex gap-1"
        >
          <TabButton current={tab} value="file" onSelect={setTab}>
            Upload a file
          </TabButton>
          <TabButton current={tab} value="list" onSelect={setTab}>
            Paste a list
          </TabButton>
        </div>

        <div className="mt-4">{tab === "file" ? <CsvForm /> : <ListForm />}</div>

        <p className="mt-5 border-t border-neutral-200 pt-4 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
          No account. Your file is kept only while you are looking at it, then
          deleted — after two days idle, or the moment you press Forget.
        </p>
      </section>

      <section className="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800">
        <h2 className="text-lg font-medium">Look up one card</h2>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Every printing, with five years of prices. No upload needed.
        </p>
        <Link
          href="/search"
          className="mt-4 inline-block rounded-md border border-neutral-900 bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
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
      <Hint>
        Moxfield → Collection → Export. Up to {LIMIT} rows.
      </Hint>
      <Submit pending={pending}>
        {pending ? "Reading your cards…" : "See what it is worth"}
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
      <input
        name="url"
        type="url"
        inputMode="url"
        aria-label="Link to a decklist"
        placeholder="…or an Archidekt link"
        className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
      />
      <Hint>
        Up to {LIMIT} lines. Moxfield blocks links, so paste those.
      </Hint>
      <Submit pending={pending}>
        {pending ? "Reading the list…" : "Price this list"}
      </Submit>
      <Problem state={state} />
    </form>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs text-neutral-600 dark:text-neutral-400">{children}</p>
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
