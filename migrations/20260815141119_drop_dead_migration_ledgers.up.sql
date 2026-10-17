-- Remove the two abandoned migration ledgers.
--
-- `migrations` (id, name, run_on) is a db-migrate skeleton. `tbl_migrations`
-- (file_name, checksum, status, ...) was homegrown and more ambitious. Both
-- exist in staging and production, both have been empty in both since they were
-- created, and neither ever recorded a single applied migration. They are the
-- residue of two earlier attempts at the problem `pgmigrations` now solves, and
-- leaving them in place invites a future reader to wire something to the wrong one.
--
-- Verified empty in hospitality_stage and hospitality_main immediately before
-- this migration was written. The down migration restores the shapes but not the
-- rows, because there are none.

DROP TABLE IF EXISTS public.tbl_migrations;
DROP TABLE IF EXISTS public.migrations;
