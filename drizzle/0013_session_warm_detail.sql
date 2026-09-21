-- A second line for the waiting page.
--
-- The step says what phase the work is in; this says what it is chewing on
-- right now -- the card whose prices are being read, or how far through the
-- days it has valued. Separate from `warm_step` because the two change at
-- different rates and the page shows them differently.

ALTER TABLE `collection_sessions` ADD `warm_detail` text;
