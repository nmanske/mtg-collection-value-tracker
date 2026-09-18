"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { addHoldingAction, type ActionResult } from "@/app/actions/holdings";
import type { PrintingSearchResult } from "@/db/queries/printings";
import { CONDITIONS } from "@/db/schema";
import { FINISH_LABEL } from "@/lib/format";

function SubmitButton() {
  // useFormStatus reads the enclosing form's pending state, so the button can
  // disable itself without the parent tracking submission.
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? "Adding..." : "Add"}
    </button>
  );
}

export function AddHoldingForm({
  printing,
  today,
}: {
  printing: PrintingSearchResult;
  /** Computed on the server so the default date does not depend on the client clock. */
  today: string;
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    addHoldingAction,
    null,
  );

  const pricedFinishes = new Set(printing.prices.map((price) => price.finish));

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="printingKey" value={printing.id} />

      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-600 dark:text-neutral-400">Qty</span>
        <input
          type="number"
          name="quantity"
          defaultValue={1}
          min={1}
          max={10000}
          required
          className="w-16 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-600 dark:text-neutral-400">Finish</span>
        <select
          name="finish"
          defaultValue={printing.finishes[0]}
          className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          {/* Only the finishes this printing was actually made in. */}
          {printing.finishes.map((finish) => (
            <option key={finish} value={finish}>
              {FINISH_LABEL[finish]}
              {pricedFinishes.has(finish) ? "" : " (no price)"}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-600 dark:text-neutral-400">Condition</span>
        <select
          name="condition"
          defaultValue="NM"
          className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          {CONDITIONS.map((condition) => (
            <option key={condition} value={condition}>
              {condition}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-600 dark:text-neutral-400">Acquired</span>
        <input
          type="date"
          name="dateAdded"
          defaultValue={today}
          max={today}
          className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      <SubmitButton />

      {state ? (
        <p
          role="status"
          className={`w-full text-xs ${
            state.ok
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
          }`}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
