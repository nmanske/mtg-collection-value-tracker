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
import { checkRateLimit, peekRateLimit, recordHit } from "@/lib/rate-limit";
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
 * Collections one address may have priced, and how often.
 *
 * An upload starts a worker that reads tens of millions of price rows and can
 * run for two minutes, so this is the one thing on the site a stranger can
 * make expensive on demand.
 *
 * Three per ten minutes rather than one, because the key is an address and an
 * address is not a person: everyone behind one NAT — an office, a household,
 * a mobile carrier — shares it. One would have had the second person in a
 * building told to come back later by the first.
 */
const UPLOAD_LIMIT = Number(process.env.UPLOAD_RATE_LIMIT) || 3;
const UPLOAD_WINDOW_MS =
  (Number(process.env.UPLOAD_RATE_WINDOW_MINUTES) || 10) * 60_000;

/**
 * Attempts allowed in the same window, whether or not they produce anything.
 *
 * The expensive limit is only charged for an upload that actually starts a
 * worker, so that a wrong file — the commonest reason anyone tries twice — does
 * not cost somebody ten minutes. That leaves parsing itself unguarded, which is
 * cheap but not free at 16 MB a go, so it gets its own generous ceiling.
 */
const ATTEMPT_LIMIT = UPLOAD_LIMIT * 10;

/** The address this request appears to come from. */
async function addressOf(): Promise<string> {
  const store = await headers();
  return clientAddress(store.get("x-forwarded-for"), store.get("x-real-ip"));
}

/**
 * Whether this request may proceed, checked before the file is read so that a
 * refusal costs a map lookup rather than a parse.
 */
async function overUploadLimit(address: string): Promise<UploadResult | null> {
  const attempts = checkRateLimit(`attempt:${address}`, {
    limit: ATTEMPT_LIMIT,
    windowMs: UPLOAD_WINDOW_MS,
  });
  if (!attempts.ok) return refusal(attempts.retryAfter);

  const uploads = peekRateLimit(`upload:${address}`, {
    limit: UPLOAD_LIMIT,
    windowMs: UPLOAD_WINDOW_MS,
  });
  return uploads.ok ? null : refusal(uploads.retryAfter);
}

/** Charged once the upload has actually started a worker. */
function recordUpload(address: string): void {
  recordHit(`upload:${address}`, {
    limit: UPLOAD_LIMIT,
    windowMs: UPLOAD_WINDOW_MS,
  });
}

function refusal(retryAfter: number): UploadResult {
  const minutes = Math.ceil(retryAfter / 60);
  return {
    ok: false,
    message:
      retryAfter > 90
        ? `One collection at a time, please. Try again in ${minutes} minutes.`
        : `One collection at a time, please. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`,
  };
}
/** A pasted list beyond this is a file, not a paste. */
const MAX_TEXT = 1024 * 1024;

export async function uploadCsvAction(
  _previous: UploadResult | null,
  formData: FormData,
): Promise<UploadResult> {
  const address = await addressOf();
  const limited = await overUploadLimit(address);
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
    // Charged here rather than at the door: only an upload that reached this
    // point has cost anything worth limiting.
    recordUpload(address);
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
  const address = await addressOf();
  const limited = await overUploadLimit(address);
  if (limited) return limited;

  const text = String(formData.get("list") ?? "");
  const url = String(formData.get("url") ?? "").trim();

  // One form, two fields, whichever was filled in. A paste box and a URL box
  // that submit separately would be two buttons for one intent.
  if (url) return importFromUrl(url, address);

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
    recordUpload(address);
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }

  await setSessionCookie(sessionId);
  redirect("/");
}

async function importFromUrl(
  url: string,
  address: string,
): Promise<UploadResult> {
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
    recordUpload(address);
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
