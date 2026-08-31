-- Makes the activity backfill genuinely re-runnable.
--
-- The backfill projects history out of seven existing tables. It will be run
-- more than once — on staging, then on production, then again after somebody
-- widens a source — and a second run must add nothing rather than a second
-- copy of six months of history.
--
-- Deterministic identity rather than a bookkeeping table: a reconstructed row
-- is uniquely identified by where it came from. ON CONFLICT DO NOTHING then
-- makes re-running free, and makes it safe to interrupt a run halfway.
--
-- Partial, because only reconstructed rows carry a source. Live capture has a
-- request id instead and no natural key — two identical actions a second apart
-- really are two events.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_backfill_source
    ON public.tbl_activity_events (
        (metadata ->> 'source_table'),
        (metadata ->> 'source_id')
    )
    WHERE is_reconstructed;

COMMIT;
