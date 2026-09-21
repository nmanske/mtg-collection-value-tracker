-- What the page waiting on a collection should say.
--
-- Two columns rather than one: a percentage alone gives a reader a moving bar
-- and no idea what is moving, and a label alone gives them words with no sense
-- of how far along they are.

ALTER TABLE `collection_sessions` ADD `warm_progress` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `collection_sessions` ADD `warm_step` text;
