-- Reverses 20261012100000_activity_company_wide_events.sql.
--
-- Company-wide rows (hospitality_company_id IS NULL) cannot exist once the
-- NOT NULL is restored, and an audit trail must not lose rows silently. They
-- are moved, whole, into tbl_activity_events_company_wide_parked rather than
-- deleted; re-applying the up migration puts them back (ON CONFLICT on id) and
-- drops the parking table. While parked they are invisible to the feed, which
-- is the honest state for a schema that cannot hold them.
--
-- The audit triggers dropped here are exactly the four the up migration adds.
-- None of them existed on production before it (verified 2026-10-12), so
-- dropping by name cannot remove a pre-existing trigger.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'tbl_activity_events'
                AND column_name = 'buyer_company_id') THEN
    CREATE TABLE IF NOT EXISTS public.tbl_activity_events_company_wide_parked
      (LIKE public.tbl_activity_events INCLUDING DEFAULTS);

    INSERT INTO public.tbl_activity_events_company_wide_parked
    SELECT * FROM public.tbl_activity_events WHERE hospitality_company_id IS NULL;

    DELETE FROM public.tbl_activity_events WHERE hospitality_company_id IS NULL;
  END IF;
END $$;

DROP TRIGGER IF EXISTS tbl_activity_events_fill_buyer ON public.tbl_activity_events;
DROP FUNCTION IF EXISTS public.activity_fill_buyer_company();

ALTER TABLE public.tbl_activity_events DROP CONSTRAINT IF EXISTS chk_activity_company_scope;
ALTER TABLE public.tbl_activity_events ALTER COLUMN hospitality_company_id SET NOT NULL;
DROP INDEX IF EXISTS public.idx_activity_buyer_company_wide;
ALTER TABLE public.tbl_activity_events DROP CONSTRAINT IF EXISTS fk_activity_buyer_company;
ALTER TABLE public.tbl_activity_events DROP COLUMN IF EXISTS buyer_company_id;

DROP TRIGGER IF EXISTS tbl_company_audit ON public.tbl_company;
DROP TRIGGER IF EXISTS tbl_approval_delegations_audit ON public.tbl_approval_delegations;
DROP TRIGGER IF EXISTS tbl_hospitality_project_mappings_audit ON public.tbl_hospitality_project_mappings;
DROP TRIGGER IF EXISTS tbl_permissions_audit ON public.tbl_permissions;

COMMIT;
