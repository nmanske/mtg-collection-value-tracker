import { and, eq, lt, sql } from "drizzle-orm";

import { OWNER, type CollectionScope } from "@/db/scope";
import {
  collectionSessions,
  holdings,
  portfolioDaily,
  portfolioMonthly,
  type CollectionSession,
  type SessionSource,
  type WarmState,
} from "@/db/schema";

import type { Db } from "./printings";

/**
 * Uploaded collections, which exist for as long as somebody is looking at one.
 *
 * There is no account here and nothing is kept. A visitor uploads a file, the
 * rows are written under an opaque id, that id goes in a cookie, and a sweep
 * removes the lot once nobody has touched it for a while. The design goal is
 * that walking away is indistinguishable from never having uploaded: no
 * record survives except in the price tables, which the upload never wrote to.
 */

/**
 * How long an untouched collection survives.
 *
 * Long enough to close a laptop lid over lunch and come back to the same page,
 * short enough that a public instance is not quietly accumulating other
 * people's collections. Every read touches `last_seen_at`, so this is idle
 * time rather than age.
 */
export const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS) || 48;

/** Sessions to keep at most, newest first, whatever their age. */
export const SESSION_LIMIT = Number(process.env.SESSION_LIMIT) || 200;

export interface SessionInput {
  id: string;
  label: string;
  source: SessionSource;
  matched: number;
  unmatched: number;
  /** Defaults to `ready`; the upload flow creates sessions `pending`. */
  warmState?: WarmState;
}

export function createSession(
  db: Db,
  input: SessionInput,
  now = new Date(),
): void {
  db.insert(collectionSessions)
    .values({ ...input, createdAt: now, lastSeenAt: now })
    .run();
}

/**
 * Records how the out-of-process pricing ended.
 *
 * The error text is stored rather than only logged, because the page that is
 * waiting has to say something, and "it failed, look in the container log" is
 * not something to say to a stranger.
 */
export function setWarmState(
  db: Db,
  id: string,
  state: WarmState,
  error: string | null = null,
): void {
  db.update(collectionSessions)
    .set({
      warmState: state,
      warmError: error,
      // A finished session reads as finished, whatever the last partial
      // update said.
      ...(state === "ready" ? { warmProgress: 100, warmStep: null } : {}),
    })
    .where(eq(collectionSessions.id, id))
    .run();
}

/**
 * Records how far the pricing has got, for the page waiting on it.
 *
 * Written by the worker and read by the web process, which is what the WAL is
 * for: the reader never blocks on these writes.
 */
export function setWarmProgress(
  db: Db,
  id: string,
  percent: number,
  step: string,
): void {
  db.update(collectionSessions)
    .set({ warmProgress: Math.max(0, Math.min(100, Math.round(percent))), warmStep: step })
    .where(eq(collectionSessions.id, id))
    .run();
}

export function getSession(db: Db, id: string): CollectionSession | null {
  if (id === OWNER) return null;
  return (
    db
      .select()
      .from(collectionSessions)
      .where(eq(collectionSessions.id, id))
      .get() ?? null
  );
}

/**
 * Marks a session as still in use.
 *
 * Cheap enough to do on every page read — one indexed update against a table
 * with at most `SESSION_LIMIT` rows — and doing it on every read is what makes
 * the TTL mean "idle" rather than "old". A tab left open on the dashboard for
 * a day should not have the collection deleted under it.
 */
export function touchSession(db: Db, id: string, now = new Date()): void {
  db.update(collectionSessions)
    .set({ lastSeenAt: now })
    .where(eq(collectionSessions.id, id))
    .run();
}

/**
 * Removes a session and everything computed from it.
 *
 * Explicit rather than by foreign-key cascade, because the cache tables carry
 * the scope as a plain column with no reference to hang a cascade on, and a
 * deletion that leaves a collection's daily totals behind would be a leak that
 * nothing ever notices.
 */
export function deleteSession(db: Db, id: string): void {
  if (id === OWNER) throw new Error("refusing to delete the owner collection");
  db.delete(holdings).where(eq(holdings.sessionId, id)).run();
  db.delete(portfolioDaily).where(eq(portfolioDaily.sessionId, id)).run();
  db.delete(portfolioMonthly).where(eq(portfolioMonthly.sessionId, id)).run();
  db.delete(collectionSessions).where(eq(collectionSessions.id, id)).run();
}

export interface SweepResult {
  expired: number;
  overflow: number;
  orphans: number;
}

/**
 * Deletes what nobody is looking at any more.
 *
 * Three passes, because there are three ways rows outlive their session. Idle
 * ones age out. A burst of uploads is capped by count, so a busy day cannot
 * fill the disk before the TTL comes round. And holdings whose session row is
 * already gone are swept regardless — that pairing is the one that turns a
 * crash halfway through an upload into rows nothing will ever delete.
 */
export function sweepSessions(db: Db, now = new Date()): SweepResult {
  const cutoff = new Date(now.getTime() - SESSION_TTL_HOURS * 3_600_000);

  const expired = db
    .select({ id: collectionSessions.id })
    .from(collectionSessions)
    .where(lt(collectionSessions.lastSeenAt, cutoff))
    .all()
    .map((row) => row.id);

  // Newest kept: an id beyond the limit is the least recently used.
  //
  // Ordered and sliced here rather than with LIMIT/OFFSET. Drizzle drops a
  // limit of -1 and emits a bare OFFSET, which SQLite will not parse, and this
  // table is capped at `SESSION_LIMIT` rows anyway — there is nothing to save.
  const overflow = db
    .select({ id: collectionSessions.id })
    .from(collectionSessions)
    .orderBy(sql`${collectionSessions.lastSeenAt} desc`)
    .all()
    .slice(SESSION_LIMIT)
    .map((row) => row.id);

  const doomed = new Set([...expired, ...overflow]);
  for (const id of doomed) deleteSession(db, id);

  // Rows under a session id that no longer has a session row. Their scope can
  // never be resolved again, so nothing can read them and nothing else will
  // remove them.
  const orphans = db
    .delete(holdings)
    .where(
      and(
        sql`${holdings.sessionId} <> ${OWNER}`,
        sql`${holdings.sessionId} not in (select id from ${collectionSessions})`,
      ),
    )
    .run().changes;

  return {
    expired: expired.length,
    overflow: overflow.filter((id) => !expired.includes(id)).length,
    orphans,
  };
}

/** Every live session, newest first. For the sweep's logging and for tests. */
export function listSessions(db: Db): CollectionSession[] {
  return db
    .select()
    .from(collectionSessions)
    .orderBy(sql`${collectionSessions.lastSeenAt} desc`)
    .all();
}

/** Whether this scope still points at something readable. */
export function scopeExists(db: Db, scope: CollectionScope): boolean {
  return scope === OWNER || getSession(db, scope) !== null;
}
