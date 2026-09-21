/**
 * Tests uploaded collections: parsing a list, resolving it to printings,
 * writing it under a session, keeping it away from every other collection,
 * and getting rid of it again.
 *
 *   npm run test:sessions
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq, sql } from "drizzle-orm";

import { openDatabase } from "@/db/client";
import { collectionTotals, countHoldings, listHoldings } from "@/db/queries/holdings";
import { collectionStats } from "@/db/queries/stats";
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  SESSION_TTL_HOURS,
  setWarmState,
  sweepSessions,
  touchSession,
} from "@/db/queries/sessions";
import { collectionSql, OWNER } from "@/db/scope";
import {
  holdings,
  portfolioDaily,
  priceSnapshots,
  printings,
} from "@/db/schema";
import { parseDecklist, resolveDecklist } from "@/import/decklist";
import { isPrivateAddress } from "@/import/remote";
import { checkRateLimit, resetRateLimits } from "@/lib/rate-limit";
import { clientAddress, isSecureRequest } from "@/lib/request";
import {
  importCsvSession,
  importDecklistSession,
  ImportRejected,
} from "@/import/session";

const PATH = "./data/test-sessions.db";
const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${PATH}${suffix}`, { force: true });
  }
};
cleanup();
mkdirSync("./data", { recursive: true });

const sqlite = openDatabase(PATH);
const db = drizzle(sqlite);
migrate(db, { migrationsFolder: "./drizzle" });

// ------------------------------------------------------------- fixtures ---

const printing = (
  scryfallId: string,
  name: string,
  setCode: string,
  collectorNumber: string,
) =>
  db
    .insert(printings)
    .values({
      scryfallId,
      oracleId: `o-${name}`,
      name,
      setCode,
      setName: setCode.toUpperCase(),
      collectorNumber,
      finishes: ["nonfoil", "foil"],
      updatedAt: new Date(),
    })
    .returning({ id: printings.id })
    .all()[0].id;

// Two printings of one card at very different prices, which is what makes
// "which printing did they mean" a question worth answering deliberately.
const SOL_CHEAP = printing("s-1", "Sol Ring", "c18", "120");
const SOL_DEAR = printing("s-2", "Sol Ring", "lea", "270");
const BOLT = printing("b-1", "Lightning Bolt", "2x2", "117");

for (const [key, cents] of [
  [SOL_CHEAP, 150],
  [SOL_DEAR, 900_00],
  [BOLT, 400],
] as const) {
  db.insert(priceSnapshots)
    .values({
      printingKey: key,
      finish: "nonfoil",
      date: "2026-09-20",
      priceCents: cents,
      source: "mtgjson",
    })
    .run();
}

// The host's own collection, which every assertion below must leave alone.
db.insert(holdings)
  .values({
    printingKey: BOLT,
    quantity: 7,
    finish: "nonfoil",
    condition: "NM",
    dateAdded: "2026-01-01",
    source: "moxfield",
    createdAt: new Date(),
  })
  .run();

assert.equal(countHoldings(db, OWNER), 1, "the owner row defaults to OWNER scope");

// --------------------------------------------------------------- parsing ---

const parsed = parseDecklist(`// a list
Deck
1 Sol Ring (C18) 120
4x Lightning Bolt
2 Sol Ring *F*
SB: 1 Lightning Bolt

Sideboard
`);

assert.deepEqual(
  parsed.map((entry) => [entry.quantity, entry.name, entry.setCode, entry.finish]),
  [
    [1, "Sol Ring", "c18", "nonfoil"],
    [4, "Lightning Bolt", null, "nonfoil"],
    [2, "Sol Ring", null, "foil"],
    [1, "Lightning Bolt", null, "nonfoil"],
  ],
  "headers, comments, sideboard markers and blank lines are skipped",
);

// Quantity is optional, and a bare name is one card.
assert.equal(parseDecklist("Sol Ring")[0].quantity, 1);
// A line with no letters is not a card.
assert.deepEqual(parseDecklist("42\n---\n"), []);

// -------------------------------------------------------------- resolving ---

const resolved = resolveDecklist(db, [
  { line: 1, quantity: 1, name: "Sol Ring", setCode: "c18", collectorNumber: "120", finish: "nonfoil" },
  { line: 2, quantity: 1, name: "Sol Ring", setCode: null, collectorNumber: null, finish: "nonfoil" },
  { line: 3, quantity: 1, name: "Sol Ring", setCode: null, collectorNumber: null, finish: "nonfoil", scryfallId: "s-2" },
  { line: 4, quantity: 1, name: "Nonesuch", setCode: null, collectorNumber: null, finish: "nonfoil" },
]);

assert.equal(resolved.resolved[0].printingKey, SOL_CHEAP, "set and number win");
assert.equal(
  resolved.resolved[1].printingKey,
  SOL_CHEAP,
  "a bare name takes the cheapest printing, not the first or the dearest",
);
assert.equal(
  resolved.resolved[2].printingKey,
  SOL_DEAR,
  "a scryfall id beats both, even when it costs 600x more",
);
assert.equal(resolved.unmatched.length, 1);
assert.match(resolved.unmatched[0].reason, /No card named "Nonesuch"/);

// A finish the printing was never sold in falls back rather than valuing at
// nothing: this printing is nonfoil-only.
const nonfoilOnly = printing("n-1", "Plains", "unf", "1");
db.update(printings)
  .set({ finishes: ["nonfoil"] })
  .where(eq(printings.id, nonfoilOnly))
  .run();
const fallback = resolveDecklist(db, [
  { line: 1, quantity: 1, name: "Plains", setCode: "unf", collectorNumber: "1", finish: "foil" },
]);
assert.equal(fallback.resolved[0].resolvedFinish, "nonfoil");

// ------------------------------------------------------- importing a list ---

const deck = importDecklistSession(
  db,
  parseDecklist("1 Sol Ring (C18) 120\n4 Lightning Bolt"),
  "My deck",
  "decklist",
);

assert.equal(deck.matched, 2);
assert.equal(deck.datesKnown, false, "a list carries no acquisition dates");
assert.equal(countHoldings(db, deck.sessionId), 2);
assert.equal(countHoldings(db, OWNER), 1, "the owner collection is untouched");

// Inferred dates are flagged, not asserted as fact.
const deckRows = db
  .select()
  .from(holdings)
  .where(eq(holdings.sessionId, deck.sessionId))
  .all();
assert.ok(deckRows.every((row) => row.dateAddedApprox));

// ------------------------------------------------------------ isolation ---

// The dashboard's own queries, pointed at each collection in turn.
assert.equal(listHoldings(db, { scope: OWNER }).rows.length, 1);
assert.equal(listHoldings(db, { scope: deck.sessionId }).rows.length, 2);

const ownerTotals = collectionTotals(db, OWNER);
assert.equal(ownerTotals.totalCards, 7);
const deckTotals = collectionTotals(db, deck.sessionId);
assert.equal(deckTotals.totalCards, 5, "1 Sol Ring + 4 Bolt");

// 1 x $1.50 + 4 x $4.00
assert.equal(deckTotals.totalValueCents, 150 + 4 * 400);
// 7 x $4.00, and unchanged by anything the session did.
assert.equal(ownerTotals.totalValueCents, 7 * 400);

const deckStats = collectionStats(db, deck.sessionId);
assert.equal(deckStats.totalHoldings, 2);
assert.equal(collectionStats(db, OWNER).totalHoldings, 1);

// The raw-SQL scope fragment, which is the one place a scope reaches a query
// as text rather than as a bound parameter.
assert.equal(collectionSql("h", OWNER), "h.session_id = ''");
assert.throws(
  () => collectionSql("h", "' or 1=1 --"),
  /refusing to build SQL/,
  "a scope that is not an id must never reach SQL",
);

// -------------------------------------------------------- importing a CSV ---

const CSV = [
  "Count,Name,Edition,Condition,Language,Foil,Collector Number,Last Modified",
  '3,Lightning Bolt,2x2,Near Mint,English,,117,2025-04-01 12:00:00.000000',
  '1,Sol Ring,c18,Near Mint,English,foil,120,2025-06-15 12:00:00.000000',
].join("\n");

const upload = importCsvSession(db, CSV, "collection.csv");
assert.equal(upload.matched, 2);
assert.equal(upload.datesKnown, true, "a Moxfield export carries dates");
assert.equal(countHoldings(db, upload.sessionId), 2);
assert.equal(countHoldings(db, OWNER), 1, "still untouched");

// Dates came from the file rather than from today.
const uploadRows = db
  .select({ dateAdded: holdings.dateAdded })
  .from(holdings)
  .where(eq(holdings.sessionId, upload.sessionId))
  .all()
  .map((row) => row.dateAdded)
  .sort();
assert.deepEqual(uploadRows, ["2025-04-01", "2025-06-15"]);

// The parser's message names the column that was missing, which is the single
// most useful sentence anyone can be handed here. It has to arrive as an
// ImportRejected or the page shows a generic apology instead of that sentence.
const badColumns = () =>
  importCsvSession(db, "Count,Name,Edition\n1,Nonesuch,zzz", "junk.csv");
assert.throws(badColumns, ImportRejected);
assert.throws(badColumns, /missing column "collector number"/);

// Right shape, but nothing in it resolves to a card: refused rather than
// producing an empty collection that looks like a working one.
assert.throws(
  () =>
    importCsvSession(
      db,
      "Count,Name,Edition,Condition,Language,Foil,Collector Number,Last Modified\n1,Nonesuch,zzz,Near Mint,English,,999,2025-01-01 00:00:00.000000",
      "junk.csv",
    ),
  /could be matched/i,
);

// ---------------------------------------------------------------- delete ---

// A cached view, to prove deletion takes derived rows with it.
db.insert(portfolioDaily)
  .values({
    priceSource: 0,
    basket: false,
    date: "2026-09-20",
    valueCents: 1,
    holdingsHeld: 1,
    pricedHoldings: 1,
    unpricedHoldings: 0,
    inferredHoldings: 0,
    acquiredHoldings: 0,
    acquiredCards: 0,
    sessionId: upload.sessionId,
  })
  .run();

deleteSession(db, upload.sessionId);
assert.equal(countHoldings(db, upload.sessionId), 0);
assert.equal(getSession(db, upload.sessionId), null);
assert.equal(
  db
    .select({ n: sql<number>`count(*)` })
    .from(portfolioDaily)
    .where(eq(portfolioDaily.sessionId, upload.sessionId))
    .get()?.n,
  0,
  "cached views go with the collection they describe",
);
assert.throws(() => deleteSession(db, OWNER), /refusing/);

// ----------------------------------------------------------------- sweep ---

const now = new Date("2026-09-21T12:00:00Z");
const hoursAgo = (hours: number) =>
  new Date(now.getTime() - hours * 3_600_000);

const idle = "idle-session";
createSession(
  db,
  { id: idle, label: "old", source: "csv", matched: 1, unmatched: 0 },
  hoursAgo(SESSION_TTL_HOURS + 1),
);
db.insert(holdings)
  .values({
    printingKey: BOLT,
    quantity: 1,
    finish: "nonfoil",
    condition: "NM",
    dateAdded: "2026-01-01",
    source: "manual",
    sessionId: idle,
    createdAt: now,
  })
  .run();

// Rows whose session row is already gone: a crash halfway through an upload.
db.insert(holdings)
  .values({
    printingKey: BOLT,
    quantity: 1,
    finish: "nonfoil",
    condition: "NM",
    dateAdded: "2026-01-01",
    source: "manual",
    sessionId: "never-existed",
    createdAt: now,
  })
  .run();

const swept = sweepSessions(db, now);
assert.equal(swept.expired, 1);
assert.equal(swept.orphans, 1);
assert.equal(countHoldings(db, idle), 0);
assert.equal(countHoldings(db, "never-existed"), 0);
assert.equal(countHoldings(db, OWNER), 1, "the sweep never touches the owner");
assert.equal(
  countHoldings(db, deck.sessionId),
  2,
  "a session in use survives the sweep",
);

// Touching a session is what makes the TTL mean idle rather than old.
touchSession(db, deck.sessionId, now);
assert.equal(sweepSessions(db, now).expired, 0);
assert.equal(listSessions(db).length, 1);

// ------------------------------------------------------- warm state ---

// An upload is not ready the moment its rows land: a child process prices it.
// The page has to be able to tell "still working" from "died", which derived
// state cannot do -- no cached rows looks identical either way.
const warming = importDecklistSession(
  db,
  parseDecklist("1 Sol Ring (C18) 120"),
  "Warming",
  "decklist",
);
assert.equal(
  getSession(db, warming.sessionId)?.warmState,
  "pending",
  "an upload starts pending, not ready",
);

setWarmState(db, warming.sessionId, "failed", "out of memory");
const failed = getSession(db, warming.sessionId)!;
assert.equal(failed.warmState, "failed");
assert.equal(failed.warmError, "out of memory", "the reason survives, for the page to show");

setWarmState(db, warming.sessionId, "ready");
assert.equal(getSession(db, warming.sessionId)?.warmError, null, "a retry clears the old reason");

// Sessions made by anything else -- a fixture, a test -- are simply usable.
createSession(db, { id: "plain", label: "p", source: "csv", matched: 1, unmatched: 0 });
assert.equal(getSession(db, "plain")?.warmState, "ready");
deleteSession(db, "plain");
deleteSession(db, warming.sessionId);

// ------------------------------------------------------- rate limiting ---

resetRateLimits();
const LIMIT = { limit: 3, windowMs: 60_000 };
const t0 = 1_000_000;

for (let i = 0; i < 3; i += 1) {
  assert.equal(checkRateLimit("a", LIMIT, t0).ok, true, `attempt ${i + 1} allowed`);
}
const refused = checkRateLimit("a", LIMIT, t0);
assert.equal(refused.ok, false, "the fourth is refused");
assert.equal(refused.retryAfter, 60, "and says how long to wait");

// One address's limit is not another's.
assert.equal(checkRateLimit("b", LIMIT, t0).ok, true);

// The window expires.
assert.equal(checkRateLimit("a", LIMIT, t0 + 60_001).ok, true);
// And the countdown shrinks as the window runs down.
checkRateLimit("c", LIMIT, t0);
checkRateLimit("c", LIMIT, t0);
checkRateLimit("c", LIMIT, t0);
assert.equal(checkRateLimit("c", LIMIT, t0 + 30_000).retryAfter, 30);

// The key comes from the proxy's account of who called. First entry is the
// client; the rest are proxies. Forgeable, which is why it is a rate-limit
// key and never an identity.
assert.equal(clientAddress("203.0.113.7, 10.0.0.1"), "203.0.113.7");
assert.equal(clientAddress(null, "198.51.100.4"), "198.51.100.4");
assert.equal(clientAddress(null, null), "unknown", "no proxy means everyone shares a bucket");
assert.equal(clientAddress("  203.0.113.7  "), "203.0.113.7");

// ------------------------------------------------- the session cookie ---

// A `Secure` cookie over plain HTTP is discarded by the browser, and the
// failure is quiet: the upload appears to work, because the render that
// follows it still sees the cookie it just set, and then the next navigation
// has no session and lands back on the front page.
assert.equal(isSecureRequest("https"), true);
assert.equal(isSecureRequest("http"), false);
assert.equal(isSecureRequest(null), false, "no proxy said HTTPS, so assume not");
// Several proxies deep, the client's own hop comes first.
assert.equal(isSecureRequest("https, http"), true);
assert.equal(isSecureRequest("http, https"), false, "the client hop decides");
assert.equal(isSecureRequest(" HTTPS "), true);
assert.equal(isSecureRequest(""), false);

// --------------------------------------------------------- SSRF guard ---

for (const address of [
  "127.0.0.1",
  "10.1.2.3",
  "172.16.0.1",
  "192.168.1.1",
  "169.254.169.254", // the cloud metadata address
  "100.64.0.1",
  "0.0.0.0",
  "::1",
  "fd00::1",
  "fe80::1",
  "::ffff:127.0.0.1", // an IPv4 loopback wearing an IPv6 hat
  "not-an-address",
]) {
  assert.equal(isPrivateAddress(address), true, `${address} must be refused`);
}

for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) {
  assert.equal(isPrivateAddress(address), false, `${address} must be allowed`);
}

sqlite.close();
cleanup();

console.log("Session tests passed.");
