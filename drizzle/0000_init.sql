CREATE TABLE `holdings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`printing_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`finish` text NOT NULL,
	`condition` text NOT NULL,
	`date_added` text NOT NULL,
	`price_override_cents` integer,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`printing_id`) REFERENCES `printings`(`scryfall_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `holdings_printing_idx` ON `holdings` (`printing_id`);--> statement-breakpoint
CREATE INDEX `holdings_date_added_idx` ON `holdings` (`date_added`);--> statement-breakpoint
CREATE TABLE `price_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`printing_id` text NOT NULL,
	`finish` text NOT NULL,
	`date` text NOT NULL,
	`price_cents` integer NOT NULL,
	`source` text NOT NULL,
	`estimated` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`printing_id`) REFERENCES `printings`(`scryfall_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_snapshots_unique_idx` ON `price_snapshots` (`printing_id`,`finish`,`date`);--> statement-breakpoint
CREATE INDEX `price_snapshots_date_idx` ON `price_snapshots` (`date`);--> statement-breakpoint
CREATE TABLE `printings` (
	`scryfall_id` text PRIMARY KEY NOT NULL,
	`oracle_id` text NOT NULL,
	`name` text NOT NULL,
	`set_code` text NOT NULL,
	`set_name` text NOT NULL,
	`collector_number` text NOT NULL,
	`image_uri` text,
	`finishes` text DEFAULT '["normal"]' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
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
	`printing_id` text PRIMARY KEY NOT NULL,
	`finish` text NOT NULL,
	`reason` text NOT NULL,
	`last_checked_at` integer NOT NULL,
	FOREIGN KEY (`printing_id`) REFERENCES `printings`(`scryfall_id`) ON UPDATE no action ON DELETE cascade
);
