/**
 * Drives the running app over HTTP and asserts each page actually renders.
 *
 *   npm run smoke:http            # against http://localhost:3000
 *
 * `.mts` because it uses top-level await, which the CommonJS `.ts` scripts in
 * this directory cannot.
 *   npm run smoke:http -- 3005    # or another port
 *
 * This exists because the two worst bugs of the project so far were both
 * invisible to `tsc` and to every unit test, and were found by a person
 * happening to load a page:
 *
 * - the scheduler imported a module Turbopack cannot resolve, so the
 *   instrumentation hook threw and the server would not start at all;
 * - a chart wrapper put its height on the wrong element, so the plot measured
 *   zero pixels and rendered blank, with nothing in the console.
 *
 * Neither is a logic error, so no amount of query-level testing would have
 * caught them. What they have in common is that the page still *responds* --
 * which is why asserting a 200 is not enough, and every check below also
 * requires a marker that only appears if the page truly rendered its content.
 */
import assert from "node:assert/strict";

const port = process.argv[2] ?? process.env.PORT ?? "3000";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 30_000);
const base = `http://localhost:${port}`;

interface Check {
  path: string;
  /** Substrings that only appear when the page rendered its real content. */
  expect: string[];
  /** Optional: a substring that must be absent, for known failure shapes. */
  reject?: string[];
}

const checks: Check[] = [
  {
    path: "/",
    // The hero figure, the chart's own container, and the collection table.
    expect: ["Collection value", "recharts", "Sort"],
    // A blank chart still returns 200; an empty plot area does not.
    reject: ["Application error"],
  },
  { path: "/?prices=cardkingdom", expect: ["Card Kingdom", "recharts"] },
  { path: "/?sort=value&filter=foil", expect: ["Sort", "Show"] },
  { path: "/stats", expect: ["recharts", "Most valuable"] },
  { path: "/search?q=sliver", expect: ["printing"] },
  { path: "/export", expect: ["Collection", "Value history"] },
  { path: "/import", expect: ["Moxfield"] },
];

let failures = 0;

async function check({ path, expect, reject }: Check) {
  const url = `${base}${path}`;
  // A bounded wait, so a hung page is reported as slow rather than hanging the
  // whole run. Generous, because a cold cache legitimately recomputes the
  // series, and that is slow rather than broken.
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const reason =
      (error as Error).name === "TimeoutError"
        ? `no response in ${TIMEOUT_MS / 1000}s`
        : (error as Error).message;
    console.log(`  FAIL ${path} — ${reason}`);
    failures += 1;
    return;
  }

  const body = await response.text();
  const problems: string[] = [];

  if (response.status !== 200) problems.push(`status ${response.status}`);
  for (const needle of expect) {
    if (!body.includes(needle)) problems.push(`missing "${needle}"`);
  }
  for (const needle of reject ?? []) {
    if (body.includes(needle)) problems.push(`contains "${needle}"`);
  }

  if (problems.length > 0) {
    console.log(`  FAIL ${path} — ${problems.join(", ")}`);
    failures += 1;
  } else {
    console.log(
      `  ok   ${path} (${(body.length / 1024).toFixed(0)} KB, ${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );
  }
}

console.log(`Smoke-testing ${base}`);

// Fail fast and clearly when nothing is listening, rather than reporting seven
// identical connection errors.
try {
  await fetch(base);
} catch {
  console.error(
    `Nothing is serving ${base}. Start the app first (npm run dev), or pass the port.`,
  );
  process.exit(1);
}

for (const item of checks) await check(item);

// A card page needs a real id, so it is looked up from the running app rather
// than hardcoded — a fixed id would rot the moment the database is rebuilt.
const search = await (await fetch(`${base}/search?q=sliver`)).text();
const cardId = search.match(/\/cards\/([0-9a-f-]{36})/)?.[1];
if (cardId) {
  await check({
    path: `/cards/${cardId}`,
    expect: ["recharts", "Vendors"],
  });
  await check({
    path: `/cards/${cardId}?finish=nonfoil&range=1y`,
    expect: ["recharts"],
  });
} else {
  console.log("  skip /cards/... — no card found to link to");
}

console.log("");
assert.equal(failures, 0, `${failures} page(s) did not render correctly`);
console.log("HTTP smoke test passed.");
