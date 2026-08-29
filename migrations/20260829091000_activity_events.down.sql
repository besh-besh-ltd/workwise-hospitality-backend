-- Reverses 20260829091000_activity_events.
--
-- Drops the trail and everything in it. There is no way to reconstruct these
-- rows afterwards other than re-running the backfill, which can only recover
-- what other tables happened to record. Take a copy first if the contents
-- matter.

BEGIN;
DROP TABLE IF EXISTS public.tbl_activity_events;
COMMIT;
