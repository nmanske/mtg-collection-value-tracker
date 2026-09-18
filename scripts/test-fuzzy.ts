/**
 * Tests the tolerant card-name matching.
 *
 *   npm run test:fuzzy
 */
import assert from "node:assert/strict";

import {
  boundedDistance,
  closestNames,
  editBudget,
  tokenise,
} from "@/lib/fuzzy";

// --- tokenising ---

assert.deepEqual(tokenise("Lightning Bolt"), ["lightning", "bolt"]);
// Punctuation is a separator, so "Fire // Ice" is two words rather than three
// and the slashes never reach a LIKE pattern.
assert.deepEqual(tokenise("Fire // Ice"), ["fire", "ice"]);
assert.deepEqual(tokenise("Jace, the Mind Sculptor"), [
  "jace",
  "the",
  "mind",
  "sculptor",
]);
assert.deepEqual(tokenise("   "), []);

// --- bounded distance ---

assert.equal(boundedDistance("ring", "ring", 2), 0);
assert.equal(boundedDistance("rng", "ring", 2), 1);
assert.equal(boundedDistance("lightnig", "lightning", 2), 1);
assert.equal(boundedDistance("", "abc", 5), 3);

// Over budget returns max + 1 rather than the true distance: the caller only
// compares against the threshold, and stopping early is the point.
assert.equal(boundedDistance("abcdef", "uvwxyz", 2), 3);
// A length difference alone can exceed the budget, before any comparison.
assert.equal(boundedDistance("a", "abcdefgh", 2), 3);

// --- budgets ---

assert.equal(editBudget("of"), 0, "two letters get no slack");
assert.equal(editBudget("rng"), 1);
assert.equal(editBudget("lightnin"), 2);

// --- matching ---

const NAMES = [
  "Sol Ring",
  "Lightning Bolt",
  "Lightning Greaves",
  "Bolt Bend",
  "Sol Talisman",
  "Jace Beleren",
  "Counterspell",
];

// Word order does not matter.
assert.equal(closestNames(NAMES, "bolt lightning", 5)[0].name, "Lightning Bolt");

// Typos are tolerated.
assert.equal(closestNames(NAMES, "lightnig bolt", 5)[0].name, "Lightning Bolt");
assert.equal(closestNames(NAMES, "sol rng", 5)[0].name, "Sol Ring");

// A prefix counts as exact, so "light" does not have to be spelled out.
assert.equal(closestNames(NAMES, "light bolt", 5)[0].name, "Lightning Bolt");

// EVERY word has to match. "sol counterspell" is not a near miss for either
// card — returning both would bury a real answer under coincidences.
assert.deepEqual(closestNames(NAMES, "sol counterspell", 5), []);

// Nothing close is nothing, not the least-bad guess.
assert.deepEqual(closestNames(NAMES, "zzzzqqq", 5), []);

// Ties break toward the shorter name: an exact match should not rank below a
// longer name that merely contains it.
const bolt = closestNames(NAMES, "bolt", 5);
assert.equal(bolt[0].name, "Bolt Bend");
assert.ok(bolt.some((match) => match.name === "Lightning Bolt"));

// An exact match scores zero, and the limit is honoured.
assert.equal(closestNames(NAMES, "Sol Ring", 5)[0].score, 0);
assert.equal(closestNames(NAMES, "lightning", 1).length, 1);

console.log("Fuzzy tests passed.");
