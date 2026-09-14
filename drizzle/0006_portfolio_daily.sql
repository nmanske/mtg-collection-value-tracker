-- Precomputed portfolio totals, one row per date per view.
--
-- The series depends only on the holdings and the price history, both of which
-- change about once a day, yet it was recomputed on every page load: 230ms over
-- 89 dates, 5.6 seconds over 930, and the archive is still adding dates.
--
-- Four views (two price sources x as-held and constant-basket) over ~2,000
-- dates is ~8,000 rows -- smaller than one request used to allocate.
--
-- WITHOUT ROWID for the same reason as the price tables: the row is its key
-- plus a handful of small integers.
CREATE TABLE `portfolio_daily` (
	`price_source` integer NOT NULL,
	`basket` integer NOT NULL,
	`date` text NOT NULL,
	`value_cents` integer NOT NULL,
	`holdings_held` integer NOT NULL,
	`priced_holdings` integer NOT NULL,
	`unpriced_holdings` integer NOT NULL,
	`inferred_holdings` integer NOT NULL,
	`acquired_holdings` integer NOT NULL,
	`acquired_cards` integer NOT NULL,
	PRIMARY KEY(`price_source`, `basket`, `date`)
) WITHOUT ROWID;
