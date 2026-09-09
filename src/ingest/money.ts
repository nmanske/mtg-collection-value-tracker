/**
 * Converts a Scryfall price string ("0.35", "1234.50") to whole cents.
 *
 * Parsed by hand rather than via `parseFloat` so the conversion is exact —
 * `parseFloat("0.35") * 100` is 34.999999999999996, and rounding that happens
 * to work but only by luck. Returns null for absent or unparseable values so
 * callers can distinguish "no price" from "zero".
 */
export function priceStringToCents(value: string | null | undefined): number | null {
  if (value == null) return null;

  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;

  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return sign === "-" ? -cents : cents;
}

/** Formats whole cents as a plain USD amount, e.g. 123450 -> "1234.50". */
export function centsToPriceString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
