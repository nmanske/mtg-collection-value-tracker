-- Uploaded collections, scoped to a browser session rather than an account.
--
-- Hand-written, as 0007-0009 were. `drizzle-kit generate` wants to rebuild
-- every table whose definition has drifted from its stale snapshot, which here
-- means copying price_snapshots (215,942,767 rows) and vendor_prices into new
-- tables -- hours of work, double the disk, and it drops WITHOUT ROWID from
-- both. The three statements that are actually needed are below.

CREATE TABLE `collection_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`matched` integer NOT NULL,
	`unmatched` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `collection_sessions_last_seen_idx` ON `collection_sessions` (`last_seen_at`);--> statement-breakpoint

-- '' is the host's own collection, so existing rows keep their meaning.
ALTER TABLE `holdings` ADD `session_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `holdings_session_idx` ON `holdings` (`session_id`);--> statement-breakpoint

-- The two caches take the same column in their primary key. Both are small
-- (a few thousand rows) and entirely derived, so they are rebuilt rather than
-- copied: `npm run cache:portfolio`, or the next daily ingest, refills them.
DROP TABLE `portfolio_daily`;--> statement-breakpoint
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
	`session_id` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`price_source`, `basket`, `date`, `session_id`)
);
--> statement-breakpoint
DROP TABLE `portfolio_monthly`;--> statement-breakpoint
CREATE TABLE `portfolio_monthly` (
	`price_source` integer NOT NULL,
	`month` text NOT NULL,
	`date` text NOT NULL,
	`prev_date` text NOT NULL,
	`from_cents` integer NOT NULL,
	`to_cents` integer NOT NULL,
	`compared` integer NOT NULL,
	`excluded` integer NOT NULL,
	`session_id` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`price_source`, `month`, `session_id`)
);
