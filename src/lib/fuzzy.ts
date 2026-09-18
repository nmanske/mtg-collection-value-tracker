/**
 * Tolerant matching for the card search.
 *
 * Two problems, and they want different answers.
 *
 * Word order: nobody types "Lightning Bolt" as reliably as they type "bolt
 * lightning", and a substring match over the whole phrase finds neither. Every
 * word in the query has to appear somewhere in the name, in any order, which
 * SQL can do with one LIKE per word.
 *
 * Typos: "lightnig bolt" is a substring of nothing. That needs an edit
 * distance, which SQL cannot do, so it runs in JavaScript over the 37,379
 * distinct card names — only when the ordinary search found nothing, so the
 * common case never pays for it.
 */

/** Words worth matching on, lowercased. Punctuation is dropped. */
export function tokenise(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Levenshtein distance, abandoned once it cannot come in under `max`.
 *
 * Bounded because the answer is only ever compared against a threshold, and
 * giving up early is what makes 37,000 comparisons cheap: a row whose best
 * possible score already exceeds the budget is not worth finishing.
 */
export function boundedDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowBest = i;

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        current[j - 1] + 1, // insertion
        previous[j] + 1, // deletion
        previous[j - 1] + cost, // substitution
      );
      current.push(value);
      if (value < rowBest) rowBest = value;
    }

    // Every remaining row can only add to the best score on this one.
    if (rowBest > max) return max + 1;
    previous = current;
  }

  return previous[b.length];
}

/**
 * How many edits a word of this length is allowed.
 *
 * Three letters earns one edit, which is what lets "rng" reach "ring". That is
 * loose enough to match "son" from "sol" in isolation, and acceptable because
 * every word in the query has to match *something* and this only runs when the
 * ordinary search already found nothing. Two letters gets no slack at all,
 * where a single edit reaches most of the alphabet.
 */
export function editBudget(token: string): number {
  if (token.length <= 2) return 0;
  if (token.length <= 7) return 1;
  return 2;
}

/** The closest any single word of `name` comes to `token`. */
function bestTokenDistance(nameTokens: string[], token: string): number {
  const budget = editBudget(token);
  let best = budget + 1;

  for (const candidate of nameTokens) {
    // A word the query word is a prefix of counts as exact: someone typing
    // "light" means "Lightning", not a word five edits away from it.
    if (candidate.startsWith(token)) return 0;
    const distance = boundedDistance(token, candidate, budget);
    if (distance < best) best = distance;
    if (best === 0) break;
  }

  return best;
}

export interface FuzzyMatch {
  name: string;
  /** Total edits across the query's words. Lower is closer. */
  score: number;
}

/**
 * Names close enough to `query` to be worth offering, best first.
 *
 * Every word in the query has to find a home in the name. A query whose second
 * word matches nothing is a different card, not a near miss, and returning it
 * would bury the one good answer under a hundred that merely share a word.
 */
export function closestNames(
  names: string[],
  query: string,
  limit: number,
): FuzzyMatch[] {
  const tokens = tokenise(query);
  if (tokens.length === 0) return [];

  const matches: FuzzyMatch[] = [];

  for (const name of names) {
    const nameTokens = tokenise(name);
    let score = 0;
    let ok = true;

    for (const token of tokens) {
      const distance = bestTokenDistance(nameTokens, token);
      if (distance > editBudget(token)) {
        ok = false;
        break;
      }
      score += distance;
    }

    if (ok) matches.push({ name, score });
  }

  // Shorter names first at equal score: "Bolt" before "Bolt of Keranos" for a
  // query that fits both.
  matches.sort(
    (a, b) => a.score - b.score || a.name.length - b.name.length ||
      a.name.localeCompare(b.name),
  );

  return matches.slice(0, limit);
}
