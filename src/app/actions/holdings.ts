"use server";

import { revalidatePath } from "next/cache";

import { requestCacheRebuild } from "@/lib/cache-refresh";

import { db } from "@/db";
import { addHolding } from "@/db/queries/holdings";
import { getPrinting } from "@/db/queries/printings";
import { parseHoldingInput, todayIso } from "@/lib/holding-input";

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Adds a holding from the search page's form.
 *
 * Field validation lives in `parseHoldingInput` so it can be tested without a
 * request context. This app is single-user with no auth (see README), so there
 * is no ownership check to make here — but a Server Action is still reachable
 * by direct POST, so nothing from the form is trusted.
 */
export async function addHoldingAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const printingKeyRaw = formData.get("printingKey");
  const printingKey = Number(printingKeyRaw);
  const printing = Number.isInteger(printingKey)
    ? getPrinting(db, printingKey)
    : null;

  const parsed = parseHoldingInput(
    {
      printingKey: printingKeyRaw,
      quantity: formData.get("quantity"),
      finish: formData.get("finish"),
      condition: formData.get("condition"),
      dateAdded: formData.get("dateAdded"),
    },
    printing,
    todayIso(),
  );

  if (!parsed.ok) return { ok: false, message: parsed.message };

  const { merged } = addHolding(db, { ...parsed.value, createdAt: new Date() });

  // Changing the holdings invalidates the value history. Asked for here rather
  // than left to whoever loads a page next, and out of process so adding a card
  // stays instant.
  requestCacheRebuild();
  revalidatePath("/");
  revalidatePath("/search");

  const label = `${printing!.name} (${printing!.setCode.toUpperCase()} ${printing!.collectorNumber})`;
  return {
    ok: true,
    message: merged
      ? `Added ${parsed.value.quantity} to your existing ${label} — same finish, condition and date.`
      : `Added ${parsed.value.quantity} x ${label}.`,
  };
}
