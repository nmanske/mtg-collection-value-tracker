import "server-only";

import { drizzle } from "drizzle-orm/better-sqlite3";

import { openDatabase } from "./client";

/**
 * Cached across hot reloads in development — Next.js re-evaluates modules on
 * every edit, which would otherwise leak a file handle per reload.
 */
const globalForDb = globalThis as unknown as {
  db?: ReturnType<typeof createDb>;
};

// Created without the `schema` option: this app uses only the query builder,
// never the relational `db.query.*` API, and leaving the schema off keeps the
// instance assignable to the plain `Db` type the query modules accept.
function createDb() {
  return drizzle(openDatabase());
}

export const db = globalForDb.db ?? createDb();

if (process.env.NODE_ENV !== "production") globalForDb.db = db;

export { DB_PATH, openDatabase } from "./client";
