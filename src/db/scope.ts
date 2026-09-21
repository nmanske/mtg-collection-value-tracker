import { eq } from "drizzle-orm";

import { holdings, OWNER_SCOPE } from "@/db/schema";

/**
 * Which collection a query is about.
 *
 * Every read of `holdings` is scoped to exactly one of these. There is no
 * "all collections" read anywhere and deliberately no way to spell one: an
 * uploaded file belongs to the browser that uploaded it, and the cheapest way
 * to guarantee that is for the query layer to be unable to express otherwise.
 *
 * `OWNER` is the host's own collection — the one a self-hosted instance
 * imports and the daily job prices. On a public deployment nothing writes to
 * it, so it is simply empty and the app shows the upload prompt instead.
 */
export type CollectionScope = string;

export const OWNER: CollectionScope = OWNER_SCOPE;

/** The predicate every holdings read carries. */
export function collectionWhere(scope: CollectionScope) {
  return eq(holdings.sessionId, scope);
}

/**
 * The same predicate as a SQL fragment, for the hand-written queries.
 *
 * A few queries are raw strings handed to better-sqlite3 because they were
 * measured against a 216-million-row price table and needed a shape the query
 * builder would not produce. A string is returned rather than a Drizzle `sql`
 * object precisely because those are plain template literals: an object
 * interpolated into one becomes "[object Object]" and the query either throws
 * or, worse, does not.
 */
export function collectionSql(alias: string, scope: CollectionScope): string {
  return `${alias}.session_id = '${escapeScope(scope)}'`;
}

/** The scope as a bare SQL literal, for tables whose column needs no alias. */
export function scopeLiteral(scope: CollectionScope): string {
  return escapeScope(scope);
}

/**
 * Session ids are generated from `randomUUID`, so they are hex and hyphens
 * and this can never fire. It exists because the alternative is trusting that
 * forever, and a scope string reaching raw SQL unescaped would be the one bug
 * in this file that matters.
 */
function escapeScope(scope: CollectionScope): string {
  if (!/^[A-Za-z0-9-]*$/.test(scope)) {
    throw new Error(`refusing to build SQL for scope ${JSON.stringify(scope)}`);
  }
  return scope;
}
