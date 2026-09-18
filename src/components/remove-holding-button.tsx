"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { removeHoldingAction, type ActionResult } from "@/app/actions/holdings";

function Button({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-label={label}
      className="rounded px-2 py-1 text-xs text-neutral-600 dark:text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950"
    >
      {pending ? "..." : "Remove"}
    </button>
  );
}

export function RemoveHoldingButton({
  holdingId,
  label,
}: {
  holdingId: number;
  label: string;
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    removeHoldingAction,
    null,
  );

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="holdingId" value={holdingId} />
      <Button label={`Remove ${label}`} />
      {state && !state.ok ? (
        <span role="alert" className="ml-1 text-xs text-red-600">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
