"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { deleteSession } from "@/db/queries/sessions";
import { parseDecklist } from "@/import/decklist";
import { fetchRemoteList, RemoteListError } from "@/import/remote";
import {
  importCsvSession,
  importDecklistSession,
  ImportRejected,
} from "@/import/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { clientAddress } from "@/lib/request";
import { requestSessionWarm } from "@/lib/session-warm";
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

/**
 * Uploads allowed per address per minute.
 *
 * Every upload starts a worker that reads tens of millions of price rows, so
 * this is the one thing on the site a stranger can make expensive on demand.
 * Five a minute is far more than anyone uploading their own collection needs
 * and far less than a loop wants.
 */
const UPLOAD_LIMIT = Number(process.env.UPLOAD_RATE_LIMIT) || 5;
const UPLOAD_WINDOW_MS = 60_000;

/**
 * Counts this attempt, and returns a refusal to show if it is over the limit.
 *
 * Checked before the file is read, so a rejected request costs a map lookup
 * rather than 16 MB of parsing.
 */
async function overUploadLimit(): Promise<UploadResult | null> {
  const store = await headers();
  const address = clientAddress(
    store.get("x-forwarded-for"),
    store.get("x-real-ip"),
  );

  const { ok, retryAfter } = checkRateLimit(`upload:${address}`, {
    limit: UPLOAD_LIMIT,
    windowMs: UPLOAD_WINDOW_MS,
  });
  if (ok) return null;

  return {
    ok: false,
    message: `That is a lot of uploads at once. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`,
  };
}
/** A pasted list beyond this is a file, not a paste. */
const MAX_TEXT = 1024 * 1024;

export async function uploadCsvAction(
  _previous: UploadResult | null,
  formData: FormData,
): Promise<UploadResult> {
  const limited = await overUploadLimit();
  if (limited) return limited;

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
    // Handed to a child process. Pricing a collection is seconds of
    // synchronous work, and doing it here would stop the server answering
    // anybody at all for the duration.
    requestSessionWarm(sessionId);
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
  const limited = await overUploadLimit();
  if (limited) return limited;

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
    requestSessionWarm(sessionId);
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
    requestSessionWarm(sessionId);
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
