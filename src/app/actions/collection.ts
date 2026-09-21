"use server";

import { redirect } from "next/navigation";

import { db } from "@/db";
import { deleteSession } from "@/db/queries/sessions";
import { parseDecklist } from "@/import/decklist";
import { fetchRemoteList, RemoteListError } from "@/import/remote";
import {
  importCsvSession,
  importDecklistSession,
  ImportRejected,
  warmSession,
} from "@/import/session";
import {
  activeCollection,
  clearSessionCookie,
  setSessionCookie,
} from "@/lib/session";

/**
 * Taking a collection in, and letting go of it again.
 *
 * Actions rather than route handlers because these are form submissions that
 * end in a redirect, and because cookies can only be written from a Server
 * Function — which is the whole mechanism by which an upload becomes "your"
 * collection for the next couple of days.
 *
 * Every failure returns a message rather than throwing. A stranger pasting the
 * wrong thing into a box is the normal case here, not an exception, and the
 * message is the entire product at that moment.
 */

export interface UploadResult {
  ok: false;
  message: string;
}

/** A CSV this size is already an implausible collection. */
const MAX_BYTES = 16 * 1024 * 1024;
/** A pasted list beyond this is a file, not a paste. */
const MAX_TEXT = 1024 * 1024;

export async function uploadCsvAction(
  _previous: UploadResult | null,
  formData: FormData,
): Promise<UploadResult> {
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choose a CSV file first." };
  }
  if (file.size > MAX_BYTES) {
    return {
      ok: false,
      message: `That file is ${(file.size / 1e6).toFixed(1)} MB, which is larger than any real collection export.`,
    };
  }

  let sessionId: string;
  try {
    const result = importCsvSession(
      db,
      await file.text(),
      cleanLabel(file.name) || "Uploaded collection",
    );
    sessionId = result.sessionId;
    // Both views the dashboard draws, computed while the reader is still
    // looking at the upload form rather than at an empty chart.
    warmSession(db, sessionId);
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }

  await setSessionCookie(sessionId);
  redirect("/");
}

export async function pasteListAction(
  _previous: UploadResult | null,
  formData: FormData,
): Promise<UploadResult> {
  const text = String(formData.get("list") ?? "");
  const url = String(formData.get("url") ?? "").trim();

  // One form, two fields, whichever was filled in. A paste box and a URL box
  // that submit separately would be two buttons for one intent.
  if (url) return importFromUrl(url);

  if (!text.trim()) {
    return { ok: false, message: "Paste a list, or give a link to one." };
  }
  if (text.length > MAX_TEXT) {
    return { ok: false, message: "That list is too long to paste. Upload it as a file instead." };
  }

  let sessionId: string;
  try {
    const result = importDecklistSession(
      db,
      parseDecklist(text),
      "Pasted list",
      "decklist",
    );
    sessionId = result.sessionId;
    // A list has no acquisition dates, so only the fixed-basket view means
    // anything and only that one is worth computing.
    warmSession(db, sessionId, true);
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }

  await setSessionCookie(sessionId);
  redirect("/");
}

async function importFromUrl(url: string): Promise<UploadResult> {
  let sessionId: string;
  try {
    const remote = await fetchRemoteList(url);
    const result = importDecklistSession(
      db,
      remote.entries,
      remote.label,
      "url",
    );
    sessionId = result.sessionId;
    warmSession(db, sessionId, true);
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }

  await setSessionCookie(sessionId);
  redirect("/");
}

/**
 * Forgets the current collection, immediately and completely.
 *
 * The rows go now rather than waiting for the sweep: somebody who clicks this
 * is asking for their cards to stop being on this machine, and "in a day or
 * two" is not an answer to that.
 */
export async function clearCollectionAction(): Promise<void> {
  const { scope, session } = await activeCollection();
  if (session) deleteSession(db, scope);
  await clearSessionCookie();
  redirect("/");
}

/** A file name is a reasonable label; a path or an extension is not. */
function cleanLabel(name: string): string {
  return name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_-]+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * Our own errors carry text written for the reader. Anything else does not,
 * and is deliberately not shown: an unexpected failure's message is for the
 * log, where a stack trace is also waiting.
 */
function messageFor(error: unknown): string {
  if (error instanceof ImportRejected || error instanceof RemoteListError) {
    return error.message;
  }
  console.error("[collection] import failed", error);
  return "Something went wrong reading that. If it is a Moxfield export, the file should be the CSV their Collection page downloads.";
}
