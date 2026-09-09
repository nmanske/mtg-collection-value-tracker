-- NOTE: WITHOUT ROWID is hand-added, as on price_snapshots. drizzle-kit cannot
-- emit it and does not track it, so it survives future `generate` runs but must
-- be re-added by hand if this table is recreated. This table is nothing but its
-- key plus two small values, so storing rows in the primary-key B-tree rather
-- than a separate rowid table roughly halves it at ~3M rows.
CREATE TABLE `vendor_prices` (
	`printing_key` integer NOT NULL,
	`finish` text NOT NULL,
	`vendor` text NOT NULL,
	`side` text NOT NULL,
	`date` text NOT NULL,
	`price_cents` integer NOT NULL,
	`currency` text NOT NULL,
	PRIMARY KEY(`printing_key`, `finish`, `vendor`, `side`, `date`),
	FOREIGN KEY (`printing_key`) REFERENCES `printings`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `vendor_prices_date_idx` ON `vendor_prices` (`date`);