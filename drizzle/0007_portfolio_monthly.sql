CREATE TABLE `portfolio_monthly` (
	`price_source` integer NOT NULL,
	`month` text NOT NULL,
	`date` text NOT NULL,
	`prev_date` text NOT NULL,
	`from_cents` integer NOT NULL,
	`to_cents` integer NOT NULL,
	`compared` integer NOT NULL,
	`excluded` integer NOT NULL,
	PRIMARY KEY(`price_source`, `month`)
);
