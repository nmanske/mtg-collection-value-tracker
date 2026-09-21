/**
 * Limits the interface has to state, kept free of anything server-side so the
 * forms can quote the same number the importer enforces.
 */

/**
 * Rows accepted from one upload.
 *
 * Rows, not cards: a collection of 50,000 rows holds rather more than 50,000
 * cards, because a row carries a quantity. The distinction matters wherever
 * this number is shown, and "rows" is what the importer counts.
 *
 * Set for serious collectors rather than for the machine. Measured against
 * the real price history: 50,000 distinct printings take 64 seconds to value
 * for one view and about two minutes for a collection with dates, which needs
 * two. That is a long time to watch a bar and no time at all to wait for
 * something in the background, which is where this work now happens — before
 * it moved, the same upload would have frozen the site for every visitor for
 * two minutes, and no limit generous enough to be useful was safe.
 *
 * The cost is linear in distinct printings and the memory is not incidental:
 * the price matrix is one Int32Array of printings x dates, which is 392 MB at
 * this limit. Two workers at once is the reason `WARM_CONCURRENCY` defaults
 * to 2 rather than something larger.
 */
export const MAX_SESSION_ROWS = 50_000;
