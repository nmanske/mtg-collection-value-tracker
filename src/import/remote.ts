import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { DecklistEntry } from "./decklist";
import { parseDecklist } from "./decklist";

/**
 * Fetching a decklist from a URL a stranger typed.
 *
 * This is the one place in the app that makes an outbound request to an
 * address chosen by whoever is using it, which makes it the one place that can
 * be pointed at something it should not reach: the host's own loopback, a
 * neighbour on the LAN, a cloud metadata endpoint at 169.254.169.254. The
 * guards below exist for that, not for tidiness:
 *
 * - https only, so a plaintext hop cannot be redirected somewhere else.
 * - Every hostname is resolved and the resulting address checked against the
 *   private ranges before a connection is made.
 * - Redirects are followed by hand, at most three, and each hop is checked the
 *   same way. Letting fetch follow them would check the first address and
 *   connect to the last.
 * - The response is read with a byte counter and abandoned past the cap, so a
 *   URL that streams forever cannot take the process with it.
 *
 * None of this makes fetching arbitrary URLs safe in general. It makes this
 * one narrow use of it defensible.
 */

/** Hard stop on a response body. A big decklist is tens of kilobytes. */
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export class RemoteListError extends Error {}

export interface RemoteList {
  label: string;
  entries: DecklistEntry[];
}

/** Sites with an API worth using instead of scraping a page. */
const ARCHIDEKT_HOSTS = new Set(["archidekt.com", "www.archidekt.com"]);
const MOXFIELD_HOSTS = new Set(["moxfield.com", "www.moxfield.com"]);

export async function fetchRemoteList(rawUrl: string): Promise<RemoteList> {
  const url = parseUrl(rawUrl);

  if (MOXFIELD_HOSTS.has(url.hostname)) {
    // Not a guess: their API answers a server-side request with a Cloudflare
    // 403 whatever it is sent. Saying so beats a generic failure, because the
    // reader has the list in front of them and pasting it works.
    throw new RemoteListError(
      "Moxfield blocks requests from servers, so a link cannot be read. Open the deck, choose Export, and paste the list into the box above.",
    );
  }

  if (ARCHIDEKT_HOSTS.has(url.hostname)) return fetchArchidekt(url);

  // Anything else is treated as a link to a plain decklist: a raw gist, a
  // pastebin raw view, a text file on a site. Parsed exactly as a paste is.
  const { text } = await fetchText(url);
  const entries = parseDecklist(text);
  if (entries.length === 0) {
    throw new RemoteListError(
      "Nothing at that link looked like a decklist. A link to the raw text works; a link to a page that renders one usually does not.",
    );
  }
  return { label: labelFromUrl(url), entries };
}

/** Archidekt's deck API, which is public and returns Scryfall ids. */
async function fetchArchidekt(url: URL): Promise<RemoteList> {
  const id = /\/decks\/(\d+)/.exec(url.pathname)?.[1];
  if (!id) {
    throw new RemoteListError(
      "That does not look like an Archidekt deck link. They look like archidekt.com/decks/123456.",
    );
  }

  const api = new URL(`https://archidekt.com/api/decks/${id}/`);
  const { text } = await fetchText(api, "application/json");

  let payload: ArchidektDeck;
  try {
    payload = JSON.parse(text) as ArchidektDeck;
  } catch {
    throw new RemoteListError("Archidekt returned something unreadable.");
  }

  const entries: DecklistEntry[] = [];
  (payload.cards ?? []).forEach((row, index) => {
    const card = row.card;
    const name = card?.oracleCard?.name ?? card?.displayName;
    if (!name) return;

    entries.push({
      line: index + 1,
      quantity: Math.min(Math.max(Number(row.quantity) || 1, 1), 9_999),
      name,
      setCode: card?.edition?.editioncode?.toLowerCase() ?? null,
      collectorNumber: card?.collectorNumber ?? null,
      finish:
        row.modifier === "Foil"
          ? "foil"
          : row.modifier === "Etched"
            ? "etched"
            : "nonfoil",
      // The exact printing, which beats matching on set and number and beats
      // guessing from a name by a mile.
      scryfallId: card?.uid ?? null,
    });
  });

  if (entries.length === 0) {
    throw new RemoteListError("That Archidekt deck has no cards in it.");
  }

  return { label: payload.name?.trim() || `Archidekt deck ${id}`, entries };
}

interface ArchidektDeck {
  name?: string;
  cards?: {
    quantity?: number;
    modifier?: string;
    card?: {
      uid?: string;
      collectorNumber?: string;
      displayName?: string;
      edition?: { editioncode?: string };
      oracleCard?: { name?: string };
    };
  }[];
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new RemoteListError("That is not a URL.");
  }
  if (url.protocol !== "https:") {
    throw new RemoteListError("Only https links can be read.");
  }
  return url;
}

function labelFromUrl(url: URL): string {
  const last = url.pathname.split("/").filter(Boolean).pop();
  return last ? decodeURIComponent(last).slice(0, 80) : url.hostname;
}

/**
 * Fetches a URL after checking where it actually points, following redirects
 * by hand so every hop is checked too.
 */
async function fetchText(
  start: URL,
  expect = "text",
): Promise<{ text: string; url: URL }> {
  let url = start;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicAddress(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          // Named honestly. A server that would rather not be read by a robot
          // can say so, and several do.
          "user-agent": "mtg-collection-value-tracker (decklist import)",
          accept: expect === "application/json" ? "application/json" : "text/*",
        },
      });
    } catch {
      throw new RemoteListError("That link could not be reached.");
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new RemoteListError("That link redirects nowhere.");
      url = parseUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) {
      throw new RemoteListError(
        response.status === 404
          ? "There is nothing at that link."
          : `That link returned ${response.status}.`,
      );
    }

    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("text/") && !type.includes("json")) {
      throw new RemoteListError(
        "That link is not text. A decklist, or a link to the raw text of one, is what this reads.",
      );
    }

    return { text: await readCapped(response), url };
  }

  throw new RemoteListError("That link redirects too many times.");
}

/** Reads a body, giving up past the cap rather than buffering whatever comes. */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new RemoteListError("That file is too big to be a decklist.");
    }
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

/**
 * Refuses anything that resolves to an address the server should not be
 * reaching on a stranger's behalf.
 *
 * Every address the name resolves to is checked, not just the first: a name
 * with both a public and a private record would otherwise pass the check and
 * connect to either.
 */
async function assertPublicAddress(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");

  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true }).catch(() => {
        throw new RemoteListError("That host does not resolve.");
      });

  if (addresses.length === 0) {
    throw new RemoteListError("That host does not resolve.");
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new RemoteListError(
        "That address is on a private network, so it will not be fetched.",
      );
    }
  }
}

/** Loopback, link-local, private, carrier-grade NAT, and the IPv6 equivalents. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    return (
      a === 0 || // this network
      a === 10 || // private
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, and cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      (a === 192 && b === 0) || // protocol assignments
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224 // multicast and reserved
    );
  }

  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    // ::ffff:10.0.0.1 and friends: an IPv4 address wearing an IPv6 hat.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      lower.startsWith("fc") || // unique local
      lower.startsWith("fd") ||
      lower.startsWith("fe8") || // link-local
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    );
  }

  // Not an address at all. Refusing is the safe direction.
  return true;
}
