ALTER TABLE `holdings` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
CREATE INDEX `holdings_source_idx` ON `holdings` (`source`);