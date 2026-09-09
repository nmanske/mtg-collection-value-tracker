-- NOTE: the WITHOUT ROWID clause on price_snapshots is hand-added.
-- drizzle-kit has no option to emit it, and does not track it in its snapshot,
-- so it survives future `generate` runs but must be re-added by hand if this
-- table is ever recreated. It is load-bearing: this table is nothing but its
-- own key plus three small values, and storing rows in the primary-key B-tree
-- instead of a separate rowid table roughly halves the file at ~13M rows.
CREATE TABLE `holdings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`printing_key` integer NOT NULL,
	`quantity` integer NOT NULL,
	`finish` text NOT NULL,
	`condition` text NOT NULL,
	`date_added` text NOT NULL,
	`price_override_cents` integer,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`printing_key`) REFERENCES `printings`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `holdings_printing_idx` ON `holdings` (`printing_key`);--> statement-breakpoint
CREATE INDEX `holdings_date_added_idx` ON `holdings` (`date_added`);--> statement-breakpoint
CREATE TABLE `mtgjson_ids` (
	`uuid` text PRIMARY KEY NOT NULL,
	`scryfall_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mtgjson_ids_scryfall_idx` ON `mtgjson_ids` (`scryfall_id`);--> statement-breakpoint
CREATE TABLE `price_snapshots` (
	`printing_key` integer NOT NULL,
	`finish` text NOT NULL,
	`date` text NOT NULL,
	`price_cents` integer NOT NULL,
	`source` text NOT NULL,
	`estimated` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`printing_key`, `finish`, `date`),
	FOREIGN KEY (`printing_key`) REFERENCES `printings`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `price_snapshots_date_idx` ON `price_snapshots` (`date`);--> statement-breakpoint
CREATE TABLE `printings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scryfall_id` text NOT NULL,
	`oracle_id` text NOT NULL,
	`name` text NOT NULL,
	`set_code` text NOT NULL,
	`set_name` text NOT NULL,
	`collector_number` text NOT NULL,
	`image_uri` text,
	`finishes` text DEFAULT '["nonfoil"]' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `printings_scryfall_id_unique` ON `printings` (`scryfall_id`);--> statement-breakpoint
CREATE INDEX `printings_name_idx` ON `printings` (`name`);--> statement-breakpoint
CREATE INDEX `printings_set_collector_idx` ON `printings` (`set_code`,`collector_number`);--> statement-breakpoint
CREATE INDEX `printings_oracle_idx` ON `printings` (`oracle_id`);--> statement-breakpoint
CREATE TABLE `sync_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `unpriced_printings` (
	`printing_key` integer NOT NULL,
	`finish` text NOT NULL,
	`reason` text NOT NULL,
	`last_checked_at` integer NOT NULL,
	PRIMARY KEY(`printing_key`, `finish`),
	FOREIGN KEY (`printing_key`) REFERENCES `printings`(`id`) ON UPDATE no action ON DELETE cascade
);
