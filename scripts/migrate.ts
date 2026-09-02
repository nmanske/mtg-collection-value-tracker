import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { DB_PATH, openDatabase } from "@/db/client";

const path = process.argv[2] ?? DB_PATH;

mkdirSync(dirname(path), { recursive: true });

const sqlite = openDatabase(path);
migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
sqlite.close();

console.log(`Migrations applied to ${path}`);
