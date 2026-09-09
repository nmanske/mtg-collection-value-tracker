/**
 * CSV serialisation for exports.
 *
 * RFC 4180: fields containing a comma, quote or newline are quoted, and quotes
 * inside them are doubled. Rows end CRLF, which is what the spec says and what
 * Excel expects.
 */

/**
 * Characters that make a spreadsheet treat a cell as a formula rather than
 * text. A card named "-1/-1" or a note beginning "=" would otherwise be
 * evaluated on open, which is both wrong and a known injection vector for
 * files that get passed around.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  let text = String(value);

  // Neutralised with a leading apostrophe, the conventional spreadsheet escape:
  // the cell reads as text and the apostrophe is not part of the value.
  if (FORMULA_LEAD.test(text)) text = `'${text}`;

  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function csvRow(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}

/**
 * A byte-order mark.
 *
 * Without it Excel reads a UTF-8 CSV as the local ANSI codepage, which mangles
 * every accented card name and every ★ in a collector number.
 */
export const UTF8_BOM = "﻿";

/** Whole cents as a plain decimal, e.g. 123450 -> "1234.50". Blank for null. */
export function moneyCell(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** `collection-2026-09-09.csv` */
export function exportFilename(name: string, date = new Date()): string {
  return `${name}-${date.toISOString().slice(0, 10)}.csv`;
}
