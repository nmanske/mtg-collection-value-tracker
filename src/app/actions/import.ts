"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { importMoxfieldCsv, type ImportReport } from "@/import/moxfield";

export interface ImportActionResult {
  ok: boolean;
  message: string;
  report: ImportReport | null;
}

/** Refuses anything implausibly large before reading it into memory as text. */
const MAX_BYTES = 16 * 1024 * 1024;

export async function importMoxfieldAction(
  _previous: ImportActionResult | null,
  formData: FormData,
): Promise<ImportActionResult> {
  const file = formData.get("file");
  const dryRun = formData.get("dryRun") === "on";

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choose a CSV file to import.", report: null };
  }

  if (file.size > MAX_BYTES) {
    return {
      ok: false,
      message: `That file is ${(file.size / 1e6).toFixed(1)} MB. Use the CLI importer for files this large: npm run import:moxfield -- <file.csv>`,
      report: null,
    };
  }

  let report: ImportReport;
  try {
    report = importMoxfieldCsv(db, await file.text(), { dryRun });
  } catch (error) {
    // A wrong file is the likely case here, and its message names the columns
    // that were missing, so it is worth surfacing verbatim.
    return { ok: false, message: (error as Error).message, report: null };
  }

  if (!dryRun) revalidatePath("/");

  return {
    ok: true,
    message: dryRun
      ? `Previewed ${report.dataRows.toLocaleString()} rows. Nothing was written.`
      : `Imported ${report.importedCards.toLocaleString()} cards across ${report.importedRows.toLocaleString()} rows.`,
    report,
  };
}
