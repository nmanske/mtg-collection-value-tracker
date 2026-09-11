-- Integer-codes the low-cardinality columns on the two price tables, and drops
-- `vendor_prices.currency` along with the two vendors that made it necessary.
--
-- Written by hand rather than generated. drizzle-kit cannot emit WITHOUT ROWID
-- (see the note on 0000 and 0002) and would not carry the data across, and the
-- codes have to match `src/db/codec.ts` exactly:
--
--   finish  nonfoil=0  foil=1  etched=2
--   vendor  tcgplayer=0  cardkingdom=1
--   side    retail=0  buylist=1
--   source  scryfall=0  mtgjson=1  manual=2
--
-- Motivation is size. The archive backfill takes these tables from ~16 million
-- rows to something near a billion, at which point a row that stores
-- 'cardkingdom', 'nonfoil', 'retail' and 'USD' is mostly repeated string: ~54
-- bytes against ~24 for the coded form. Both hot queries are range scans over
-- the primary key, so halving the row roughly halves their I/O too.
--
-- Rows for vendors that are no longer kept (cardmarket, manapool) are dropped
-- rather than coded. Cardmarket quotes EUR, which nothing here converts, and
-- Manapool has no history before the recent builds.
--
-- Rebuild-and-copy rather than ALTER: SQLite cannot change a column's type in
-- place, and a WITHOUT ROWID table has to be recreated to be rewritten anyway.

PRAGMA foreign_keys = OFF;
--> statement-breakpoint

CREATE TABLE `price_snapshots_new` (
	`printing_key` integer NOT NULL,
	`finish` integer NOT NULL,
	`date` text NOT NULL,
	`price_cents` integer NOT NULL,
	`source` integer NOT NULL,
	`estimated` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`printing_key`, `finish`, `date`),
	FOREIGN KEY (`printing_key`) REFERENCES `printings`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint

INSERT INTO `price_snapshots_new`
	(`printing_key`, `finish`, `date`, `price_cents`, `source`, `estimated`)
SELECT
	`printing_key`,
	CASE `finish` WHEN 'nonfoil' THEN 0 WHEN 'foil' THEN 1 WHEN 'etched' THEN 2 END,
	`date`,
	`price_cents`,
	CASE `source` WHEN 'scryfall' THEN 0 WHEN 'mtgjson' THEN 1 WHEN 'manual' THEN 2 END,
	`estimated`
FROM `price_snapshots`
-- A NULL here would mean a value the codec does not know about, which must
-- fail loudly at the NOT NULL rather than land as a silent 0.
WHERE `finish` IN ('nonfoil', 'foil', 'etched')
  AND `source` IN ('scryfall', 'mtgjson', 'manual');
--> statement-breakpoint

DROP TABLE `price_snapshots`;
--> statement-breakpoint
ALTER TABLE `price_snapshots_new` RENAME TO `price_snapshots`;
--> statement-breakpoint
CREATE INDEX `price_snapshots_date_idx` ON `price_snapshots` (`date`);
--> statement-breakpoint

CREATE TABLE `vendor_prices_new` (
	`printing_key` integer NOT NULL,
	`finish` integer NOT NULL,
	`vendor` integer NOT NULL,
	`side` integer NOT NULL,
	`date` text NOT NULL,
	`price_cents` integer NOT NULL,
	PRIMARY KEY(`printing_key`, `finish`, `vendor`, `side`, `date`),
	FOREIGN KEY (`printing_key`) REFERENCES `printings`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint

-- TCGplayer retail is deliberately not carried over: it duplicates
-- price_snapshots, which at archive scale is ~355 million redundant rows. The
-- vendor queries union the two tables instead.
INSERT INTO `vendor_prices_new`
	(`printing_key`, `finish`, `vendor`, `side`, `date`, `price_cents`)
SELECT
	`printing_key`,
	CASE `finish` WHEN 'nonfoil' THEN 0 WHEN 'foil' THEN 1 WHEN 'etched' THEN 2 END,
	CASE `vendor` WHEN 'tcgplayer' THEN 0 WHEN 'cardkingdom' THEN 1 END,
	CASE `side` WHEN 'retail' THEN 0 WHEN 'buylist' THEN 1 END,
	`date`,
	`price_cents`
FROM `vendor_prices`
WHERE `vendor` IN ('tcgplayer', 'cardkingdom')
  AND `currency` = 'USD'
  AND `finish` IN ('nonfoil', 'foil', 'etched')
  AND `side` IN ('retail', 'buylist')
  AND NOT (`vendor` = 'tcgplayer' AND `side` = 'retail');
--> statement-breakpoint

DROP TABLE `vendor_prices`;
--> statement-breakpoint
ALTER TABLE `vendor_prices_new` RENAME TO `vendor_prices`;
--> statement-breakpoint
CREATE INDEX `vendor_prices_date_idx` ON `vendor_prices` (`date`);
--> statement-breakpoint

-- `holdings.finish` and `unpriced_printings.finish` are coded for the same
-- reason, though neither table is large enough for size to matter: every
-- valuation query joins holdings to price_snapshots on finish, and a text
-- column compared against a coded one matches nothing at all. That failure is
-- silent — the collection simply prices at zero — so the two representations
-- must not be allowed to drift apart.
CREATE TABLE `holdings_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`printing_key` integer NOT NULL,
	`quantity` integer NOT NULL,
	`finish` integer NOT NULL,
	`condition` text NOT NULL,
	`date_added` text NOT NULL,
	`price_override_cents` integer,
	`note` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`printing_key`) REFERENCES `printings`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint

INSERT INTO `holdings_new`
	(`id`, `printing_key`, `quantity`, `finish`, `condition`, `date_added`,
	 `price_override_cents`, `note`, `source`, `created_at`)
SELECT
	`id`, `printing_key`, `quantity`,
	CASE `finish` WHEN 'nonfoil' THEN 0 WHEN 'foil' THEN 1 WHEN 'etched' THEN 2 END,
	`condition`, `date_added`, `price_override_cents`, `note`, `source`, `created_at`
FROM `holdings`
WHERE `finish` IN ('nonfoil', 'foil', 'etched');
--> statement-breakpoint

DROP TABLE `holdings`;
--> statement-breakpoint
ALTER TABLE `holdings_new` RENAME TO `holdings`;
--> statement-breakpoint
CREATE INDEX `holdings_printing_idx` ON `holdings` (`printing_key`);
--> statement-breakpoint
CREATE INDEX `holdings_source_idx` ON `holdings` (`source`);
--> statement-breakpoint
CREATE INDEX `holdings_date_added_idx` ON `holdings` (`date_added`);
--> statement-breakpoint

CREATE TABLE `unpriced_printings_new` (
	`printing_key` integer NOT NULL,
	`finish` integer NOT NULL,
	`reason` text NOT NULL,
	`last_checked_at` integer NOT NULL,
	PRIMARY KEY(`printing_key`, `finish`),
	FOREIGN KEY (`printing_key`) REFERENCES `printings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

INSERT INTO `unpriced_printings_new`
	(`printing_key`, `finish`, `reason`, `last_checked_at`)
SELECT
	`printing_key`,
	CASE `finish` WHEN 'nonfoil' THEN 0 WHEN 'foil' THEN 1 WHEN 'etched' THEN 2 END,
	`reason`, `last_checked_at`
FROM `unpriced_printings`
WHERE `finish` IN ('nonfoil', 'foil', 'etched');
--> statement-breakpoint

DROP TABLE `unpriced_printings`;
--> statement-breakpoint
ALTER TABLE `unpriced_printings_new` RENAME TO `unpriced_printings`;
--> statement-breakpoint

PRAGMA foreign_keys = ON;
