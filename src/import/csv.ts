/**
 * A small RFC 4180 CSV reader.
 *
 * Written rather than pulled in as a dependency because the whole grammar is
 * quoting rules, and Magic card names make those rules load-bearing:
 * "Jace, the Mind Sculptor" has a comma, "Ach! Hans, Run!" has both a comma
 * and quotes in some exports, and split cards use " // ". A naive `split(",")`
 * silently corrupts those rows rather than failing, which is the worst
 * outcome for an importer.
 */

export interface CsvParseError {
  line: number;
  message: string;
}

export interface CsvTable {
  header: string[];
  /** Rows as raw cells, in file order. Ragged rows are reported, not dropped. */
  rows: string[][];
  errors: CsvParseError[];
}

/**
 * Splits CSV text into rows of cells.
 *
 * Handles quoted fields containing commas, newlines and doubled quotes (`""`),
 * plus CRLF and a UTF-8 BOM — Moxfield exports arrive with both on Windows.
 */
export function parseCsv(text: string): string[][] {
  // A BOM would otherwise become part of the first header name, so "Count"
  // never matches.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let cellWasQuoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          // An escaped quote inside a quoted field.
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell === "") {
      inQuotes = true;
      cellWasQuoted = true;
      continue;
    }

    if (char === ",") {
      row.push(cell);
      cell = "";
      cellWasQuoted = false;
      continue;
    }

    if (char === "\r") {
      // Swallow CR; the following LF ends the row.
      continue;
    }

    if (char === "\n") {
      row.push(cell);
      cell = "";
      cellWasQuoted = false;
      rows.push(row);
      row = [];
      continue;
    }

    cell += char;
  }

  // A trailing cell with no newline after it still counts, but a file ending
  // in a newline must not produce a phantom empty row.
  if (cell !== "" || cellWasQuoted || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

/**
 * Parses CSV into a header plus rows, reporting rows whose width does not
 * match the header rather than silently mis-aligning their fields.
 */
export function parseCsvTable(text: string): CsvTable {
  const raw = parseCsv(text).filter(
    // Skip blank lines, which a spreadsheet round-trip tends to add.
    (row) => !(row.length === 1 && row[0].trim() === ""),
  );

  if (raw.length === 0) {
    return { header: [], rows: [], errors: [{ line: 1, message: "File is empty." }] };
  }

  const header = raw[0].map((name) => name.trim());
  const rows: string[][] = [];
  const errors: CsvParseError[] = [];

  for (let i = 1; i < raw.length; i += 1) {
    const row = raw[i];
    if (row.length !== header.length) {
      errors.push({
        line: i + 1,
        message: `Expected ${header.length} columns, found ${row.length}.`,
      });
      continue;
    }
    rows.push(row);
  }

  return { header, rows, errors };
}

/** Maps a header row to column indexes, case- and whitespace-insensitively. */
export function columnIndex(header: string[]): Map<string, number> {
  const index = new Map<string, number>();
  header.forEach((name, position) => {
    index.set(name.trim().toLowerCase(), position);
  });
  return index;
}
