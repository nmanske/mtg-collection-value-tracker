import {
  CONDITIONS,
  type Condition,
  FINISHES,
  type Finish,
} from "@/db/schema";

/**
 * Parsing and validation for the add-holding form, kept separate from the
 * Server Action so it can be tested without a Next.js request context.
 *
 * Server Actions are reachable by direct POST, not only through the rendered
 * form, so none of these fields can be trusted to be well-formed.
 */

export interface ParsedHolding {
  printingKey: number;
  quantity: number;
  finish: Finish;
  condition: Condition;
  dateAdded: string;
}

export type ParseResult =
  | { ok: true; value: ParsedHolding }
  | { ok: false; message: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_QUANTITY = 10_000;

/** Fields the parser needs from the target printing, to check consistency. */
export interface PrintingConstraint {
  name: string;
  setCode: string;
  finishes: Finish[];
}

export function parseHoldingInput(
  fields: {
    printingKey: unknown;
    quantity: unknown;
    finish: unknown;
    condition: unknown;
    dateAdded: unknown;
  },
  printing: PrintingConstraint | null,
  today: string,
): ParseResult {
  const printingKey = Number(fields.printingKey);
  if (!Number.isInteger(printingKey) || printingKey <= 0) {
    return { ok: false, message: "Invalid card." };
  }
  if (!printing) {
    return { ok: false, message: "That printing is not in the database." };
  }

  const finish = String(fields.finish ?? "") as Finish;
  if (!FINISHES.includes(finish)) {
    return { ok: false, message: "Invalid finish." };
  }
  // Scryfall records which finishes a printing was actually made in. A foil
  // holding of a non-foil-only card could never be priced, so reject it here
  // rather than let it sit in the collection as permanently unpriced.
  if (!printing.finishes.includes(finish)) {
    return {
      ok: false,
      message: `${printing.name} (${printing.setCode.toUpperCase()}) was not printed in ${finish}.`,
    };
  }

  const condition = String(fields.condition ?? "") as Condition;
  if (!CONDITIONS.includes(condition)) {
    return { ok: false, message: "Invalid condition." };
  }

  const quantity = Number(fields.quantity);
  if (
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_QUANTITY
  ) {
    return {
      ok: false,
      message: `Quantity must be between 1 and ${MAX_QUANTITY.toLocaleString()}.`,
    };
  }

  const raw = String(fields.dateAdded ?? "").trim();
  const dateAdded = raw === "" ? today : raw;
  if (!ISO_DATE.test(dateAdded) || Number.isNaN(Date.parse(dateAdded))) {
    return { ok: false, message: "Acquisition date must be YYYY-MM-DD." };
  }
  // A future acquisition date would leave the holding contributing nothing to
  // the value chart until that day arrived, which reads as a bug.
  if (dateAdded > today) {
    return { ok: false, message: "Acquisition date cannot be in the future." };
  }

  return {
    ok: true,
    value: { printingKey, quantity, finish, condition, dateAdded },
  };
}

/** Today in UTC as `YYYY-MM-DD`, matching how snapshot dates are stored. */
export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
