-- Uploaded collections are priced out of process now, so a session has to say
-- whether that has finished. Derived state would not do: "no cached rows yet"
-- cannot tell a job still running from one that died, and the difference is a
-- page that waits against a page that spins forever.
--
-- Hand-written, as 0007-0010 were; see 0010 for why generate is not used.

ALTER TABLE `collection_sessions` ADD `warm_state` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `collection_sessions` ADD `warm_error` text;
