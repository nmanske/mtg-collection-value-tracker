import "server-only";

import { drizzle } from "drizzle-orm/better-sqlite3";

import { openDatabase } from "./client";
import * as schema from "./schema";

/**
 * Cached across hot reloads in development — Next.js re-evaluates modules on
 * every edit, which would otherwise leak a file handle per reload.
 */
const globalForDb = globalThis as unknown as {
  db?: ReturnType<typeof createDb>;
};

function createDb() {
  return drizzle(openDatabase(), { schema });
}

export const db = globalForDb.db ?? createDb();

if (process.env.NODE_ENV !== "production") globalForDb.db = db;

export { schema };
export { DB_PATH, openDatabase } from "./client";
