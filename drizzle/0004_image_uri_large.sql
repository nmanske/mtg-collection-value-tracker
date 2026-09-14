-- A second Scryfall image URL, for the zoomed card view.
--
-- Stored rather than derived: Scryfall documents image URIs as opaque, and the
-- size variants already disagree on file extension, so a string substitution
-- would be relying on a coincidence upstream never promised.
--
-- Null for every existing row until the next `ingest:scryfall` run populates
-- it, which is why readers fall back to `image_uri`. ADD COLUMN is O(1) in
-- SQLite -- no table rewrite -- so this is safe to apply to a large database.
ALTER TABLE `printings` ADD `image_uri_large` text;
