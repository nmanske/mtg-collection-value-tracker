import "server-only";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";

import { db } from "@/db";
import { countHoldings } from "@/db/queries/holdings";
import {
  getSession,
  SESSION_TTL_HOURS,
  touchSession,
} from "@/db/queries/sessions";
import { OWNER, type CollectionScope } from "@/db/scope";
import { publicMode } from "@/lib/privacy";
import type { CollectionSession } from "@/db/schema";

/**
 * Which collection the current request is looking at.
 *
 * The cookie holds an opaque id and nothing else — no name, no counts, nothing
 * that describes the collection — so it is useless to anyone who reads it
 * without the database beside it, and the database forgets on a timer.
 *
 * Cookies can only be *written* from a Server Function or Route Handler, never
 * during a page render, which is why uploading is an action and reading is
 * not. Reading here is deliberately forgiving: an id that no longer resolves
 * (swept, or a database rebuilt underneath it) falls back to the host's own
 * collection rather than erroring, so a stale cookie shows the landing page
 * instead of a broken one.
 */

export const SESSION_COOKIE = "mtg.collection";

/** Matches the sweep, so the browser forgets at roughly the same time we do. */
const COOKIE_MAX_AGE = SESSION_TTL_HOURS * 3_600;

export interface ActiveCollection {
  scope: CollectionScope;
  /** Null when looking at the host's own collection. */
  session: CollectionSession | null;
  /** False when there is nothing to show: no upload, and no host collection. */
  present: boolean;
}

/**
 * Resolves the request's collection, and marks it as still in use.
 *
 * `present` is what decides between the dashboard and the landing page. A
 * self-hosted instance has an owner collection and so always has one; a public
 * one has an empty owner collection, so a visitor who has not uploaded
 * anything gets the landing page instead of a page of zeroes.
 */
export async function activeCollection(): Promise<ActiveCollection> {
  const id = (await cookies()).get(SESSION_COOKIE)?.value;

  if (id && id !== OWNER) {
    const session = getSession(db, id);
    if (session) {
      touchSession(db, id);
      return { scope: id, session, present: true };
    }
  }

  // On a public instance the host's collection is not merely hidden, it is
  // never resolved: `present` is false whatever the table holds, so no page
  // has a scope through which it could appear.
  return {
    scope: OWNER,
    session: null,
    present: !publicMode() && countHoldings(db, OWNER) > 0,
  };
}

/** The scope alone, for the many places that do not need the rest. */
export async function currentScope(): Promise<CollectionScope> {
  return (await activeCollection()).scope;
}

/** A fresh, opaque id. Never derived from the upload or from the visitor. */
export function newSessionId(): string {
  return randomUUID();
}

/**
 * Attaches a session to this browser. Server Functions and Route Handlers only.
 *
 * `httpOnly` because nothing on the page has any use for the value, and
 * `sameSite: lax` so that following a link into the site keeps the collection
 * while a cross-site POST cannot act as the visitor.
 */
export async function setSessionCookie(id: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
    // Set only where it can be honoured: a `secure` cookie is dropped
    // wholesale over plain HTTP, which is how a self-hosted instance on a LAN
    // is reached, and dropping it would log the visitor out on every request.
    secure: process.env.NODE_ENV === "production" && !allowInsecureCookie(),
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/**
 * Whether to keep the cookie usable over plain HTTP in production.
 *
 * True for the self-hosted case — a Beelink on a LAN reached at
 * `http://host:3010` has no certificate and never will. A public deployment
 * behind TLS leaves this unset and gets the stricter cookie.
 */
function allowInsecureCookie(): boolean {
  return process.env.ALLOW_INSECURE_COOKIE === "true";
}
